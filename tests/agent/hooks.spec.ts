import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { installAgentHooks, type HookDeps } from '../../src/agent/hooks.ts'
import { AgentStates, type AgentLike } from '../../src/agent/state.ts'
import { EMPTY_POLICY, type LayerPolicy } from '../../src/policy/schema.ts'
import type { LoadResult, SaveOutcome } from '../../src/policy/store.ts'
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
        })),
        complete: options.complete ?? true,
      }
    },
  } as unknown as SkillsServiceLike
}

/** 一个策略 store 替身：内存态，可注入失败。 */
function makeStore(state: { global: LayerPolicy; workspace: LayerPolicy | null; fail?: boolean }) {
  return {
    loadGlobal: async (): Promise<LoadResult> => {
      if (state.fail === true) throw new Error('store exploded')
      return { policy: state.global, revision: 'r-g', exists: true }
    },
    loadWorkspace: async (): Promise<LoadResult & { path: string }> => {
      if (state.fail === true) throw new Error('store exploded')
      return {
        policy: state.workspace ?? EMPTY_POLICY,
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
  workspace?: LayerPolicy | null
  globalSkills?: string[]
  agentSkills?: string[]
  complete?: boolean
  toolNames?: string[]
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
      workspace: { mode: 'blacklist', skills: ['demo'], mcps: [] },
    })
    installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })

    // 工作区层关掉 demo ⇒ demo 被遮蔽。
    expect(harness.shadowCalls).toContain('demo')
    // 遮蔽确实**生效**了（而不是只发起了注册）：快照里 demo 的 mi 已变 false。
    expect(harness.shadowed.has('demo')).toBe(true)
    // 遮蔽全部落地 ⇒ 不得有「遮蔽未生效」警告（传错对象会整批误报）。
    expect(harness.warn).not.toHaveBeenCalledWith(expect.stringContaining('遮蔽未生效'))
    // 第二个实参：**`asAgentLike` 新造的那个对象**（`onCreated` 一律重包负载），
    // 既不是 `harness.agent`，也不是 `agent.raw`。这看起来绕，但正合真实情形——
    // 装配层需要的是它上面的 `ctx`，而 `asAgentLike` 把 `ctx` **原样透传**，
    // 所以 `makeScopedSkills` 的 `agent.ctx.get('skills')` 取到的仍是正确的作用域实例。
    // 反过来，`snapshot({ scope })` 走对象身份索引，才必须用 `agent.raw`。
    expect(harness.registerScopes).not.toContain(harness.agent)
    expect(harness.registerScopes).toContain(harness.states.get('a1')?.agent)
    // 没有 workspace 层的 mcp 关闭项 ⇒ 空 deny 不调 restrict（否则宿主抛 no-op）。
    expect(harness.restrictCalls).toEqual([])
  })

  it('re-grounds to the saved policy on skills/change and re-derives the hidden set', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({ agentSkills: ['demo', 'other'] })
    installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    expect(harness.states.get('a1')?.policy).not.toBeNull()

    // 保存后 store 返回新策略，且变化通过 skills/change 到达。
    harness.state.workspace = { mode: 'blacklist', skills: ['other'], mcps: [] }
    await fire(ctx, 'skills/change', {})
    expect(harness.states.get('a1')?.policy?.workspace).toEqual({
      mode: 'blacklist',
      skills: ['other'],
      mcps: [],
    })
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

    harness.state.workspace = { mode: 'blacklist', skills: ['other'], mcps: [] }
    // 宿主 `dsh-skill` 的 `notifyChange()` 实际发出的名字。
    ctx.emit('skills/change')
    // 回调是 async 且经 serial 链派发；等链尾跑完。
    await vi.waitFor(() => {
      expect(harness.states.get('a1')?.policy?.workspace).toEqual({
        mode: 'blacklist',
        skills: ['other'],
        mcps: [],
      })
    })
  })

  it('does not change the effective state when the inventory is incomplete', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({ complete: false })
    installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    expect(harness.shadowCalls).toEqual([])
    expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining('incomplete'))
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
      workspace: { mode: 'blacklist', skills: ['demo'], mcps: ['gbrain'] },
    })
    installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
    // 创建只注册、不释放：此时 released 必须还是空的。
    expect(harness.released).toEqual([])
    expect(harness.shadowCalls.flat()).toEqual(['demo'])
    expect(harness.restrictCalls).toEqual([{ deny: ['mcp__gbrain__search'] }])

    await fire(ctx, 'agent/disposed', harness.agent)
    // 释放恰好一次（创建时不释放，见上一个用例），且状态被摘除。
    expect(harness.released).toEqual(['demo'])
    expect(harness.restrictReleased).toEqual(['mcp__gbrain__search'])
    expect(harness.states.get('a1')).toBeUndefined()
  })

  it('releases everything when the plugin unloads', async () => {
    const ctx = makeFakeCtx() as unknown as Context & FakeContext
    const harness = makeHarness({
      workspace: { mode: 'blacklist', skills: ['demo'], mcps: ['gbrain'] },
    })
    const stop = installAgentHooks(ctx, harness.deps)
    await fire(ctx, 'agent/created', { agent: harness.agent, source: 'session' })
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
