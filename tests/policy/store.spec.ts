import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import {
  EMPTY_POLICY,
  serializeGlobalPolicy,
} from '../../src/policy/schema.ts'
import { globalPolicyPath, policyLockPath, workspacePolicyPath } from '../../src/policy/paths.ts'
import { PolicyStore, nodePolicyFs, sha256Hex, type PolicyFsLike } from '../../src/policy/store.ts'

/** 内存文件系统替身：把 `Map` 当作磁盘，并记录被抛错模拟的写。 */
function makeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  let throwing = false
  const fs: PolicyFsLike = {
    readFile: async (path) => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    fileExists: async (path) => files.has(path),
    writeFile: async (path, text) => {
      if (throwing) throw new Error('EIO: simulated write failure')
      files.set(path, text)
    },
  }
  return {
    fs,
    files,
    setThrowing: (value: boolean) => {
      throwing = value
    },
  }
}

/** 记账用的锁替身：直接执行，并记下每次锁到的路径。 */
function makeLock() {
  const lockFiles: string[] = []
  const lock = async <T>(file: string, operation: () => Promise<T>): Promise<T> => {
    lockFiles.push(file)
    return await operation()
  }
  return { lock, lockFiles }
}

function makeStore(initial: Record<string, string> = {}) {
  const { fs, files, setThrowing } = makeFs(initial)
  const { lock, lockFiles } = makeLock()
  const warnings: string[] = []
  const store = new PolicyStore({
    fs,
    lock,
    logger: {
      warn: (message) => {
        warnings.push(message)
      },
    },
  })
  return { store, files, setThrowing, lockFiles, warnings }
}

describe('PolicyStore', () => {
  it('returns exists:false and revision:null for a missing file', async () => {
    const { store } = makeStore()
    const r = await store.loadGlobal()
    expect(r).toMatchObject({ exists: false, revision: null })
    expect(r.policy).toEqual(EMPTY_POLICY)
  })

  it('does not overwrite a broken file and reports a warning', async () => {
    const { store, files } = makeStore({ [globalPolicyPath()]: '{ not json' })
    const r = await store.loadGlobal()
    expect(r.warning).toBeTruthy()
    expect(files.get(globalPolicyPath())).toBe('{ not json')
  })

  it('derives revision from a sha256 of the file content', async () => {
    const { store } = makeStore({ [globalPolicyPath()]: serializeGlobalPolicy(EMPTY_POLICY) })
    const r = await store.loadGlobal()
    expect(r.revision).toBe(sha256Hex(serializeGlobalPolicy(EMPTY_POLICY)))
  })

  it('creates a missing file when expected is null', async () => {
    const { store, files } = makeStore()
    const outcome = await store.saveGlobal({ mode: 'blacklist', skills: ['a'], mcps: [] }, null)
    expect(outcome.ok).toBe(true)
    expect(outcome).toMatchObject({ revision: sha256Hex(files.get(globalPolicyPath())!) })
  })

  it('replaces a present file when expected matches the current revision', async () => {
    const { store, files } = makeStore({ [globalPolicyPath()]: serializeGlobalPolicy(EMPTY_POLICY) })
    const first = await store.loadGlobal()
    const outcome = await store.saveGlobal({ mode: 'blacklist', skills: ['a'], mcps: [] }, first.revision)
    expect(outcome.ok).toBe(true)
    expect(files.get(globalPolicyPath())).toContain('"a"')
  })

  it('rejects a save whose expected revision does not match', async () => {
    const { store } = makeStore({ [globalPolicyPath()]: serializeGlobalPolicy(EMPTY_POLICY) })
    const again = await store.saveGlobal({ mode: 'blacklist', skills: ['b'], mcps: [] }, 'stale-version')
    expect(again).toEqual({ ok: false, code: 'stale-revision', message: expect.any(String) })
  })

  it('rejects a null-expected save when the file already exists', async () => {
    const { store } = makeStore({ [globalPolicyPath()]: serializeGlobalPolicy(EMPTY_POLICY) })
    const again = await store.saveGlobal(EMPTY_POLICY, null)
    expect(again).toEqual({ ok: false, code: 'stale-revision', message: expect.any(String) })
  })

  it('runs every save inside the file lock, passing the policy path itself', async () => {
    const { store, lockFiles } = makeStore()
    await store.saveGlobal(EMPTY_POLICY, null)
    // 传给 withFileLock 的必须是**策略文件路径**：库自己拼 `${filename}.lock`
    // （appendix: `dsh-atomic-write/lib/index.js:189`）。若传 `policyLockPath(...)`
    // （已带 `.lock`），锁名会变成 `*.lock.lock` —— 实测报错信息里出现过。
    expect(lockFiles.at(-1)).toBe(globalPolicyPath())
    expect(lockFiles.at(-1)).not.toBe(policyLockPath(globalPolicyPath()))
  })

  it('serializes concurrent saves through one queue', async () => {
    const { store } = makeStore()
    const [a, b] = await Promise.all([
      store.saveGlobal({ mode: 'blacklist', skills: ['a'], mcps: [] }, null),
      store.saveGlobal({ mode: 'blacklist', skills: ['b'], mcps: [] }, 'stale-version'),
    ])
    expect(a.ok).toBe(true)
    expect(b).toEqual({ ok: false, code: 'stale-revision', message: expect.any(String) })
  })

  it('reports write-failed and preserves the file when the write throws', async () => {
    const { store, files, setThrowing } = makeStore({ [globalPolicyPath()]: serializeGlobalPolicy(EMPTY_POLICY) })
    setThrowing(true)
    const before = files.get(globalPolicyPath())
    expect(await store.saveGlobal(EMPTY_POLICY, sha256Hex(before!))).toEqual({
      ok: false,
      code: 'write-failed',
      message: expect.any(String),
    })
    expect(files.get(globalPolicyPath())).toBe(before)
  })
})

