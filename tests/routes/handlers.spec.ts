import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMPTY_POLICY } from '../../src/policy/schema.ts'
import { PolicyStore, type PolicyFsLike } from '../../src/policy/store.ts'
import { globalPolicyPath, workspacePolicyPath } from '../../src/policy/paths.ts'
import { AgentStates, reground, type AgentLike } from '../../src/agent/state.ts'
import type { EffectivePolicy } from '../../src/policy/evaluate.ts'
import {
  handleGlobal,
  handleGlobalSave,
  handleWorkspace,
  handleWorkspaceSave,
  type RouteDeps,
} from '../../src/routes/handlers.ts'
import { makeFakeCtx } from '../support/fake-ctx.ts'
import type { PluginContextLike } from '../../src/routes/session.ts'
import { registerRoutes, type FetchRegisterFace, type FetchRouteSpec } from '../../src/routes/register.ts'

/**
 * 一个**真实存在**的工作区目录。
 *
 * `handleWorkspaceSave` → `store.saveWorkspace` → `ensureParentDir`（`src/policy/store.ts:66`）
 * 会走**真实 `mkdir`**，它不受本文件注入的 `fs` 替身控制。因此凡是「保存成功」的用例，
 * cwd 必须是磁盘上真实可写的目录：写死 `/Users/go/proj/demo` 只在作者本机恰好存在时通过，
 * 换到 CI 的干净 runner 就 `EACCES`（实测 Linux 上 `/Users` 需 root 才能创建）。
 *
 * 用 `mkdtemp` 造一次性目录：平台无关、可写、用例之间彼此隔离。
 */
async function makeRealCwd(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-sm-routes-'))
}

/** 内存文件系统替身：与 tests/policy/store.spec.ts 同形，用真实 PolicyStore 跑路由逻辑。 */
function makeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const fs: PolicyFsLike = {
    readFile: async (path) => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    fileExists: async (path) => files.has(path),
    writeFile: async (path, text) => {
      files.set(path, text)
    },
  }
  return { fs, files }
}

/** 一个 live agent（`agents.get` 的返回值）。 */
function makeAgent(id: string, cwd: string): AgentLike {
  return { id, ctx: { get: () => undefined }, session: { id, header: { cwd } } }
}

function makeDeps(options: {
  agent?: AgentLike
  skills?: Array<{ name: string; modelInvocable?: boolean; provider?: string; path?: string }>
  tools?: string[]
  /**
   * 被本工作区关闭（= 已被 shadow 遮蔽）的 skill 名。真实宿主里这些名字在
   * **agent 作用域**的快照中消失（`src/agent/skills.ts` 的 `applySkillShadow` 把它们
   * 注册成 `modelInvocable:false` 的副本，而 agent 层的活清单不含隐藏项），
   * 但**全局作用域**的快照里仍在。替身必须复现这个差异，否则「补回被遮蔽项」
   * 这条修复在测试里根本无从触发 —— 这正是原缺陷躲过测试的原因。
   */
  hiddenIn?: string[]
} = {}) {
  const { fs, files } = makeFs()
  const warnings: string[] = []
  /**
   * 每次 `reapplyAfterSave` 调用的记账。保存路由**必须**调用它一次——
   * 这是「同一会话内改策略立即生效」的唯一来源（策略写入不发 `skills/change`）。
   */
  const reapplyCalls: number[] = []
  const store = new PolicyStore({
    fs,
    // 测试用锁替身：直接执行（真实 withFileLock 会真的去建 .lock 文件）。
    lock: async (_file, operation) => await operation(),
    logger: { warn: (message) => warnings.push(message) },
  })
  const states = new AgentStates()
  // 无 agent 时的占位 cwd。**刻意用一个不存在的路径**：这些用例不落在保存路径上，
  // 一旦将来有谁在无 agent 的 deps 上触发保存，就应该立刻炸，而不是静默依赖
  // 作者本机恰好存在某个目录（那正是本轮 CI 失败的成因）。
  const knownCwd = options.agent?.session.header?.cwd ?? '/nonexistent/dsh-test/no-agent'
  // ctx 只提供 sessionQuery / agents：handleWorkspace 走的是真实解析路径。
  // `observeSession` 必须对**未知 sessionId 抛错**——这是宿主行为，也是 unknown-session 的来源；
  // 若它无条件成功，用例 3/6 就永远测不出 unknown-session。
  const ctx = makeFakeCtx({
    sessionQuery: {
      observeSession: (id: string) => {
        if (options.agent === undefined || options.agent.id !== id) {
          throw new Error(`ENOENT: unknown session ${id}`)
        }
        return {
          header: { cwd: knownCwd },
          projections: { values: { agentPreset: 'standard' } },
          dispose: () => {},
        }
      },
    },
    // 只有当前会话有 live agent：`agents.get('nope')` 必须返回 undefined。
    agents: { get: (id: string) => (options.agent?.id === id ? options.agent : undefined) },
  })
  // `modelInvocable` 默认 true（与宿主 `dsh-skill` 的缺省一致），需要造不可调用条目时显式传 false。
  // 刻意保留「不传该字段」的能力：过滤器用 `modelInvocable !== false`，
  // 字段缺失必须被视为可调用，这条断言由下面的专项用例守住。
  const skills = (options.skills ?? []).map((row) => ({
    name: row.name,
    description: '',
    source: 'custom',
    // provider 缺省 `filesystem`（磁盘 skill 的常态）；造插件 skill 时显式传包名。
    provider: row.provider ?? 'filesystem',
    ...(row.path === undefined ? {} : { path: row.path }),
    ...(row.modelInvocable === undefined ? {} : { invocation: { modelInvocable: row.modelInvocable } }),
  }))
  const tools = (options.tools ?? []).map((name) => ({ name }))
  // `hiddenIn` 里的名字在 **agent 作用域**的快照里表现为「已遮蔽」。全局快照仍列全部 ——
  // 复现宿主里「关闭即遮蔽」导致的两层清单差异（`readGlobalSkills` 与 `readAgentSkills` 的分野）。
  //
  // **真实语义（必须如实复现，别简化）**：遮蔽**不删名字**，只把 `invocation.modelInvocable`
  // 置 false —— `dsh-skill` 的 `snapshot()` 走 `collect()`，而 `collect()` 只按**名字**去重，
  // 同名副本会**覆盖**元数据却不会让名字消失（`dsh-skill` 的 `collect()`）。
  // 早期替身让它「从清单消失」，那会掩盖按 `modelInvocable` 判读的逻辑错误。
  const hidden = new Set(options.hiddenIn ?? [])
  const deps: RouteDeps = {
    store,
    states,
    skills: {
      snapshot: async (snapshotOptions: { scope?: unknown } = {}) => ({
        skills:
          snapshotOptions.scope === undefined
            ? skills
            : skills.map((row) =>
                hidden.has(row.name)
                  ? { ...row, invocation: { ...(row.invocation ?? {}), modelInvocable: false } }
                  : row,
              ),
        complete: true,
      }),
    },
    tools: {
      schemas: () => tools,
      view: () => ({ restrictableNames: new Set(tools.map((tool) => tool.name)) }),
    },
    loaderServers: async () => [],
    logger: { warn: (message) => warnings.push(message) },
    ctx: ctx as unknown as PluginContextLike,
    reapplyAfterSave: async () => {
      reapplyCalls.push(1)
    },
  }
  return { deps, files, warnings, states, store, reapplyCalls }
}

