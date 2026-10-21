import { createHash } from 'node:crypto'
import { readFile as readFileNode, access, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import {
  EMPTY_POLICY,
  parseGlobalPolicy,
  serializeGlobalPolicy,
  type LayerPolicy,
} from './schema.ts'
import {
  EMPTY_WORKSPACE_POLICY,
  parseWorkspacePolicy,
  serializeWorkspacePolicy,
  type WorkspacePolicy,
} from './workspace-schema.ts'
import { globalPolicyPath, workspacePolicyPath } from './paths.ts'

/**
 * 策略文件的最小文件系统面（设计 3.6）。
 * 默认实现是宿主侧 `node:fs/promises`——**刻意不经过 `ctx.fs`**：
 * `ctx.fs` 的围栏按目标路径判定，而 `$DSH_HOME` 永远不在可写根内（见 `docs/dsh-runtime-facts.md` §1）。
 * 注入替身让本模块可以纯内存测试。
 */
export interface PolicyFsLike {
  readFile(path: string): Promise<string>
  fileExists(path: string): Promise<boolean>
  /** 原子覆盖写。默认实现走 `writeFileAtomic`；替身只需落盘。 */
  writeFile(path: string, text: string): Promise<void>
}

/**
 * 宿主侧默认实现。
 * 写用 `writeFileAtomic(path, text, { mode: 0o600, dirMode: 0o700 })`：
 * 随机后缀兄弟文件 + `rename` 提交，读者只见完整旧版或完整新版，且新建目录权限收敛。
 */
export const nodePolicyFs: PolicyFsLike = {
  async readFile(path) {
    return await readFileNode(path, 'utf8')
  },
  async fileExists(path) {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  },
  async writeFile(path, text) {
    await writeFileAtomic(path, text, { mode: 0o600, dirMode: 0o700 })
  },
}

/** 稳定 revision：文件内容的 sha256 十六进制（设计 3.5）。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 建出某个文件所在目录（递归，权限 `0o700`）。
 *
 * 为什么需要它：`withFileLock` 用 `wx` 直接建锁文件，**不会建父目录**
 * （`dsh-atomic-write/lib/index.js:182` 文档写明父目录必须已存在）。
 * 首次写全局策略时 `$DSH_HOME/skill-scope/` 还不存在，锁会先失败。
 * `writeFileAtomic` 虽然自己会 mkdir，但那要等到拿锁之后才执行，救不了锁。
 *
 * 目录权限 `0o700` 与 `dirMode` 一致：策略文件只对本用户可读。
 * 父目录已存在时 `mkdir` 的 `recursive: true` 是幂等的，不会改已有权限。
 */
async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
}

/** 读结果：`revision` 为 `null` 表示文件不存在。 */
export interface LoadResult {
  policy: LayerPolicy
  revision: string | null
  exists: boolean
  warning?: string
}

/**
 * 工作区层的读结果。与 `LoadResult` **分开定义**：工作区层存的不是 `LayerPolicy`，
 * 而是逐项绝对状态（`名字 → 布尔`），两者不能互相赋值。
 */
export interface WorkspaceLoadResult {
  policy: WorkspacePolicy
  revision: string | null
  exists: boolean
  path: string
  warning?: string
}

/** 写结果（设计 3.5）。失败码只有 `stale-revision` 与 `write-failed` 两种。 */
export type SaveOutcome =
  | { ok: true; revision: string }
  | { ok: false; code: 'stale-revision' | 'write-failed'; message: string }

/** 锁函数签名（默认 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock`）。 */
export type LockLike = <T>(file: string, operation: () => Promise<T>) => Promise<T>

interface StoreDeps {
  fs?: PolicyFsLike
  lock?: LockLike
  logger: { warn(message: string): void }
}

/**
 * 策略文件存取（设计 3.5 / 3.6）。
 *
 * 读侧不加锁：`writeFileAtomic` 的 rename 提交是原子的，读者看到的一定是完整的旧版或新版。
 * 写侧把「读 → 校验 → 写」整体放进文件锁，进程内再叠一条按路径的 promise 队列，
 * 保证同进程 FIFO、跨进程互斥。
 */
export class PolicyStore {
  private readonly fs: PolicyFsLike
  private readonly lock: LockLike
  private readonly logger: { warn(message: string): void }
  /** 按路径串行化的队列尾。每个写入者的 promise 接在上一个之后。 */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(deps: StoreDeps) {
    this.fs = deps.fs ?? nodePolicyFs
    this.lock = deps.lock ?? ((file, operation) => withFileLock(file, operation))
    this.logger = deps.logger
  }

  async loadGlobal(): Promise<LoadResult> {
    const path = globalPolicyPath()
    const text = await this.readText(path)
    if (text === null) return { policy: EMPTY_POLICY, revision: null, exists: false }
    const { policy, warning } = parseGlobalPolicy(text)
    return { policy, revision: sha256Hex(text), exists: true, ...(warning === undefined ? {} : { warning }) }
  }

  async saveGlobal(policy: LayerPolicy, expected: string | null | undefined): Promise<SaveOutcome> {
    const path = globalPolicyPath()
    return await this.write(path, expected, () => serializeGlobalPolicy(policy))
  }

