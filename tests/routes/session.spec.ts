import { describe, expect, it } from 'vitest'
import { resolveSession, type PluginContextLike } from '../../src/routes/session.ts'
import { makeFakeCtx } from '../support/fake-ctx.ts'

/** 一个最小 live agent。resolveSession 只把它透传出去，不需要任何真实能力。 */
const liveAgent = {
  id: 's1',
  ctx: { get: () => undefined },
  session: { id: 's1', header: { cwd: '/Users/go/proj/demo' } },
}

/**
 * 造一个只暴露 sessionQuery / agents 两个服务的 ctx。
 *
 * `observeSession` 的替身是这些用例的核心。替身必须**逐条复刻真实宿主的契约**，
 * 否则测出来的是假阳性——本文件已经因为替身失真漏过两次真实缺陷，
 * 所以下面三处都按宿主源码写死：
 *
 * 1. `async` 方法（`@deepseek-ai/dsh-session-query/index.js:354` `async read(...)`）；
 * 2. 依赖 `this`（`read()` 内部读 `this.ctx` / `this.cache`）；
 * 3. 释放钩子是 `[Symbol.dispose]`，**不是** `.dispose()`（同上 `:467` / `:502`）。
 */
function makeCtx(options: {
  /** 额外加到 observation 上的字段（如会抛错的 `projections` getter）。 */
  observation?: Record<string, unknown>
  /** 覆盖默认的 header。 */
  header?: unknown
  observeThrows?: boolean
  agent?: unknown
}): { ctx: PluginContextLike; disposed: () => boolean } {
  let observationDisposed = false
  const observation = {
    header: options.header ?? { cwd: '/Users/go/proj/demo' },
    projections: { values: { agentPreset: 'standard' } },
  } as Record<string, unknown>
  // 用 defineProperty 而非展开：额外字段可能带 getter（「读取时抛错」用例），
  // 展开会立刻求值，把它变成「构造时抛错」，测不到 resolveSession 的 finally。
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(options.observation ?? {}),
  )) {
    Object.defineProperty(observation, key, descriptor)
  }
  // 只给 `[Symbol.dispose]`，**故意不提供 `.dispose()`**：
  // 真实 lease 就是这个形状，提供 `.dispose()` 会让「用错释放钩子」的实现照样通过。
  Object.defineProperty(observation, Symbol.dispose, {
    value: () => {
      observationDisposed = true
    },
    enumerable: false,
  })
  const sessionQuery = {
    // 用一个独立标记证明 `this` 绑定正确：只有当 `this` 就是 sessionQuery 本身时
    // 才允许返回观察体，否则抛错。摘出方法当普通函数调 → `this === undefined` → 抛错。
    observeSession: async function (this: unknown) {
      if (this !== sessionQuery) {
        throw new Error(`observeSession called with wrong this: ${String(this)}`)
      }
      if (options.observeThrows === true) throw new Error('EIO: projection read failed')
      // 原样返回同一个对象：**不能用 `{ ...observation }`**，展开会立刻求值
      // `projections` getter，把「读取时抛错」提前成「构造时抛错」，测不到 finally。
      return observation
    },
  }
  const agents = {
    /*
     * **替身必须要求正确的 `this`（实测缺陷根因）。**
     *
     * 宿主实现是 `@deepseek-ai/dsh-agent/lib/index.js:594`
     * `get(id) { return this.store.get(id)?.agent }` —— 它解引用 `this.store`。
     * 本插件原先调用成 `.call(null, sessionId)`，于是**每个会话**都抛
     * `TypeError: Cannot read properties of null (reading 'store')`（已用最小脚本实测复现），
     * 又被空 catch 吞掉 → `live` 恒为 `false` → 工作区视图退化成全局清单。
     *
     * 旧替身写成箭头函数 `get: () => options.agent`，箭头函数**根本不看 `this`**，
     * 所以丢 `this` 的实现照样全绿——那正是这个缺陷能溜过测试的原因。
     * 因此这里刻意写成普通函数并断言接收者，让实现再也无法悄悄丢 `this`。
     */
    store: { agent: options.agent },
    get(this: { store?: { agent?: unknown } }, _id: string) {
      if (this !== agents) throw new Error(`agents.get called with wrong this: ${String(this)}`)
      // `this.store` 在真实实现里必定存在（构造期赋值），这里用可选链只为让 TS 收窄。
      return this.store?.agent
    },
  }
  const ctx = makeFakeCtx({ sessionQuery, agents })
  return { ctx: ctx as unknown as PluginContextLike, disposed: () => observationDisposed }
}