/**
 * 造一个「会话可解析但**没有** live Agent」的 ctx：`observeSession` 正常成功，
 * `agents.get` 一律返回 undefined。这是设计 6.3 的「非实时」分支，必须能独立测到。
 */
function ctxWithoutAgent(_base: PluginContextLike, id: string, cwd: string): PluginContextLike {
  return makeFakeCtx({
    sessionQuery: {
      observeSession: () => ({
        header: { cwd },
        projections: { values: { agentPreset: 'standard' } },
        dispose: () => {},
      }),
    },
    agents: { get: (requested: string) => (requested === id ? undefined : undefined) },
  }) as unknown as PluginContextLike
}

/** 与 `makeDeps` 同一个 ctx 一起返回（`registerRoutes` 需要 ctx + deps 两者）。 */
function makeDepsWithCtx(options: { agent?: AgentLike; tools?: string[]; hiddenIn?: string[] } = {}) {
  // 同样用不存在的占位路径：调用方只测注册面/只读路由，不落在保存路径上。
  const agent = options.agent ?? makeAgent('s1', '/nonexistent/dsh-test/no-agent')
  const built = makeDeps({ agent, tools: options.tools, hiddenIn: options.hiddenIn })
  return { ...built, ctx: built.deps.ctx }
}

describe('handleGlobal', () => {
  it('returns the global policy, revision and inventory', async () => {
    const { deps } = makeDeps()
    expect(await handleGlobal({}, deps)).toEqual({
      ok: true,
      value: {
        policy: EMPTY_POLICY,
        revision: null,
        inventory: { skills: expect.any(Array), mcps: expect.any(Array) },
      },
    })
  })

  it('answers a session-scoped read the same way as an unscoped one', async () => {
    const agent = makeAgent('s1', '/nonexistent/dsh-test/global-read')
    const { deps, states } = makeDeps({ agent })
    const state = states.ensure(agent)
    const empty: EffectivePolicy = { global: EMPTY_POLICY, workspace: null }
    reground(state, empty)

    // `sessionId` 只影响工作区层求值，全局层返回体与是否有 state 条目无关。
    expect(await handleGlobal({ sessionId: 's1' }, deps)).toMatchObject({ ok: true })
    expect(await handleGlobal({ sessionId: 'ghost' }, deps)).toMatchObject({ ok: true })
  })

  it('classifies the MCP inventory from the live tool view', async () => {
    const { deps } = makeDeps({ tools: ['mcp__gbrain__search'] })
    const out = await handleGlobal({}, deps)
    expect(out).toMatchObject({
      ok: true,
      value: { inventory: { mcps: [{ serverName: 'gbrain', toolCount: 1, restrictable: true, loaded: true }] } },
    })
  })

  it('treats a rejecting loaderServers as an empty list and warns', async () => {
    const { deps, warnings } = makeDeps()
    const failing: RouteDeps = {
      ...deps,
      loaderServers: async () => {
        throw new Error('ENOENT: loader registry unreadable')
      },
    }
    const out = await handleGlobal({}, failing)
    expect(out.ok).toBe(true)
    // 断言真实消息片段（「loader server 列表」），不假设实现用的 Identifier 名。
    expect(warnings.some((message) => message.includes('loader server'))).toBe(true)
  })

  it('never lets an exception escape: a failing store becomes internal', async () => {
    const { deps } = makeDeps()
    const broken: RouteDeps = {
      ...deps,
      store: {
        ...deps.store,
        loadGlobal: async () => {
          throw new Error('EIO: disk on fire')
        },
      } as unknown as PolicyStore,
    }
    expect(await handleGlobal({}, broken)).toEqual({
      ok: false,
      error: { code: 'internal', message: expect.any(String) },
    })
  })
})