/**
 * 真实文件系统上的回归测试。
 *
 * 内存替身 `PolicyFsLike` 不经过 `withFileLock`，**无法复现**这个缺陷：
 * 缺陷发生在 `withFileLock` 用 `wx` 建锁文件时（父目录不存在 → ENOENT），
 * 而替身的 `makeLock()` 只是记录路径然后直接调用回调。
 * 因此这一组必须走真实的 `$DSH_HOME` 解析路径与真实的原子写/文件锁。
 *
 * 实测缺陷原文：
 * `写入策略文件失败：/Users/go/.dsh/skill-scope/global.json：
 *  Error: ENOENT: no such file or directory, open
 *  '/Users/go/.dsh/skill-scope/global.json.lock.lock'`
 * 两个原因叠加：① 锁不会建父目录；② 锁名被多拼了一次 `.lock`。
 *
 * **重定向手法**：不往 `PolicyStore` 注入路径（`StoreDeps` 里没有这个字段，
 * 也不该为一个测试加宽生产接口），而是改 `process.env.DSH_HOME`——
 * `dshHomePath()` 每次调用都走 `resolveDshHome()` 现读 `$DSH_HOME`
 * （`dsh-home-paths/lib/index.js:109,132-133`），所以改环境变量即可生效。
 */
describe('真实文件系统：全局策略目录不存在时也能写入（回归）', () => {
  let home: string
  let previousHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-sm-store-'))
    previousHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = home
  })

  afterEach(async () => {
    if (previousHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previousHome
    await rm(home, { recursive: true, force: true })
  })

  it('creates the missing parent directory and succeeds on the first global save', async () => {
    const target = globalPolicyPath()
    // 前置断言：`$DSH_HOME/skill-scope/` 必须不存在——这正是线上首写的情形。
    expect(existsSync(dirname(target))).toBe(false)

    const store = new PolicyStore({ fs: nodePolicyFs, logger: { warn: () => {} } })

    const outcome = await store.saveGlobal({ mode: 'blacklist', skills: ['b', 'a'], mcps: [] }, null)
    expect(outcome.ok).toBe(true)
    // 目录被建出来了，文件真的落盘。
    expect(existsSync(target)).toBe(true)
    // 落盘形状是**扁平**的 `{mode,skills,mcps}`（`serializeGlobalPolicy` → `toRows`，
    // 没有 `.default` 包装——那是工作区文件才有的层名）；名字去重并升序（`SORTED_UNIQUE`）。
    const written = JSON.parse(await readFile(target, 'utf8'))
    expect(written).toEqual({ mode: 'blacklist', skills: ['a', 'b'], mcps: [] })
  })
})

describe('工作区策略', () => {
  // 工作区用例必须用**真实存在**的 cwd：`saveWorkspace` 内部会调
  // `ensureParentDir`（真实 `mkdir`，不走注入的 fs 替身），把 cwd 写成
  // `/Users/go/proj/demo` 这类固定路径时，只有在作者本机恰好存在才通过，
  // 换到 CI 的干净 runner 就 `EACCES`。用 `mkdtemp` 造一次性目录，
  // 平台无关且彼此隔离。
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'dsh-sm-ws-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('loads from the workspace path and reports it', async () => {
    // 落盘上的 `whitelist` 是被删除的历史取值：读取时归一到 `blacklist`，
    // 名单原样保留。这条用例现在同时是「废弃模式迁移」的回归守卫。
    const { store } = makeStore({
      [workspacePolicyPath(cwd)]: '{"default":{"mode":"whitelist","skills":["a"],"mcps":[]}}',
    })
    const r = await store.loadWorkspace(cwd)
    expect(r.path).toBe(workspacePolicyPath(cwd))
    expect(r.policy).toEqual({ mode: 'blacklist', skills: ['a'], mcps: [] })
  })

  it('keeps unknown top-level keys when saving the workspace policy', async () => {
    const { store, files } = makeStore({
      [workspacePolicyPath(cwd)]: '{"note":"keep me","default":{"mode":"default","skills":[],"mcps":[]}}',
    })
    const loaded = await store.loadWorkspace(cwd)
    const outcome = await store.saveWorkspace(cwd, { mode: 'blacklist', skills: ['a'], mcps: [] }, loaded.revision)
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(files.get(workspacePolicyPath(cwd))!).note).toBe('keep me')
  })
})