  /**
   * 只改全局层的**展示开关**（`showOfficialSkills`），两份名单保持磁盘上的现值。
   *
   * 为什么不能复用 `saveGlobal`：工作区面板也展示这个开关，但它拿不到全局文件的
   * revision（两个文件各有一把乐观锁），而把面板手里的**旧名单**回写全局会覆盖掉
   * 别人刚做的名单改动。所以在锁内「读—改—写」：只动这一个键，名单原样保留。
   *
   * 没有 revision 守卫是**有意**的：调用方没有可用的期望值。并发写仍被同一把文件锁
   * 串行化，因此不会出现「读到旧内容再写回去」的窗口。
   */
  async setGlobalShowOfficialSkills(next: boolean): Promise<SaveOutcome> {
    const path = globalPolicyPath()
    return await this.write(
      path,
      null,
      (currentText) => {
        const current = currentText === null ? EMPTY_POLICY : parseGlobalPolicy(currentText).policy
        return serializeGlobalPolicy({ ...current, showOfficialSkills: next })
      },
      // 跳过 revision 守卫：这是「只改一个键」的局部更新，不要求调用方持有版本。
      false,
    )
  }

  async loadWorkspace(cwd: string): Promise<WorkspaceLoadResult> {
    const path = workspacePolicyPath(cwd)
    const text = await this.readText(path)
    if (text === null) return { policy: EMPTY_WORKSPACE_POLICY, revision: null, exists: false, path }
    const { policy, warning } = parseWorkspacePolicy(text)
    return { policy, revision: sha256Hex(text), exists: true, path, ...(warning === undefined ? {} : { warning }) }
  }

  /**
   * 保存工作区策略。
   *
   * 写盘要按全局状态剔除「同向条目」（见设计 3.3 写盘规则），所以**必须**拿到全局策略。
   * 它在本文件的锁**内部**读取：若在进锁前读，全局策略可能在两者之间变化，筛掉一条
   * 本来已经异向的条目——那会静默改变用户的配置语义。全局文件的读侧无锁（原子 rename），
   * 这里不会嵌套同一把锁。
   */
  async saveWorkspace(
    cwd: string,
    policy: WorkspacePolicy,
    expected: string | null | undefined,
  ): Promise<SaveOutcome> {
    const path = workspacePolicyPath(cwd)
    return await this.write(path, expected, async (current) => {
      const global = await this.loadGlobal()
      return serializeWorkspacePolicy(policy, current ?? undefined, global.policy)
    })
  }

  /** 读全文；文件不存在返回 `null`。读侧无锁，见类注释。 */
  private async readText(path: string): Promise<string | null> {
    if (!(await this.fs.fileExists(path))) return null
    try {
      return await this.fs.readFile(path)
    } catch (error) {
      this.logger.warn(`dsh-skill-scope: 读取策略文件失败（按不存在处理）：${path}：${String(error)}`)
      return null
    }
  }

  /**
   * 一次完整的写事务：入队列 → 进文件锁 → 读现状 → revision 守卫 → 序列化 → 原子写。
   * `serialize` 拿到锁内读到的旧全文（工作区层用它保住未知顶层键）。
   */
  private async write(
    path: string,
    expected: string | null | undefined,
    serialize: (currentText: string | null) => string | Promise<string>,
    guard = true,
  ): Promise<SaveOutcome> {
    const previous = this.queues.get(path) ?? Promise.resolve()
    // 队列尾只用来**串行化**，不传递结果：下一个写入者无条件接在上一个之后，
    // 无论它是成功还是失败（失败由各自的 `next` 返回给调用方）。
    const next = previous.then(() => this.writeLocked(path, expected, serialize, guard))
    this.queues.set(
      path,
      next.catch(() => {}),
    )
    return await next
  }

  private async writeLocked(
    path: string,
    expected: string | null | undefined,
    serialize: (currentText: string | null) => string | Promise<string>,
    guard: boolean,
  ): Promise<SaveOutcome> {
    try {
      // 先确保父目录存在：`withFileLock` 用 `writeFile(lockPath, …)` 加 `wx` 建锁，
      // **它不建父目录**（`dsh-atomic-write/lib/index.js:182` 文档明写
      // "The parent directory must exist."）。而 `writeFileAtomic` 自己会 mkdir
      // （`:62`），所以只在「首次写全局策略」时暴露：目录还不存在 → 锁先炸，
      // 报 `ENOENT ... open '.../global.json.lock.lock'`。
      await ensureParentDir(path)
      // **把策略文件路径交给 withFileLock**：库自己拼 `${filename}.lock`。
      // 早期实现传的是 `policyLockPath(path)`（已带 `.lock`），锁名成了
      // `*.lock.lock`，两个缺陷叠加成同一个报错。
      return await this.lock(path, async (): Promise<SaveOutcome> => {
        const current = await this.readText(path)
        const currentRevision = current === null ? null : sha256Hex(current)

        // revision 守卫（D1/D2）：`expected == null` 只允许创建新文件；
        // 非空 expected 必须与现状逐一匹配，否则说明别人已经改过。
        // `guard === false` 只用于「锁内读—改—写单个键」的局部更新（见
        // `setGlobalShowOfficialSkills`）：它不覆盖名单，因此不需要版本依据。
        if (guard) {
          if (expected === null || expected === undefined) {
            if (currentRevision !== null) {
              return {
                ok: false,
                code: 'stale-revision',
                message: '策略文件已存在，但本次保存没有携带 revision；请重新加载后再保存',
              }
            }
          } else if (currentRevision !== expected) {
            return {
              ok: false,
              code: 'stale-revision',
              message: `策略文件已被其他写者修改（期望 revision ${expected}，当前 ${currentRevision ?? '不存在'}）；请重新加载后再保存`,
            }
          }
        }

        const text = await serialize(current)
        await this.fs.writeFile(path, text)
        return { ok: true, revision: sha256Hex(text) }
      })
    } catch (error) {
      // 不改动原文件：`writeFileAtomic` 自身承诺原子替换，抛错时目标保持旧内容。
      return { ok: false, code: 'write-failed', message: `写入策略文件失败：${path}：${String(error)}` }
    }
  }
}
