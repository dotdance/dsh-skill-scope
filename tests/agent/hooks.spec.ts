import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { installAgentHooks, type HookDeps } from '../../src/agent/hooks.ts'
import { AgentStates, type AgentLike } from '../../src/agent/state.ts'
import { EMPTY_POLICY, type LayerPolicy } from '../../src/policy/schema.ts'
import { EMPTY_WORKSPACE_POLICY, type WorkspacePolicy } from '../../src/policy/workspace-schema.ts'
import type { LoadResult, SaveOutcome, WorkspaceLoadResult } from '../../src/policy/store.ts'
import type { SkillsServiceLike } from '../../src/inventory/skills.ts'
import type { McpToolFace } from '../../src/inventory/mcp.ts'
import { emit as emitEvent, makeFakeCtx, type FakeContext } from '../support/fake-ctx.ts'

/**
 * 事件接线与 Host 入口。
 *
 * 这些用例直接调用注册到假 ctx 上的监听器，因此不发真请求、不碰真文件系统。
 * 覆盖的不变量：12（无 connection）、15（卸载不留残留）、17（创建时落地、绝不抛错）、
 * 18（回合边界：保存后重新落地）、19/23（清单变化差分重算，策略每次重读）。
 */

/**
 * 宿主发来的 agent **负载对象**（真实里是 `ReactLoopAgent` 实体）。
 *
 * 刻意**不实现 `AgentLike`**（不带 `raw`）：它模拟的是宿主交给监听器的那个原始对象。
 * 监听器一律经 `asAgentLike(payload.agent)` 重包，重包结果才是 `state.agent`，
 * 其 `raw` 指回**这个**对象。
 *
 * 这样安排是为了让「复验必须用宿主本体当 scope」这条契约可测：替身的 `snapshot`
 * 只认这个对象（`hostScope`），传 `asAgentLike` 造出的替身则读不到 agent 层。
 * 若让替身自己再带一层 `raw`，`asAgentLike(替身).raw` 就成了替身而非本体，
 * 契约反而测不出来 —— 本次真根因正是这样躲过全部用例的。
 */
function makeHostAgent(id: string, cwd: string, services: Record<string, unknown>) {
  return {
    id,
    ctx: { get: (serviceName: string) => services[serviceName] },
    session: { id, header: { cwd } },
  }
}

/** 监听器负载用的宿主实体；`asAgentLike` 会把它重包成 `AgentLike`。 */
function makeAgent(id: string, cwd: string, services: Record<string, unknown>): AgentLike {
  return makeHostAgent(id, cwd, services) as unknown as AgentLike
}

/**
 * 一个可用的 skill 服务替身：`snapshot` 按调用参数返回不同清单。
 *
 * 两点必须与真实宿主一致，否则测试会骗人：
 * ① **作用域按对象身份**。`dsh-scope` 的层索引全按对象身份（`peek(scope)` 走
 *    `this.scoped.get(scope)`；`scopeChainOf` 走 `scopeParents` WeakMap）。传一个字段
 *    相同但 `!==` 本体的替身，查不到 agent 层 ⇒ 退化成只读全局层 ⇒ 遮蔽读不回来。
 *    替身若忽略 `scope` 恒返回同一结果，这个真根因在单测里就**不可观测**。
 *    `hostScope` 就是那个本体；缺省 `undefined` 时退化为「传了 scope 就读 agent 层」。
 * ② **遮蔽不删名字**，只把 `invocation.modelInvocable` 置 false（`dsh-skill` 的
 *    `collect()` 只按名字去重）。替身若让名字消失，就会放过「用名字存在性当判据」的错误。
 */