describe('handleGlobalSave', () => {
  it('rejects a bad body with bad-request and names the offending field', async () => {
    const { deps } = makeDeps()
    const out = await handleGlobalSave({ mode: 'blacklist', skills: ['Bad Name'], mcps: [] }, deps)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toMatchObject({ code: 'bad-request' })
      expect(out.error.message).toContain('Bad Name')
    }
  })

  it('maps a stale revision to stale-revision', async () => {
    const { deps } = makeDeps()
    expect(
      await handleGlobalSave({ mode: 'blacklist', skills: [], mcps: [], revision: 'stale-version-token' }, deps),
    ).toEqual({ ok: false, error: { code: 'stale-revision', message: expect.any(String) } })
  })

  it('round-trips a create, then accepts the returned revision and rejects a superseded one', async () => {
    const { deps, files } = makeDeps()
    const created = await handleGlobalSave({ mode: 'blacklist', skills: ['a'], mcps: [], revision: null }, deps)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    // revision 是宿主侧 sha256(content) 的十六进制串，固定 64 字符。
    expect(created.value.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(files.get(globalPolicyPath())).toContain('"a"')
    const firstRevision = created.value.revision

    // 拿**刚返回的** revision 再存一次是合法更新：它恰好等于当前文件内容。
    // 必须复用同一个 deps —— 换一个 store 就看不到上一次的写入。
    const second = await handleGlobalSave({ mode: 'default', skills: [], mcps: [], revision: firstRevision }, deps)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.revision).not.toBe(firstRevision)

    // 而**第一次那个** revision 现在已经过期（文件被第二次写入改过）⇒ 竞态守卫必须拒绝。
    expect(await handleGlobalSave({ mode: 'blacklist', skills: [], mcps: [], revision: firstRevision }, deps)).toEqual({
      ok: false,
      error: { code: 'stale-revision', message: expect.any(String) },
    })
  })

  it('rejects a create when the file already exists', async () => {
    // `revision: null` 的语义是「我期望还没有文件」；文件已存在时必须拒绝创建。
    const { deps } = makeDeps()
    await handleGlobalSave({ mode: 'blacklist', skills: ['a'], mcps: [], revision: null }, deps)
    expect(await handleGlobalSave({ mode: 'default', skills: [], mcps: [], revision: null }, deps)).toEqual({
      ok: false,
      error: { code: 'stale-revision', message: expect.any(String) },
    })
  })

  it('treats a missing revision as "expect no file yet"', async () => {
    const { deps } = makeDeps()
    const created = await handleGlobalSave({ mode: 'default', skills: [], mcps: [] }, deps)
    expect(created.ok).toBe(true)
  })

  it('reads the current policy on every call instead of caching a snapshot', async () => {
    const { deps } = makeDeps()
    await handleGlobalSave({ mode: 'blacklist', skills: ['a'], mcps: [], revision: null }, deps)
    // 另一次读必须看到刚写入的内容：handler 不做任何跨请求缓存。
    expect(await handleGlobal({}, deps)).toMatchObject({
      ok: true,
      value: { policy: { mode: 'blacklist', skills: ['a'] } },
    })
  })

  /**
   * 全局层同样是「保存即重新落地」——全局策略是**硬上限**，它一改，所有存活会话的
   * 可见面都要跟着收窄/放开。与工作区层同理：写入不发注册表事件，必须显式触发。
   */
  it('reapplies the policy after a successful global save', async () => {
    const { deps, reapplyCalls } = makeDeps()
    const out = await handleGlobalSave({ mode: 'blacklist', skills: ['a'], mcps: [], revision: null }, deps)
    expect(out.ok).toBe(true)
    expect(reapplyCalls).toHaveLength(1)
  })

  it('does not reapply when the global save is rejected', async () => {
    const { deps, reapplyCalls } = makeDeps()
    const out = await handleGlobalSave(
      { mode: 'blacklist', skills: ['Not A Valid Name'], mcps: [], revision: null },
      deps,
    )
    expect(out.ok).toBe(false)
    expect(reapplyCalls).toHaveLength(0)
  })
})