describe('resolveSession', () => {
  it('resolves cwd and preset through sessionQuery, then prefers the live agent', async () => {
    const { ctx } = makeCtx({ agent: liveAgent })
    expect(await resolveSession(ctx, 's1')).toMatchObject({
      cwd: '/Users/go/proj/demo',
      agentPreset: 'standard',
      live: true,
    })
  })

  it('disposes the observation it opened', async () => {
    const { ctx, disposed } = makeCtx({ agent: liveAgent })
    await resolveSession(ctx, 's1')
    expect(disposed()).toBe(true)
  })

  it('returns null when neither the session nor an agent resolves', async () => {
    // 会话不存在：宿主 `observeSession` 抛错；同时 `agents.get` 也取不到。
    const { ctx } = makeCtx({ observeThrows: true })
    expect(await resolveSession(ctx, 'nope')).toBeNull()
  })

  it('returns live:false and agent:null when the session resolves but no live agent exists', async () => {
    const { ctx, disposed } = makeCtx({ agent: undefined })
    expect(await resolveSession(ctx, 's1')).toMatchObject({ live: false, agent: null })
    expect(disposed()).toBe(true)
  })

  it('still disposes the observation when the projection read throws', async () => {
    const { ctx, disposed } = makeCtx({ agent: liveAgent, observeThrows: true })
    // 投影读失败但 agent 仍在：会话可解析，只是拿不到 preset。
    expect(await resolveSession(ctx, 's1')).toMatchObject({ agentPreset: null, live: true })
    // 抛错路径上**没有** observation 可释放（宿主在构造期就失败了），
    // 但函数必须已走完 finally 而不再持有任何引用，且不得把异常外泄。
    expect(disposed()).toBe(false)
  })

  it('disposes the observation even when reading the projection value throws', async () => {
    // observation 已成功造出，但读取 `projections` 时抛错（宿主返回的 getter 可能抛）。
    // `finally` 必须仍然释放它 —— 这正是 try/finally 存在的理由。
    const { ctx, disposed } = makeCtx({
      agent: liveAgent,
      observation: {
        get projections(): unknown {
          throw new Error('ETIMEDOUT: projections unavailable')
        },
      },
    })
    const view = await resolveSession(ctx, 's1')
    expect(view).toMatchObject({ cwd: '/Users/go/proj/demo', agentPreset: null, live: true })
    expect(disposed()).toBe(true)
  })

  it('falls back to the agent cwd when the header carries none', async () => {
    const { ctx } = makeCtx({ agent: liveAgent, header: {} })
    expect(await resolveSession(ctx, 's1')).toMatchObject({ cwd: '/Users/go/proj/demo', live: true })
  })

  it('awaits observeSession instead of treating its Promise as an observation', async () => {
    // 回归守卫（实测缺陷）：`observeSession` 返回 Promise。若实现不 await，
    // `asRecord(promise)` 会把 Promise 当成普通对象收下（Promise 是非数组对象，
    // 能过类型判定），于是 `observed=true` 但 `cwd` 恒为 `null`。
    // 真实的「已持久化但当前不 live」的会话就因此被误判成 `unknown-session`。
    const { ctx } = makeCtx({ agent: undefined, header: { cwd: '/Users/go/proj/demo' } })
    const view = await resolveSession(ctx, 's1')
    expect(view).not.toBeNull()
    expect(view?.cwd).toBe('/Users/go/proj/demo')
    expect(view?.live).toBe(false)
  })

  it('maps a rejected observeSession to a null resolve, not an unhandled rejection', async () => {
    // 同一个根因的另一面：未知会话时 `read()` 走的是 **reject 而不是同步 throw**。
    // 不 await 的 `try/catch` 接不住它，会漏成未处理的 rejection。
    const { ctx } = makeCtx({ observeThrows: true, agent: undefined })
    await expect(resolveSession(ctx, 'nope')).resolves.toBeNull()
  })

  it('calls agents.get with the agents service as this, so a live agent is found', async () => {
    // 回归守卫（实测缺陷，用户报告「skill 是所有的而不是全局过滤后的」）：
    // 宿主的 `agents.get` 是 `get(id) { return this.store.get(id)?.agent }`，
    // 必须带接收者调用。写成 `.call(null, ...)` 时抛 TypeError 且被空 catch 吞掉，
    // 于是**任何会话**都被判成没有 live Agent（live:false），工作区清单退化成全局
    // 141 条（与 /global 逐条相同）。替身（普通函数 + 断言 this）会拒收错误的接收者，
    // 所以这条用例在丢 `this` 的实现上必然失败。
    const { ctx } = makeCtx({ agent: liveAgent })
    const view = await resolveSession(ctx, 's1')
    expect(view?.agent).not.toBeNull()
    expect(view?.live).toBe(true)
  })

  it('binds this when exposing the agent ctx getter', async () => {
    // 同族的第二处丢 `this`：`ctx.get` 走 cordis 的 `this.registry`。
    // 它用来解析该 agent **自己那一层**的 skills/tools 服务，丢 `this` 就取不到作用域层，
    // 收窄会写到错误的层上。这里用一个要求接收者的 getter 把它钉住。
    const agentCtx = {
      registry: { skills: 'scoped-skills' },
      get(this: { registry?: Record<string, unknown> }, name: string) {
        if (this !== agentCtx) throw new Error(`ctx.get called with wrong this: ${String(this)}`)
        return this.registry?.[name]
      },
    }
    const { ctx } = makeCtx({ agent: { ...liveAgent, ctx: agentCtx } })
    const view = await resolveSession(ctx, 's1')
    expect(view?.agent?.ctx.get('skills')).toBe('scoped-skills')
  })

  it('returns the very object agents.get produced, so the scope chain resolves', async () => {
    // 回归守卫（实测缺陷，用户报告「空白会话里改了 skills 开关，本会话列表纹丝不动」）。
    //
    // 调用方把 `view.agent` 原样当作 `snapshot({ scope: agent })` 的 scope key，
    // 而 `@deepseek-ai/dsh-scope` 的 `scopeChainOf(key)` 直接拿这个值
    // 去查 `scopeParents`（以对象身份为键的 WeakMap）。**重新造一个形状相同的对象
    // （或包一层 Proxy）都会得到不同的身份**，查不到父链 → 只剩全局层 →
    // 工作区清单退化成未收窄的全局清单。
    //
    // 所以这条断言钉的不是字段值（那是 toMatchObject 的事），而是**引用相等**。
    const { ctx } = makeCtx({ agent: liveAgent })
    const view = await resolveSession(ctx, 's1')
    expect(view?.agent).toBe(liveAgent)
  })

  it('still rejects an agent whose ctx.get is unusable', async () => {
    // 守卫的另一半：保留身份不等于放弃校验。`ctx.get` 取不出来时返回 `null`，
    // 让调用方退化成只读全局清单（与加守卫之前的行为一致），而不是抛错。
    const { ctx } = makeCtx({ agent: { ...liveAgent, ctx: { notGet: 1 } } })
    expect((await resolveSession(ctx, 's1'))?.agent).toBeNull()
  })
})