function makeSkills(options: {
  global: string[]
  agent: string[]
  complete?: boolean
  /** 宿主 agent 对象本体；只有 `scope === hostScope` 才读得到 agent 层。 */
  hostScope?: unknown
  /** 已被成功遮蔽的名字：仍在清单里，但 `modelInvocable` 为 false。 */
  shadowed?: Set<string>
  /** 记录每次 `snapshot` 的实参，供用例断言生产调用点传了什么。 */
  verifyCalls?: Array<{ cwd?: string; scope?: unknown }>
  /**
   * 这些名字带**官方路径**（`.../@deepseek-ai/.../SKILL.md`）。
   * 用来钉住「掩蔽集用全量清单」：官方行在展示口径下会被过滤，但求值时必须在场。
   */
  officialPaths?: readonly string[]
}): SkillsServiceLike {
  return {
    snapshot: async (call: { cwd?: string; scope?: unknown }) => {
      options.verifyCalls?.push({ cwd: call.cwd, scope: call.scope })
      // 读 agent 层需同时满足：带了 scope，且（若约定了本体）scope 就是那个本体。
      const readingAgentLayer =
        call.scope !== undefined && (options.hostScope === undefined || call.scope === options.hostScope)
      const names = readingAgentLayer ? options.agent : options.global
      return {
        skills: names.map((name) => ({
          name,
          description: '',
          source: 'bundled',
          // 遮蔽**不删名字**，只把 `modelInvocable` 置 false（`dsh-skill` 的 `collect()`
          // 只按名字去重）。替身若让名字消失，就会放过「用名字存在性当判据」这类错误。
          invocation: { modelInvocable: !(readingAgentLayer && options.shadowed?.has(name) === true) },
          // 官方行的路径形态（`@deepseek-ai` 作用域）必须与真实宿主一致，
          // 否则「演示口径过滤」与「求值口径全量」的差异在替身里不可观测。
          ...(options.officialPaths?.includes(name) === true
            ? { path: `/home/user/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-agent-preset/skills/${name}/SKILL.md` }
            : {}),
        })),
        complete: options.complete ?? true,
      }
    },
  } as unknown as SkillsServiceLike
}

/** 一个策略 store 替身：内存态，可注入失败。 */
function makeStore(state: { global: LayerPolicy; workspace: WorkspacePolicy | null; fail?: boolean }) {
  return {
    loadGlobal: async (): Promise<LoadResult> => {
      if (state.fail === true) throw new Error('store exploded')
      return { policy: state.global, revision: 'r-g', exists: true }
    },
    loadWorkspace: async (): Promise<WorkspaceLoadResult> => {
      if (state.fail === true) throw new Error('store exploded')
      return {
        policy: state.workspace ?? EMPTY_WORKSPACE_POLICY,
        revision: state.workspace === null ? null : 'r-w',
        exists: state.workspace !== null,
        path: '/proj/.dsh-scope.json',
      }
    },
    saveGlobal: async (): Promise<SaveOutcome> => ({ ok: true, revision: 'r-g' }),
    saveWorkspace: async (): Promise<SaveOutcome> => ({ ok: true, revision: 'r-w' }),
  }
}