describe('handleWorkspace', () => {
  // 只读用例：cwd 只作为字符串在断言之间流转，不需要真实目录。
  // 但仍避免写死作者本机的路径——换个名字即可，语义一样。
  const cwd = '/nonexistent/dsh-test/workspace-read'

  it('rejects an unknown session with unknown-session', async () => {
    const { deps } = makeDeps()
    expect(await handleWorkspace({ sessionId: 'nope' }, deps)).toEqual({
      ok: false,
      error: { code: 'unknown-session', message: expect.any(String) },
    })
  })

  it('marks a workspace read with no live agent as live:false and still returns a policy', async () => {
    // 「会话可解析但没有 live Agent」：`observeSession` 成功、`agents.get` 返回 undefined。
    const agent = makeAgent('s1', cwd)
    const { deps } = makeDeps({ agent })
    const orphan: RouteDeps = { ...deps, ctx: ctxWithoutAgent(deps.ctx, 's1', cwd) }
    const out = await handleWorkspace({ sessionId: 's1' }, orphan)
    expect(out).toMatchObject({ ok: true, value: { live: false, exists: false, cwd } })
    if (out.ok) {
      expect(out.value.policy).toEqual(EMPTY_POLICY)
      expect(out.value.policyPath).toBe(workspacePolicyPath(cwd))
    }
  })

  it('prefers the live agent scoped inventory and reports live:true', async () => {
    const agent = makeAgent('s1', cwd)
    const { deps, states } = makeDeps({ agent, skills: [{ name: 'global-only' }] })
    states.ensure(agent)
    const scoped: RouteDeps = {
      ...deps,
      skills: {
        snapshot: async () => ({
          skills: [{ name: 'agent-only', description: '', source: 'filesystem', invocation: { modelInvocable: true } }],
          complete: true,
        }),
      },
    }
    const out = await handleWorkspace({ sessionId: 's1' }, scoped)
    expect(out).toMatchObject({ ok: true, value: { live: true } })
    if (out.ok) expect(out.value.inventory.skills.map((row) => row.name)).toEqual(['agent-only'])
  })

  it('sends the real source label for each skill, not the opaque `source` bucket', async () => {
    /*
     * 用户诉求：`source` 显示的 `custom` 对用户没有信息量，来源应写明**插件名**
     * 或**磁盘路径**。服务端在 `withGroups` 里算好 `sourceLabel`：
     * - 插件 skill（provider 非内置）→ 插件名；
     * - 磁盘 skill（provider `filesystem`）→ 注册根绝对路径；
     * - runtime 注入 → `null`（无磁盘出处，前端换文案）。
     *
     * **这条用例钉住「服务端确实填了这个字段」**：只测 `sourceLabelOf` 不够——
     * 忘了在 `withGroups` 里接线时，纯函数用例照样绿，面板却仍显示 `custom`。
     */
    const { deps } = makeDeps({
      skills: [
        { name: 'brainstorming', provider: 'superpowers-dsh', path: '/r/node_modules/superpowers-dsh/skills/brainstorming/SKILL.md' },
        { name: 'academic-verify', provider: 'filesystem', path: '/r/gbrain/skills/academic-verify' },
      ],
    })
    const out = await handleGlobal({}, deps)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const byName = new Map(out.value.inventory.skills.map((row) => [row.name, row]))
    expect(byName.get('brainstorming')?.sourceLabel).toBe('superpowers-dsh')
    expect(byName.get('academic-verify')?.sourceLabel).toBe('/r/gbrain/skills')
    // 顺带钉住：`source` 字段本身仍在（策略求值/其他消费方在用它），
    // 只是 UI 不再拿它当「来源」显示。
    expect(byName.get('academic-verify')?.source).toBe('custom')
  })

  it('sends a null source label for a runtime-injected skill', async () => {
    const { deps } = makeDeps({ skills: [{ name: 'browser-skill', provider: 'runtime' }] })
    const out = await handleGlobal({}, deps)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // `null`（而不是 `undefined`）：JSON 里字段一定出现，前端据此判断「无出处」。
    expect(out.value.inventory.skills[0]?.sourceLabel).toBeNull()
  })
})