/** 一个「完整」的 skill 定义：shadow 必须原样复制它，只改 invocation。 */
function fullDefinition(name: string): Record<string, unknown> {
  return {
    name,
    description: 'd',
    content: 'body',
    path: `/skills/${name}`,
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

/** 组装一套 HookDeps 与它的可观测替身。 */
function makeHarness(options: {
  global?: LayerPolicy
  workspace?: WorkspacePolicy | null
  globalSkills?: string[]
  agentSkills?: string[]
  complete?: boolean
  toolNames?: string[]
  /**
   * 让 `restrict` 交出的 disposer 在被调用时抛错。
   *
   * 真实成因：`release()` 会同步 emit `tools/change`，第三方监听器可能炸。用它可以钉住
   * 「`applyRound` 把 `onReleaseError` 接上了没有」——只测 `mcp.ts` 自己的可选回调
   * 证明不了接线存在（删掉 `hooks.ts` 那三行，旧全量仍是 418/418 全绿）。
   */
  rejectRestrictRelease?: boolean
  /** 这些名字在清单里带官方路径（`@deepseek-ai` 作用域），见 `makeSkills`。 */
  officialPaths?: readonly string[]
} = {}) {
  const services: Record<string, unknown> = {}
  const agent = makeAgent('a1', '/proj', services)
  const state = {
    global: options.global ?? EMPTY_POLICY,
    workspace: options.workspace ?? null,
    fail: false,
  }
  const store = makeStore(state)

  const shadowCalls: string[] = []
  const registerScopes: unknown[] = []
  /** 已被成功遮蔽的名字：仍在快照清单里，只是 `modelInvocable` 变 false。 */
  const shadowed = new Set<string>()
  /** 被「别的插件」抢先注册、导致我们的注册被同层先到先得**静默丢弃**的名字。 */
  const rejectedShadowNames = new Set<string>()
  const restrictCalls: Array<{ deny: string[] }> = []
  const released: string[] = []
  const restrictReleased: string[] = []
  const warn = vi.fn()

  // skills 服务：`get` 返回完整定义（含 content），供 shadow 原样复制。
  const definitions: Record<string, Record<string, unknown>> = {}
  const verifyCalls: Array<{ cwd?: string; scope?: unknown }> = []
  const baseSkills = makeSkills({
    global: options.globalSkills ?? ['demo'],
    agent: options.agentSkills ?? ['demo'],
    ...(options.complete === undefined ? {} : { complete: options.complete }),
    // 传入宿主实体本身：替身的 snapshot 只认它才读 agent 层。
    // （`fire(..., {agent})` 把它交给 `asAgentLike` 重包，重包结果的 `raw` 指回它。）
    hostScope: agent,
    shadowed,
    verifyCalls,
    ...(options.officialPaths === undefined ? {} : { officialPaths: options.officialPaths }),
  })
  const skills = {
    snapshot: baseSkills.snapshot,
    get: async (skillName: string) => definitions[skillName] ?? fullDefinition(skillName),
  } as unknown as SkillsServiceLike

  // 预置完整定义（含 name 与 content）：shadow 会原样复制，缺 name 会让替身记成 'undefined'。
  for (const name of options.agentSkills ?? ['demo']) definitions[name] = fullDefinition(name)
  for (const name of options.globalSkills ?? ['demo']) definitions[name] = definitions[name] ?? fullDefinition(name)

  const tools = {
    schemas: () => (options.toolNames ?? ['mcp__gbrain__search']).map((toolName) => ({ name: toolName })),
    view: () => ({ restrictableNames: new Set(options.toolNames ?? ['mcp__gbrain__search']) }),
  } satisfies McpToolFace

  const states = new AgentStates()
  const scoped = {
    // 第二个实参 `agent` 承重：真实实现用它解析作用域（`src/assembly.ts` 的
    // `makeScopedSkills` 惰性读 `agent.ctx.get('skills')`）。替身**记录**它，让用例能断言
    // 「谁被传进来了」；忽略它就等于放过了「装配层把 agent 传错/漏传」这类缺陷。
    register: (definition: Record<string, unknown>, scopeAgent?: unknown) => {
      const skillName = String(definition['name'])
      registerScopes.push(scopeAgent)
      // 记账改为**按名去重累加**，不要依赖上一次调用的数组形状 ——
      // 真实实现改成逐个注册或批量一次时，`includes` 式记账会失真而用例仍绿。
      if (!shadowCalls.includes(skillName)) shadowCalls.push(skillName)
      // 同层先到先得：被顶掉的注册返回 no-op disposer，且**不生效**。
      if (rejectedShadowNames.has(skillName)) return () => {}
      shadowed.add(skillName)
      return () => {
        shadowed.delete(skillName)
        released.push(skillName)
      }
    },
  }

  const deps: HookDeps = {
    store: store as unknown as HookDeps['store'],
    states,
    skills,
    tools,
    loaderServers: async () => [],
    scoped,
    scopedTools: {
      restrict: (filter) => {
        restrictCalls.push(filter)
        return () => {
          if (options.rejectRestrictRelease === true) {
            // 先记账再抛：真实场景里底层层已被撤掉，抛的只是监听器异常。
            for (const toolName of filter.deny) restrictReleased.push(toolName)
            throw new Error('listener boom')
          }
          for (const toolName of filter.deny) restrictReleased.push(toolName)
        }
      },
    },
    logger: { warn },
  }

  return {
    deps,
    agent,
    states,
    state,
    shadowCalls,
    registerScopes,
    verifyCalls,
    shadowed,
    rejectedShadowNames,
    rejectShadow: (name: string) => rejectedShadowNames.add(name),
    restrictCalls,
    released,
    restrictReleased,
    warn,
  }
}


/**
 * 触发事件并**等待**每个监听器返回的 promise。
 * `emit` 返回的是「监听器返回值数组」，`await` 一个数组不会等里面的 promise —— 必须显式收敛。
 */
async function fire(ctx: FakeContext, event: string, ...args: unknown[]): Promise<void> {
  await Promise.all(emitEvent(ctx, event, ...args))
}

/** 真实 cordis 事件面：`emit` 的键是精确字符串，用窄接口读出来避开宿主 Events 类型声明。 */
interface RealEmitter {
  emit(event: string, ...args: unknown[]): unknown
}

describe('installAgentHooks', () => {
  it('registers the hooks on agent/created, agent/disposed, skills/change and tools/change', () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const { deps } = makeHarness()
    installAgentHooks(ctx, deps)
    // 后两个事件名必须带斜杠，与宿主 emit 逐字一致（点号会静默收不到）。
    expect([...ctx.listeners.keys()].sort()).toEqual([
      'agent/created',
      'agent/disposed',
      'skills/change',
      'tools/change',
    ])
  })

  it('applies the shadow and the restriction at creation, before the first assembly', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({
      workspace: { skills: { demo: false }, mcps: {} },
    })
    installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })

    // `agent/created` 返回即代表落地完成，不需要再等后台收敛。
    expect(harness.shadowCalls).toContain('demo')
    // 遮蔽确实**生效**了（而不是只发起了注册）：快照里 demo 的 mi 已变 false。
    expect(harness.shadowed.has('demo')).toBe(true)
    // 遮蔽全部落地 ⇒ 不得有「遮蔽未生效」警告（传错对象会整批误报）。
    expect(harness.warn).not.toHaveBeenCalledWith(expect.stringContaining('遮蔽未生效'))
    // Scope-sensitive lookups and registrations must receive the raw host object.
    expect(harness.registerScopes).toContain(harness.agent)
    expect(harness.registerScopes).not.toContain(harness.states.get('a1')?.agent)
    expect(harness.verifyCalls.every((call) => call.scope === harness.agent)).toBe(true)
    // 没有 workspace 层的 mcp 关闭项 ⇒ 空 deny 不调 restrict（否则宿主抛 no-op）。
    expect(harness.restrictCalls).toEqual([])
  })

  it('derives the hidden set from the full inventory even with official skills hidden from the panel', async () => {
    /*
     * 展示开关只决定面板「列不列」，**不参与掩蔽求值**。
     *
     * 反例的后果是静默的：「打开开关 → 关掉一条官方 skill → 关掉开关」之后，清单里
     * 没有那条名字了，掩蔽集随之丢掉它，官方 skill 会重新对模型可见——面板上看不出任何异常。
     * 这条用例让策略关掉一条**官方路径**的 skill 且保持 `showOfficialSkills: false`，
     * 断言它仍被 shadow。
     */
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({
      global: { mode: 'blacklist', skills: ['office-probe'], mcps: [], showOfficialSkills: false },
      globalSkills: ['demo', 'office-probe'],
      agentSkills: ['demo', 'office-probe'],
      officialPaths: ['office-probe'],
    })
    installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    await vi.waitFor(() => expect(harness.shadowCalls).toContain('office-probe'))

    expect(harness.shadowCalls).toContain('office-probe')
    expect(harness.shadowed.has('office-probe')).toBe(true)
    // demo 不在名单里，不应被误伤。
    expect(harness.shadowCalls).not.toContain('demo')
  })

  it('re-grounds to the saved policy on skills/change and re-derives the hidden set', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({ agentSkills: ['demo', 'other'] })
    installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    await vi.waitFor(() => expect(harness.states.get('a1')?.policy).not.toBeNull())
    expect(harness.states.get('a1')?.policy).not.toBeNull()

    // 保存后 store 返回新策略，且变化通过 skills/change 到达。
    harness.state.workspace = { skills: { other: false }, mcps: {} }
    await fire(ctx, 'skills/change', {})
    expect(harness.states.get('a1')?.policy?.workspace).toEqual({ skills: { other: false }, mcps: {} })
  })

  /**
   * 事件名的**真实 surface** 钉子：假 ctx 的 `listeners` 是 Map，只要测试和实现用同一个
   * 拼错的字符串就会一起通过（本次缺陷正是这样躲过 198 条用例的）。这条用例改用宿主真正
   * 使用的 cordis `EventsService`，用 `emit` 发出**宿主实际发出的名字**，断言回调真的被调用。
   * 一旦有人把注册改回点号的 `skills.change`，这里会立刻失败。
   */
  it('reacts to the exact event names the host emits', async () => {
    // 用真实 cordis Context 作事件面；emit/on 的键是精确字符串。
    const ctx = new Context() as unknown as FakeContext & RealEmitter
    const harness = makeHarness({ agentSkills: ['demo', 'other'] })
    installAgentHooks(ctx as unknown as Parameters<typeof installAgentHooks>[0], harness.deps)

    // 先让一个 agent 建起来（onChange 只遍历已存在的 agent 状态），再改策略。
    ctx.emit('agent/created', { agent: harness.agent, source: 'session' })
    await vi.waitFor(() => {
      expect(harness.states.get('a1')?.policy).not.toBeNull()
    })

    harness.state.workspace = { skills: { other: false }, mcps: {} }
    // 宿主 `dsh-skill` 的 `notifyChange()` 实际发出的名字。
    ctx.emit('skills/change')
    // 回调是 async 且经 serial 链派发；等链尾跑完。
    await vi.waitFor(() => {
      expect(harness.states.get('a1')?.policy?.workspace).toEqual({ skills: { other: false }, mcps: {} })
    })
  })

  it('does not change the effective state when the inventory is incomplete', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({ complete: false })
    installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    await vi.waitFor(() => expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('incomplete')))
    expect(harness.shadowCalls).toEqual([])
  })

  it('keeps the hidden MCP inventory stable after applying a restriction', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({ workspace: { skills: {}, mcps: { gbrain: false } } })
    const visible = new Set(['mcp__gbrain__search'])
    const tools = harness.deps.tools as McpToolFace & { schemas: () => Array<{ name: string }> }
    tools.schemas = () => [...visible].map((name) => ({ name }))
    const restrict = harness.deps.scopedTools.restrict
    harness.deps.scopedTools.restrict = (filter) => {
      const release = restrict(filter)
      visible.clear()
      return () => {
        release()
        visible.add('mcp__gbrain__search')
      }
    }

    installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    await vi.waitFor(() => expect(harness.restrictCalls).toHaveLength(1))
    await new Promise<void>((resolve) => setTimeout(resolve, 10))

    expect(harness.restrictCalls).toHaveLength(1)
    expect(visible).toEqual(new Set())
  })

  it('coalesces external changes while an application is blocked and applies the latest inventory', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({
      workspace: { skills: { demo: false }, mcps: {} },
      agentSkills: ['demo', 'other'],
    })
    const originalRegister = harness.deps.scoped.register
    let releaseRegister!: () => void
    let registerBlocked = true
    let activeRegisters = 0
    let maxActiveRegisters = 0
    harness.deps.scoped.register = (definition: Record<string, unknown>, scopeAgent?: unknown) => {
      activeRegisters += 1
      maxActiveRegisters = Math.max(maxActiveRegisters, activeRegisters)
      if (registerBlocked) {
        void new Promise<void>((resolve) => {
          releaseRegister = resolve
        }).then(() => {
          activeRegisters -= 1
        })
        return () => {}
      }
      try {
        return originalRegister(definition, scopeAgent)
      } finally {
        activeRegisters -= 1
      }
    }
    const baseSnapshot = harness.deps.skills.snapshot
    let calls = 0
    harness.deps.skills.snapshot = async (call: { cwd?: string; scope?: unknown }) => {
      calls += 1
      return await baseSnapshot(call)
    }
    installAgentHooks(ctx, harness.deps)
    const created = fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    await vi.waitFor(() => expect(releaseRegister).toBeTypeOf('function'))
    registerBlocked = false
    harness.state.workspace = { skills: { other: false }, mcps: {} }
    const changed = fire(ctx, 'skills/change', {})
    releaseRegister()
    await Promise.all([created, changed])
    expect(harness.states.get('a1')?.policy?.workspace).toEqual({ skills: { other: false }, mcps: {} })
    expect(maxActiveRegisters).toBe(1)
  })

  // 验收：`agent/created` 必须等到过滤真正落地才返回。宿主侧 `announce()` 会
  // `await ctx.serial(carrier, 'agent/created', …)`，那个 Promise 就是「落地早于首次装配」的
  // 屏障；本用例与之等价——创建完成时 shadow 已经注册，宿主首个 `agent/pre-step` 读到的
  // 目录只会是过滤后的那一份，不会先看到全量再被整份替换。
  it('waits for the shadow to land before agent creation returns', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({ globalSkills: ['demo', 'other'], agentSkills: ['demo', 'other'] })
    let releaseSnapshot!: () => void
    let snapshotStarted!: () => void
    const started = new Promise<void>((resolve) => { snapshotStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseSnapshot = resolve })
    let snapshotCalls = 0
    const baseSnapshot = harness.deps.skills.snapshot
    harness.deps.skills.snapshot = async (call: { cwd?: string; scope?: unknown }) => {
      snapshotCalls += 1
      if (snapshotCalls === 1) {
        snapshotStarted()
        await blocked
      }
      return await baseSnapshot(call)
    }
    const hooks = installAgentHooks(ctx, harness.deps)
    try {
      // 策略要在创建期就被读到：阻塞点在清单读取，求值已经发生过。
      harness.state.workspace = { skills: { other: false }, mcps: {} }
      let createdFinished = false
      const created = fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
        .then(() => { createdFinished = true })
      await started
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(createdFinished).toBe(false)
      expect(harness.shadowCalls).toEqual([])
      releaseSnapshot()
      await created
      expect(createdFinished).toBe(true)
      expect(harness.shadowCalls).toEqual(['other'])
      expect(harness.states.get('a1')?.policy?.workspace).toEqual({ skills: { other: false }, mcps: {} })
    } finally {
      releaseSnapshot()
      hooks.stopAll()
    }
  })

  // 重入分支：已有过滤在跑时 `requestAgentApply` 必须共享那份 in-flight 结果。
  // 旧实现直接 `Promise.resolve()`，调用方以为自己等过了，实际它的请求还没发生。
  it('shares the in-flight application with a concurrent request instead of resolving early', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({ globalSkills: ['demo', 'other'], agentSkills: ['demo', 'other'] })
    let releaseSnapshot!: () => void
    let snapshotStarted!: () => void
    const started = new Promise<void>((resolve) => { snapshotStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseSnapshot = resolve })
    let blockedOnce = false
    const baseSnapshot = harness.deps.skills.snapshot
    harness.deps.skills.snapshot = async (call: { cwd?: string; scope?: unknown }) => {
      if (!blockedOnce) {
        blockedOnce = true
        snapshotStarted()
        await blocked
      }
      return await baseSnapshot(call)
    }
    harness.state.workspace = { skills: { other: false }, mcps: {} }
    const hooks = installAgentHooks(ctx, harness.deps)
    try {
      const created = fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
      await started
      let secondFinished = false
      const second = hooks.reapply().then(() => { secondFinished = true })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(secondFinished).toBe(false)
      releaseSnapshot()
      await Promise.all([created, second])
      expect(secondFinished).toBe(true)
      expect(harness.shadowCalls).toEqual(['other'])
    } finally {
      releaseSnapshot()
      hooks.stopAll()
    }
  })

  /*
   * 处置早于回合开始，本回合不得做任何事。
   *
   * `calls`（`computeHidden` 里的 `skills.snapshot`）钉的是 `evaluate` 之后那条
   * `isActive()`（`hooks.ts:359`）：单删它 → `calls` 变 1 → 红（实测）。
   *
   * 更早的两条守卫（`requestAgentApply` 的 `:389`、`drainAgent` 入口的 `:348`）在本
   * 时序里**赶不上**：`fire('agent/created')` 同步进入链体，`evaluate` 的 `loadGlobal`
   * 已经先跑了一次（实测 `loads === 1`），处置事件是之后才到的。所以那两条不可观测，
   * 本用例不假装覆盖它们。
   *
   * 同时它守住 `agent/disposed` 的 payload 解析：宿主发 `{ agent }`，若回退成
   * `asAgentLike(value)`，`schedule.disposed` 不置真，`calls` 会变正。
   */
  it('does not evaluate at all when the agent was disposed first', { timeout: 3000 }, async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({
      workspace: { skills: { demo: false }, mcps: {} },
    })
    let calls = 0
    const baseSnapshot = harness.deps.skills.snapshot
    harness.deps.skills.snapshot = async (call: { cwd?: string; scope?: unknown }) => {
      calls += 1
      return await baseSnapshot(call)
    }
    installAgentHooks(ctx, harness.deps)
    const created = fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    await fire(ctx, 'agent/disposed', { agent: harness.agent })
    await created
    expect(calls).toBe(0)
    expect(harness.shadowCalls).toEqual([])
  })

  /*
   * 晚到的落地必须被撤销：`applySkillShadow` 已经 register 之后才收到 `agent/disposed`，
   * 那层 shadow 就成了孤儿（清单里 demo 永远 `modelInvocable: false`，状态里也已没有
   * 任何句柄能释放它）。这条覆盖 `applyRound` 里 `!isActive()` 的释放分支。
   */
  it('releases a shadow that lands after the agent was disposed', { timeout: 3000 }, async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({
      workspace: { skills: { demo: false }, mcps: {} },
    })
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    let calls = 0
    const baseSnapshot = harness.deps.skills.snapshot
    harness.deps.skills.snapshot = async (call: { cwd?: string; scope?: unknown }) => {
      calls += 1
      // 第 1 次是求值；第 2 次是**注册之后**的复验，卡在这里就打开了「已落地但未提交」的窗口。
      if (calls >= 2) await gate
      return await baseSnapshot(call)
    }
    installAgentHooks(ctx, harness.deps)
    const created = fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    await vi.waitFor(() => expect(harness.shadowCalls).toEqual(['demo']))
    await fire(ctx, 'agent/disposed', { agent: harness.agent })
    openGate()
    await created
    // 晚到的那层被释放（正常路径下 released 只会因 disposed 事件增长一次）。
    expect(harness.released).toEqual(['demo'])
    // 不再断言 `states` 里没有 a1：`onDisposed` 无条件 delete，那条断言恒真（实测删掉
    // `releaseOne` 后它依旧是绿的），装饰性断言会让人误以为缺陷有信号。
  })

  /*
   * MCP 侧的晚到撤销：`restrict` 已经把底层层挂上（工具已经收窄），之后才收到
   * `agent/disposed`。若 `applyRound` 不看 `isActive()` 就提交，句柄会连同已消失的 state
   * 一起丢掉 —— 这层 restriction 再没有任何引用能释放它，被禁工具在整个会话里永久不可见
   * （用户看到的是「工具列表缺东西」，日志一行没有）。
   *
   * 实测：单独删掉 `src/agent/hooks.ts:249-256` 那段 `if (!isActive())`，本条是唯一失败的
   * 用例（此前该分支零覆盖，摘掉后 421 全绿）。
   */
  it('releases an mcp restriction that lands after the agent was disposed', { timeout: 3000 }, async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({ workspace: { skills: {}, mcps: { gbrain: false } } })
    const baseRestrict = harness.deps.scopedTools.restrict
    let fired = false
    harness.deps.scopedTools = {
      restrict: (filter) => {
        const handle = baseRestrict(filter)
        // 同步派发（`emitEvent` 不是 promise）：底层层此刻已经收窄完，句柄也已返回，
        // 而本回合还没走到提交 state 的那一步 —— 正是「已落地、未提交」的窗口。
        if (!fired) {
          fired = true
          emitEvent(ctx, 'agent/disposed', { agent: harness.agent })
        }
        return handle
      },
    }
    installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    expect(harness.restrictCalls).toEqual([{ deny: ['mcp__gbrain__search'] }])
    expect(harness.restrictReleased).toEqual(['mcp__gbrain__search'])
    expect(harness.states.get('a1')).toBeUndefined()
  })

  /*
   * `onReleaseError` 的**接线**：`mcp.spec` 里的三条用例都是直接传回调给
   * `applyMcpRestriction`，证明不了 `applyRound` 把它接上了。删掉 `hooks.ts` 那三行，
   * 旧全量 418/418 仍然全绿 —— 而后果是 release 抛错被静默吞掉、被禁工具这一轮全部
   * 重新可见、日志零痕迹。
   */
  it('logs when the old mcp restriction refuses to release', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({
      workspace: { skills: {}, mcps: { gbrain: false } },
      rejectRestrictRelease: true,
    })
    installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    expect(harness.restrictCalls).toEqual([{ deny: ['mcp__gbrain__search'] }])

    // 打开 gbrain ⇒ 隐藏集变空 ⇒ 走「撤掉旧层」的那条释放路径（旧句柄会抛）。
    harness.state.workspace = { skills: {}, mcps: { gbrain: true } }
    await fire(ctx, 'tools/change', {})
    // 认「撤销」而不是「释放」：后者与 `releaseOne` 的 `释放 ${label} 失败` 逐字相同，
    // 同一轮里若两处都可能触发，删掉 `onReleaseError` 接线也会被另一条日志掩盖（实测）。
    expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('撤销 mcp restriction 失败'))
  })

  it('retries one incomplete snapshot and recovers after a later notification', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    let complete = false
    const verifyCalls: Array<{ cwd?: string; scope?: unknown }> = []
    const harness = makeHarness({ agentSkills: ['demo'] })
    const baseSnapshot = harness.deps.skills.snapshot
    harness.deps.skills.snapshot = async (call: { cwd?: string; scope?: unknown }) => {
      verifyCalls.push(call)
      const result = await baseSnapshot(call)
      return { ...result, complete }
    }
    installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    await vi.waitFor(() => expect(verifyCalls).toHaveLength(2))
    expect(harness.shadowCalls).toEqual([])
    complete = true
    harness.state.workspace = { skills: { demo: false }, mcps: {} }
    await fire(ctx, 'skills/change', {})
    expect(verifyCalls.length).toBeGreaterThanOrEqual(3)
    expect(harness.shadowCalls).toEqual(['demo'])
  })
  it('never throws out of agent/created, so session creation cannot fail', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness()
    harness.state.fail = true
    installAgentHooks(ctx, harness.deps)
    // 必须 resolve（不 reject）：抛错会让会话创建失败。
    // 侦测的是 ctx.logger.warn —— 这就是实现里用来「降级并留痕」的那条通道。
    await expect(
      Promise.all(emitEvent(ctx, 'agent/created', { agent: harness.agent, source: 'session' })),
    ).resolves.toBeDefined()
    expect(ctx.warnings.join('\n')).toContain('agent/created')
  })


  it('releases shadows and restrictions on agent/disposed', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({
      workspace: { skills: { demo: false }, mcps: { gbrain: false } },
    })
    installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    await vi.waitFor(() => expect(harness.shadowCalls.flat()).toEqual(['demo']))
    // 创建只注册、不释放：此时 released 必须还是空的。
    expect(harness.released).toEqual([])
    expect(harness.shadowCalls.flat()).toEqual(['demo'])
    expect(harness.restrictCalls).toEqual([{ deny: ['mcp__gbrain__search'] }])

    await fire(ctx, 'agent/disposed', { agent: harness.agent })
    // 释放恰好一次（创建时不释放，见上一个用例），且状态被摘除。
    expect(harness.released).toEqual(['demo'])
    expect(harness.restrictReleased).toEqual(['mcp__gbrain__search'])
    expect(harness.states.get('a1')).toBeUndefined()
  })

  it('releases everything when the plugin unloads', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({
      workspace: { skills: { demo: false }, mcps: { gbrain: false } },
    })
    const stop = installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    await vi.waitFor(() => expect(harness.shadowed.has('demo')).toBe(true))
    stop.stopAll()
    // 卸载释放那一个存活状态：skill shadow 一次、restriction 一次。
    expect(harness.released).toEqual(['demo'])
    expect(harness.restrictReleased).toEqual(['mcp__gbrain__search'])
  })

  it('keeps working without a connection service', () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const { deps } = makeHarness()
    expect(() => installAgentHooks(ctx, deps)).not.toThrow()
  })
})