describe('handleWorkspaceSave', () => {
  // 这个块的用例会真正走到 `ensureParentDir` 的真实 `mkdir`，cwd 必须是真目录。
  let cwd: string
  beforeEach(async () => {
    cwd = await makeRealCwd()
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('writes the workspace file', async () => {
    const agent = makeAgent('s1', cwd)
    const { deps, files } = makeDeps({ agent })
    const out = await handleWorkspaceSave(
      { sessionId: 's1', mode: 'blacklist', skills: ['a'], mcps: [], revision: null },
      deps,
    )
    expect(out).toMatchObject({ ok: true, value: { cwd, exists: true, live: true } })
    if (out.ok) expect(out.value.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(files.get(workspacePolicyPath(cwd))).toContain('"blacklist"')
  })

  it('reports live:false on a save for a session with no live agent', async () => {
    const agent = makeAgent('s1', cwd)
    const { deps } = makeDeps({ agent })
    const orphan: RouteDeps = { ...deps, ctx: ctxWithoutAgent(deps.ctx, 's1', cwd) }
    expect(
      await handleWorkspaceSave(
        { sessionId: 's1', mode: 'blacklist', skills: ['a'], mcps: [], revision: null },
        orphan,
      ),
    ).toMatchObject({ ok: true, value: { live: false, exists: true } })
  })

  it('rejects a workspace save for an unknown session', async () => {
    const { deps } = makeDeps()
    expect(await handleWorkspaceSave({ sessionId: 'nope', mode: 'default', skills: [], mcps: [] }, deps)).toEqual({
      ok: false,
      error: { code: 'unknown-session', message: expect.any(String) },
    })
  })

  /**
   * 承重回归（用户实测缺陷）：保存成功后**必须**触发一次重新落地。
   *
   * 背景：策略写入走 `fs.writeFile`，既不发 `skills/change` 也不发 `tools/change`
   * （那两个事件只由 Skill/Tool 注册表的变化触发）。缺了这条显式调用，用户在**同一会话**里
   * 启用一个 skill 后，该会话要等到新建会话才看得到——这正是用户报的病症。
   * 若有人删掉 `deps.reapplyAfterSave()`，这条用例立刻失败。
   */
  it('reapplies the policy after a successful workspace save', async () => {
    const agent = makeAgent('s1', cwd)
    const { deps, reapplyCalls } = makeDeps({ agent })
    const out = await handleWorkspaceSave(
      { sessionId: 's1', mode: 'blacklist', skills: ['a'], mcps: [], revision: null },
      deps,
    )
    expect(out.ok).toBe(true)
    expect(reapplyCalls).toHaveLength(1)
  })

  it('does not reapply when the workspace save is rejected', async () => {
    const agent = makeAgent('s1', cwd)
    const { deps, reapplyCalls } = makeDeps({ agent })
    const out = await handleWorkspaceSave(
      // 非法名字：`validatePolicyInput` 直接拒绝，不应走到重新落地。
      { sessionId: 's1', mode: 'blacklist', skills: ['Not A Valid Name'], mcps: [], revision: null },
      deps,
    )
    expect(out.ok).toBe(false)
    expect(reapplyCalls).toHaveLength(0)
  })
})

describe('registerRoutes', () => {
  // 嵌套的 `workspace inventory` 块里有「保存成功」的用例，同样会走真实 `mkdir`。
  let cwd: string
  beforeEach(async () => {
    cwd = await makeRealCwd()
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  /** 记录注册面的替身，同时能观察 disposer 是否被调用。 */
  function makeRegister() {
    const specs: FetchRouteSpec[] = []
    let disposed = 0
    const face = {
      register: (spec: FetchRouteSpec) => {
        specs.push(spec)
        return () => {
          disposed += 1
        }
      },
    }
    return { face, specs, disposedCount: () => disposed }
  }

  it('registers exactly four POST-only buffered routes under /api/skill-scope/', () => {
    const { deps, ctx } = makeDepsWithCtx()
    const register = makeRegister()
    registerRoutes(ctx, deps, register.face)
    expect(register.specs.map((spec) => spec.path)).toEqual([
      '/api/skill-scope/global',
      '/api/skill-scope/global/save',
      '/api/skill-scope/workspace',
      '/api/skill-scope/workspace/save',
    ])
    // 只声明 POST（非 POST 由宿主落到 404，不实现 405），且请求体走 buffered。
    for (const spec of register.specs) {
      expect(spec.methods).toEqual(['POST'])
      expect(spec.requestBody).toBe('buffered')
    }
  })

  it('answers with the envelope and a no-store cache header', async () => {
    const { deps, ctx } = makeDepsWithCtx()
    const register = makeRegister()
    registerRoutes(ctx, deps, register.face)
    const globalSpec = register.specs[0]
    expect(globalSpec).toBeDefined()
    if (globalSpec === undefined) return
    const response = await globalSpec.fetch(
      new Request('http://localhost/api/skill-scope/global', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )
    // HTTP 200 + 信封：非 2xx 会让客户端丢弃 error.code（见 register.ts 的 toResponse 注释）。
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      ok: true,
      value: { policy: EMPTY_POLICY, revision: null },
    })
  })

  it('folds a handler exception into an internal envelope instead of throwing', async () => {
    const { deps, ctx } = makeDepsWithCtx()
    const register = makeRegister()
    const broken: RouteDeps = {
      ...deps,
      store: { ...deps.store, loadGlobal: async () => { throw new Error('EIO') } } as unknown as PolicyStore,
    }
    registerRoutes(ctx, broken, register.face)
    const globalSpec = register.specs[0]
    if (globalSpec === undefined) return
    const response = await globalSpec.fetch(
      new Request('http://localhost/api/skill-scope/global', { method: 'POST', body: '{}' }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('tolerates a malformed body by treating it as empty', async () => {
    const { deps, ctx } = makeDepsWithCtx()
    const register = makeRegister()
    registerRoutes(ctx, deps, register.face)
    const globalSpec = register.specs[0]
    if (globalSpec === undefined) return
    const response = await globalSpec.fetch(
      new Request('http://localhost/api/skill-scope/global', { method: 'POST', body: 'not json' }),
    )
    expect(await response.json()).toMatchObject({ ok: true })
  })

  it('releases every registration on dispose', () => {
    const { deps, ctx } = makeDepsWithCtx()
    const register = makeRegister()
    const dispose = registerRoutes(ctx, deps, register.face)
    dispose()
    expect(register.disposedCount()).toBe(4)
  })

  it('does nothing and warns when no fetch face is available', () => {
    const { deps, ctx } = makeDepsWithCtx()
    const dispose = registerRoutes(ctx, deps, undefined as unknown as FetchRegisterFace)
    expect(() => dispose()).not.toThrow()
  })

  /**
   * `modelInvocable === false` 的 skill 在工作区面板上**照样列出**。
   *
   * 历史（2026-10-13 前）：这里曾断言工作区层滤掉它们，依据是一张「61 条」的参考截图。
   * 该断言现已删除，因为它的机制被证伪：那个 61 是**全局策略当时的产物**，而
   * 「滤掉 `modelInvocable === false`」在实践中造成了真实缺陷 —— 本插件遮蔽一个 skill
   * 的手段就是给它注册 `modelInvocable:false` 的副本，于是**用户每关闭一项，
   * 这一项就被自己创建的过滤器吃掉**，从面板上消失且再也打不开
   * （实测 `/Users/go/proj/chat`：黑名单 56 项，面板只剩 2 项）。
   *
   * 现在两条路由都只做「全局未关闭 ∩（可见 ∪ 本工作区已关闭）」，不看 `modelInvocable`。
   */
  describe('workspace inventory does not filter on modelInvocable', () => {
    it('lists a non-invocable skill in the workspace inventory too', async () => {
      const { deps } = makeDeps({
        agent: makeAgent('session-live', cwd),
        skills: [
          { name: 'invocable-one', modelInvocable: true },
          { name: 'user-only', modelInvocable: false },
          { name: 'invocable-two', modelInvocable: true },
        ],
      })
      const out = await handleWorkspace({ sessionId: 'session-live' }, deps)
      if (!out.ok) throw new Error('expected ok')
      // 顺序即宿主顺序；`modelInvocable` 只影响行上的标签，不影响入选。
      expect(out.value.inventory.skills.map((row) => row.name)).toEqual([
        'invocable-one',
        'user-only',
        'invocable-two',
      ])
    })

    /**
     * **两层规则不同一**（用户明确要求）：全局层列宿主全部 Skill，工作区层才收窄。
     *
     * 理由：全局层是**决定开关的地方**。若在全局层隐藏 `modelInvocable === false` 的条目，
     * 用户就再也找不到入口把它们重新打开（实测有 80 项因此失去入口）。
     */
    it('lists non-invocable skills in the global inventory (global layer is the place to re-enable them)', async () => {
      const { deps } = makeDeps({
        skills: [
          { name: 'invocable-one', modelInvocable: true },
          { name: 'user-only', modelInvocable: false },
        ],
      })
      const out = await handleGlobal({}, deps)
      if (!out.ok) throw new Error('expected ok')
      expect(out.value.inventory.skills.map((row) => row.name)).toEqual(['invocable-one', 'user-only'])
    })

    /**
     * 判定必须是 `!== false` 而不是 `=== true`：宿主里该字段**缺失**代表「未特别声明」，
     * 而 `dsh-skill` 的缺省是「可调用」。用 `=== true` 会把全部未声明该字段的 skill 误杀。
     */
    it('treats a missing modelInvocable field as invocable, not as hidden', async () => {
      const { deps } = makeDeps({ skills: [{ name: 'undeclared' }] })
      const out = await handleGlobal({}, deps)
      if (!out.ok) throw new Error('expected ok')
      expect(out.value.inventory.skills.map((row) => row.name)).toEqual(['undeclared'])
    })

    /**
     * `handleWorkspaceSave` 保存后**回读**清单并把它当下一轮的 UI 数据返回。
     * 这条回读路径必须与 `handleWorkspace` 走**同一个** `composeWorkspaceSkills`：
     * 口径一旦分叉，用户保存一次就会看到清单跳成另一种形状。
     *
     * 守卫的是**工作区侧两条路由口径一致**这个不变量（对同一份宿主清单必须给出同一个名单）。
     * `handleGlobal` **不在**这条不变量里：它按用户要求列全部 Skill。
     *
     * 清单内容由「全局层是硬上限」与「补回本工作区已关闭项」两组的用例覆盖；
     * 本用例只盯**两条路由一致**这一件事。
     */
    it('applies the same composition on the save read-back path as on the workspace read path', async () => {
      const agent = makeAgent('s1', cwd)
      const skills = [
        { name: 'invocable-one', modelInvocable: true },
        { name: 'user-only', modelInvocable: false },
      ]
      const { deps } = makeDeps({ agent, skills })

      const saved = await handleWorkspaceSave(
        { sessionId: 's1', mode: 'blacklist', skills: ['invocable-one'], mcps: [], revision: null },
        deps,
      )
      const read = await handleWorkspace({ sessionId: 's1' }, deps)
      const global = await handleGlobal({}, deps)
      if (!saved.ok || !read.ok || !global.ok) throw new Error('expected ok')

      // 工作区两条路由必须逐字相同（`user-only` 不再被 `modelInvocable` 过滤掉）。
      const readNames = read.value.inventory.skills.map((row) => row.name)
      expect(saved.value.inventory.skills.map((row) => row.name)).toEqual(readNames)
      expect(readNames).toEqual(['invocable-one', 'user-only'])
      // 既然两条路由现在共用 `buildWorkspaceView`，整个返回体都应当相等——
      // 不只是 skill 名字。`revision` 例外：读取路由读到的 revision 是保存后落盘的值，
      // 保存路由回读的也是同一个值，所以这里连它一起比，能同时钉住「读取路由不是在
      // 保存前采集的快照」。
      expect(saved.value).toEqual(read.value)
      // 全局层列出全部 Skill。
      expect(global.value.inventory.skills.map((row) => row.name)).toEqual(['invocable-one', 'user-only'])
    })
  })

  /**
   * 回归防护（用户实测缺陷，2026-10-13）：**本工作区已关闭的项必须在面板上可见**。
   *
   * 缺陷形态：`/Users/go/proj/chat` 的工作区黑名单有 56 项，面板只列出 2 项
   * （brainstorming、lark-doc）。用户的原话是「我的开关怎么都消失了」——
   * 他关掉的项从面板上消失，于是既看不到、也**无法再打开**。
   *
   * 机制（两条误伤叠加）：
   * 1. 起点错：工作区路由用 `readAgentSkills`（agent 作用域的**活**清单）当候选集。
   *    而「关闭一个 skill」的实现手段**就是**把它遮蔽（`src/agent/skills.ts` 注册
   *    `modelInvocable:false` 的副本）——被关闭的项在活清单里**本来就不存在**。
   * 2. 二次误伤：在被遮蔽项已经缺席的情况下，又套一层 `invocableOnly` 过滤。
   *
   * 修复口径：输出 = **全局未关闭** ∩（**Agent 可见** ∪ **本工作区已关闭**）。
   * 后半项从**全局清单**取回行数据（描述、来源、分组），因为活清单里已经没有它们了。
   */
  describe('a workspace-closed skill stays visible so the user can reopen it', () => {
    it('restores a workspace-blacklisted skill that has vanished from the agent scope', async () => {
      const agent = makeAgent('session-live', cwd)
      const { deps } = makeDeps({
        agent,
        skills: [{ name: 'kept' }, { name: 'closed-here' }],
        hiddenIn: ['closed-here'],
      })
      await handleWorkspaceSave(
        { sessionId: 'session-live', mode: 'blacklist', skills: ['closed-here'], mcps: [], revision: null },
        deps,
      )

      const out = await handleWorkspace({ sessionId: 'session-live' }, deps)
      if (!out.ok) throw new Error('expected ok')
      // 两项都要在：`kept` 本来就可见，`closed-here` 被遮蔽后必须被补回。
      expect(out.value.inventory.skills.map((row) => row.name)).toEqual(['kept', 'closed-here'])
    })

    /**
     * 全局硬上限优先于「补回」：全局已关闭的项**不**因它同时出现在工作区黑名单里
     * 而被补回。两层名单都能命中一个名字时，全局层说了算（工作区只能收窄）。
     */
    it('does not restore a skill that is also closed globally', async () => {
      const agent = makeAgent('session-live', cwd)
      const { deps } = makeDeps({
        agent,
        skills: [{ name: 'kept' }, { name: 'closed-both' }],
        hiddenIn: ['closed-both'],
      })
      await handleGlobalSave(
        { mode: 'blacklist', skills: ['closed-both'], mcps: [], revision: null },
        deps,
      )
      await handleWorkspaceSave(
        { sessionId: 'session-live', mode: 'blacklist', skills: ['closed-both'], mcps: [], revision: null },
        deps,
      )

      const out = await handleWorkspace({ sessionId: 'session-live' }, deps)
      if (!out.ok) throw new Error('expected ok')
      expect(out.value.inventory.skills.map((row) => row.name)).toEqual(['kept'])
      expect(out.value.disabledGlobally).toContain('closed-both')
    })

    /**
     * **不可被模型调用**的项也必须列出来。
     *
     * 这是本插件历史缺陷的正面钉子：面板一度按 `modelInvocable` 过滤，于是
     * 「本工作区关闭、全局放行」的项（遮蔽后 `mi=false`）**完全消失**，用户既看不见
     * 也没入口打开。口径：`disable-model-invocation: true` 也要列出，
     * 状态用行内文案「不可被模型调用」区分。
     *
     * 注意替身此刻必须让该行**带 `modelInvocable: false`**，否则「再套一层
     * `invocableOnly` 过滤」这类回归不会失败 —— 旧替身行里没有 `invocation` 字段，
     * 过滤是 no-op，实测确实抓不到。
     */
    it('lists a skill the model cannot invoke instead of filtering it out', async () => {
      const agent = makeAgent('session-live', cwd)
      const { deps } = makeDeps({
        agent,
        skills: [{ name: 'kept' }, { name: 'closed-here', modelInvocable: true }],
        hiddenIn: ['closed-here'],
      })
      await handleWorkspaceSave(
        { sessionId: 'session-live', mode: 'blacklist', skills: ['closed-here'], mcps: [], revision: null },
        deps,
      )

      const out = await handleWorkspace({ sessionId: 'session-live' }, deps)
      if (!out.ok) throw new Error('expected ok')
      // 补回的那一行取自**全局清单**，其 `mi` 是原值（true）；两行都必须在。
      expect(out.value.inventory.skills.map((row) => row.name)).toEqual(['kept', 'closed-here'])
    })

    /**
     * 真实形态的钉子：`disable-model-invocation: true` 的 skill（全局行本身就 `mi=false`）
     * 出现在工作区清单里时**不得**被过滤掉。
     *
     * 与上一条的区别：上一条的 `mi=false` 是**遮蔽**造成的（全局行 `mi=true`），
     * 这一条的 `mi=false` 是**作者标记**造成的（全局行本身就是 false）—— 两者都
     * 必须列出。若有人把 `invocableOnly` 加回 `composeWorkspaceSkills`，
     * 这一条会立刻失败。
     */
    it('keeps a skill marked disable-model-invocation in the workspace inventory', async () => {
      const agent = makeAgent('session-live', cwd)
      const { deps } = makeDeps({
        agent,
        skills: [{ name: 'kept' }, { name: 'human-only', modelInvocable: false }],
      })

      const out = await handleWorkspace({ sessionId: 'session-live' }, deps)
      if (!out.ok) throw new Error('expected ok')
      const names = out.value.inventory.skills.map((row) => row.name)
      expect(names).toEqual(['kept', 'human-only'])
      // 状态靠行内标记区分，不靠「列不列出来」。
      const row = out.value.inventory.skills.find((item) => item.name === 'human-only')
      // `SkillRow` 已把 `invocation.modelInvocable` 摊平成布尔字段（`src/inventory/skills.ts:122`）。
      expect(row?.modelInvocable).toBe(false)
    })

    /**
     * 名字已被删除（全局清单里也没有）时**不**补空壳行：
     * 没有行数据就渲染不出描述与来源，硬塞只会给用户一个点不动的开关。
     */
    it('skips a workspace-blacklisted name that no longer exists anywhere', async () => {
      const agent = makeAgent('session-live', cwd)
      const { deps } = makeDeps({
        agent,
        skills: [{ name: 'kept' }],
        hiddenIn: ['ghost'],
      })
      await handleWorkspaceSave(
        { sessionId: 'session-live', mode: 'blacklist', skills: ['kept', 'ghost'], mcps: [], revision: null },
        deps,
      )

      const out = await handleWorkspace({ sessionId: 'session-live' }, deps)
      if (!out.ok) throw new Error('expected ok')
      // `kept` 被本工作区关闭且仍存在于全局清单 ⇒ 补回；`ghost` 无处可取 ⇒ 跳过。
      expect(out.value.inventory.skills.map((row) => row.name)).toEqual(['kept'])
    })
  })

  /**
   * 全局层是**硬上限**（设计 `docs/design.md` §1.2）。
   *
   * 回归防护（用户实测缺陷）：曾经 `handleWorkspace` 直接返回作用域清单，**不减全局黑名单**，
   * 表现为「全局关闭了大部分 skill，工作区面板还是能看到全部」。实测 61 项里有 59 项已被
   * 全局关闭却照常显示，且 `disabledGlobally` / `inherited` 两个字段整个缺失。
   *
   * 用户对呈现方式的选择：全局已关闭的项在工作区**完全不显示**（不折叠、不列只读名单），
   * 只留一句计数。所以这里断言的是「不在清单里」而不是「在某个只读区里」。
   */
  describe('global layer is a hard ceiling for the workspace', () => {
    it('removes globally blacklisted skills from the workspace inventory', async () => {
      const agent = makeAgent('session-live', cwd)
      const { deps } = makeDeps({
        agent,
        skills: [{ name: 'kept' }, { name: 'closed-globally' }, { name: 'also-kept' }],
      })
      await handleGlobalSave(
        { mode: 'blacklist', skills: ['closed-globally'], mcps: [], revision: null },
        deps,
      )

      const out = await handleWorkspace({ sessionId: 'session-live' }, deps)
      if (!out.ok) throw new Error('expected ok')
      expect(out.value.inventory.skills.map((row) => row.name)).toEqual(['kept', 'also-kept'])
      expect(out.value.disabledGlobally).toEqual(['closed-globally'])
    })

    it('removes globally blacklisted mcps and reports them in disabledGlobally', async () => {
      const agent = makeAgent('session-live', cwd)
      const { deps } = makeDeps({ agent, tools: ['mcp__gbrain__search', 'mcp__other__ping'] })
      await handleGlobalSave({ mode: 'blacklist', skills: [], mcps: ['gbrain'], revision: null }, deps)

      const out = await handleWorkspace({ sessionId: 'session-live' }, deps)
      if (!out.ok) throw new Error('expected ok')
      expect(out.value.inventory.mcps.map((row) => row.serverName)).not.toContain('gbrain')
      expect(out.value.disabledGlobally).toContain('gbrain')
    })

    /**
     * `inherited.total` 必须等于**实际列给用户的**继承项数。
     * 若在摘除前统计，UI 会显示「继承自全局：2 项」而列表里只有 1 行。
     */
    it('counts inherited totals after the global removals', async () => {
      const agent = makeAgent('session-live', cwd)
      const { deps } = makeDeps({ agent, tools: ['mcp__gbrain__search', 'mcp__other__ping'] })
      await handleGlobalSave({ mode: 'blacklist', skills: [], mcps: ['gbrain'], revision: null }, deps)

      const out = await handleWorkspace({ sessionId: 'session-live' }, deps)
      if (!out.ok) throw new Error('expected ok')
      const fromGlobal = out.value.inventory.mcps.filter((row) => row.source === 'global')
      expect(out.value.inherited?.total).toBe(fromGlobal.length)
      expect(out.value.inherited?.disabledGlobally).toBe(1)
    })

    /**
     * 白名单删除前的行为：`whitelist` 下无法枚举「未出现的名字」，所以
     * `closedByGlobal` 只能返回空集合，工作区层面因此看不到任何继承的隐藏项。
     *
     * 删除白名单后这条缺口**已闭合**：名单永远可枚举，「全局关了哪些」有确切答案。
     * 本用例因此翻转为它的反面——同样的输入（名单里只有 `listed`）现在读作
     * 「listed 被全局关闭」，工作区层面必须如实摘除它，而不是整份清单照旧可见。
     */
    it('hides exactly the globally listed names (the un-enumerable gap is closed)', async () => {
      const agent = makeAgent('session-live', cwd)
      const { deps } = makeDeps({ agent, skills: [{ name: 'listed' }, { name: 'not-listed' }] })
      await handleGlobalSave({ mode: 'blacklist', skills: ['listed'], mcps: [], revision: null }, deps)

      const out = await handleWorkspace({ sessionId: 'session-live' }, deps)
      if (!out.ok) throw new Error('expected ok')
      expect(out.value.inventory.skills.map((row) => row.name)).toEqual(['not-listed'])
      expect(out.value.disabledGlobally).toEqual(['listed'])
    })
  })
})
