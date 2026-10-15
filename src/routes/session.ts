import type { AgentLike } from '../agent/state.ts'
import { asRecord, readFunction, readString } from '../shared/unknown.ts'

/**
 * 路由层需要的最小 Context 面（结构性类型，不 import cordis 的 `Context`）。
 *
 * 只声明本层真正用到的两个成员：`get` 与 `logger.warn`。
 * 这样替身、以及任何满足该形状的对象都能直接传入，而不必伪造整个 cordis Context。
 */
export interface PluginContextLike {
  get(name: string): unknown
  logger: { warn(message: string): void }
}

/** 一个会话在传输层的只读视图。`agent` 为 `null` 表示该会话当前没有 live Agent。 */
export interface SessionView {
  sessionId: string
  cwd: string
  agentPreset: string | null
  agent: AgentLike | null
  live: boolean
}

/**
 * 读观察体的 `[Symbol.dispose]` 释放钩子。
 *
 * 观察 lease **不提供** `.dispose()` 方法，只有 `[Symbol.dispose]`
 * （`@deepseek-ai/dsh-session-query/lib/index.js:467` / `:502`）。
 * 用 `Symbol.dispose` 取值时必须先确认该 symbol 存在：老运行时上 `Symbol.dispose` 可能是
 * `undefined`，那样 `source[undefined]` 会退化成读字符串键 `"undefined"`。
 */
function readSymbolDispose(source: unknown): (() => void) | null {
  const record = asRecord(source)
  if (record === null) return null
  const symbol = Symbol.dispose
  if (typeof symbol !== 'symbol') return null
  const value = (record as Record<symbol, unknown>)[symbol]
  return typeof value === 'function' ? (value as () => void) : null
}

/**
 * 观察体只暴露 `[Symbol.dispose]`、**没有** `.dispose()` 方法（见 `readSymbolDispose` 的注释），
 * 所以释放一律走这里；失败只 warn —— 本函数的返回值比一次释放失败更重要。
 */
function releaseObservation(ctx: PluginContextLike, observation: unknown, sessionId: string): void {
  try {
    readSymbolDispose(observation)?.()
  } catch (error) {
    ctx.logger.warn(`dsh-skill-scope: 释放会话观察失败（sessionId=${sessionId}）：${String(error)}`)
  }
}

/**
 * 把一个 `sessionId` 解析成传输层视图（设计 6.3）。
 *
 * 顺序固定为「先问宿主拿到 cwd 与 preset，再优先取 live Agent」：
 * 1. `sessionQuery.observeSession(sessionId, { projectionMode: 'none' })` —— 只读快照，不要投影推送。
 * 2. `agents.get(sessionId)` —— 拿到就说明该会话是活跃的，它的清单才是实时清单。
 *
 * **observation 必须在 `finally` 里 `dispose()`**：宿主会为每次观察保留订阅，
 * 漏掉一次就是一条长期泄漏；成功路径和抛错路径都必须释放。
 *
 * 两者都取不到时返回 `null`（未知会话）；只要有一边成立就返回视图，
 * 没有 live Agent 时用 `agent: null` + `live: false` 表示「非实时」。
 */
export async function resolveSession(ctx: PluginContextLike, sessionId: string): Promise<SessionView | null> {
  let cwd: string | null = null
  let agentPreset: string | null = null
  let observed = false

  const sessionQuery = asRecord(ctx.get('sessionQuery'))
  const observe = readFunction(sessionQuery, 'observeSession')
  if (observe !== null) {
    let observation: unknown
    try {
      // 三条契约必须同时成立，缺任何一条都表现为 `unknown-session`（三条都已实测踩过）：
      //
      // ① **必须 `await`**：`observeSession` 是 `async` 方法
      //    （`@deepseek-ai/dsh-session-query` 的 `SessionObservationReader.read`，
      //    `index.js:354` 声明为 `async read(...)`），返回 Promise 而不是观察对象。
      //    不 await 时 `asRecord(promise)` 会把 Promise 当普通对象收下（Promise 是非数组对象，
      //    能过类型判定），于是 `observed=true` 而 `cwd` 恒为 `null`；
      //    且未知会话走的是 **reject 而非同步 throw**，非 await 的 try/catch 接不住。
      //
      // ② **必须绑定 `this`**：`read()` 内部要读 `this.ctx` / `this.cache` 等实例字段
      //    （`index.js:356` 起）。把方法摘出来当普通函数调会让 `this` 变成 `undefined`。
      //    调用的正确写法是先把方法绑回它的宿主对象再调用
      //    （`const observe = query.observeSession.bind(query)`），
      //    因此这里用 `observe.call(sessionQuery, ...)` 而不是 `observe(...)`。
      observation = await observe.call(sessionQuery, sessionId, { projectionMode: 'none' })
    } catch (error) {
      // 未知会话在这里就 reject。不是致命错误：agent 侧仍可能给出答案，交给下面的分支处理。
      ctx.logger.warn(`dsh-skill-scope: 观察会话失败（sessionId=${sessionId}）：${String(error)}`)
      observation = undefined
    }
    // `try` 必须包住**读取**本身，而不只是「有 observation 时」：
    // 宿主返回的 `projections` 可能是会抛错的 getter，那种失败同样要释放观察。
    try {
      const record = asRecord(observation)
      if (record !== null) {
        // `observed` 置位必须早于任何字段读取：读 header 抛错时也已经欠一次 dispose。
        observed = true
        cwd = readString(asRecord(record['header']), 'cwd')
        // `projections.values.agentPreset`：投影缺失时留 `null`，由 UI 显示默认预设。
        agentPreset = readString(asRecord(asRecord(record['projections'])?.['values']), 'agentPreset')
      }
    } catch (error) {
      // 投影读失败只降级 preset，不能让整个会话解析失败（设计 6.3 的读法本就可缺省）。
      ctx.logger.warn(`dsh-skill-scope: 读取会话投影失败（sessionId=${sessionId}）：${String(error)}`)
    } finally {
      if (observed) {
        // 观察体只暴露 `[Symbol.dispose]`、没有 `.dispose()`。原先按 `.dispose()` 找，
        // 永远找不到 → 观察从不释放，每次冷读都新增一个 pinned 条目
        // （`entry.refs += 1` 只加不减），是实打实的泄漏。释放细节见 `readSymbolDispose`。
        releaseObservation(ctx, observation, sessionId)
      }
    }
  }

  const agent = asAgent(ctx.get('agents'), sessionId)

  // 两边都没下落：这是未知会话。
  if (!observed && agent === null) return null
  return {
    sessionId,
    cwd: cwd ?? agent?.session.header?.cwd ?? '',
    agentPreset,
    agent,
    live: agent !== null,
  }
}

/**
 * 调 `agents.get(sessionId)` 并做形状校验。
 * 宿主返回的对象不保证是 `AgentLike`，所以逐个检查本层用到的字段再收窄。
 *
 * **`this` 必须是 `agents` 服务本体（实测缺陷根因）**：宿主的实现是
 * `@deepseek-ai/dsh-agent/lib/index.js:594` 的
 * `get(id) { return this.store.get(id)?.agent }` —— 它要解引用 `this.store`。
 * 这里原先写成 `.call(null, sessionId)`，`this` 为 `null` 直接抛 `TypeError`，
 * 又被下面的空 `catch` 吞掉，于是**每个会话都被判定成没有 live Agent**：
 * `live` 恒为 `false`，工作区视图退化成全局清单（实测同一会话工作区返回 141 条、
 * 与 `/global` 逐条相同），用户看到的就是「skill 是所有的、没有被过滤」。
 * 因此必须像 `assembly.ts` 的 `get.call(agent.ctx, ...)` 那样把接收者传进去。
 *
 * 因此本函数收的是 **`agents` 服务本体**（而不是摘出来的方法），
 * 调用形状与 `assembly.ts` 的 `readScopedService` 一致：先 `readFunction` 取方法，
 * 再用 `.call(服务本体, …)` 调用。
 */
function asAgent(agentsService: unknown, sessionId: string): AgentLike | null {
  const get = readFunction(agentsService, 'get')
  if (get === null) return null
  let raw: unknown
  try {
    raw = get.call(agentsService, sessionId)
  } catch {
    return null
  }
  const record = asRecord(raw)
  if (record === null) return null
  const session = asRecord(record['session'])
  if (session === null || typeof record['id'] !== 'string' || typeof session['id'] !== 'string') return null
  // `ctx.get(name)` 同样必须绑定接收者：cordis 的 `ctx.get` 走 `this.registry`，
  // 丢 `this` 会抛错，而它被用来解析该 agent 自己的作用域服务
  // （`agent.ctx.get('skills')` / `('tools')`）。丢 `this` 的后果不是报错而是
  // 「取不到该 agent 的作用域层」，于是收窄写到错误的层上。与 `assembly.ts` 的
  // `readScopedService`（先 `readFunction(agentCtx, 'get')` 再 `.call(agentCtx, …)`）同一写法。
  const agentCtx = asRecord(record['ctx'])
  const ctxGet = readFunction(agentCtx, 'get')
  // **必须原样返回 `agents.get()` 的那个对象本体，不能重新造一个**（实测缺陷根因）。
  //
  // 调用方把本函数的返回值当成 `snapshot({ scope: agent })` 的 scope key 传下去，
  // 而 `@deepseek-ai/dsh-scope` 的 `scopeChainOf(key)` 直接把这个值
  // 当作 `scopeParents`（一张**以对象身份为键**的 WeakMap）的键来查父链。键在
  // `createScope(ctx, key)` 里登记（`dsh-agent-loop` 的
  // `createScope(loopCtx, this)`，`this` 即 live Agent 本体）。
  //
  // 重新造一个形状相同的对象 —— 或包一层 `Proxy` —— 都会给出**不同的对象身份**，
  // `scopeParents.get` 一律查不到，`scopeChainOf` 返回空数组，于是
  // `dsh-skill` 的 `[global, ...chainLayers(scope)]` 只剩全局层：
  // **工作区清单静默退化成未收窄的全局清单**，表现为「面板里改了开关，
  // 本会话的 skill 列表纹丝不动」。早先的写法正是重新造对象，因而丢掉了身份。
  //
  // 也不能就地改 `record` 的字段（`record['ctx'] = ...`）：那会篡改宿主的活动
  // Agent 对象，影响宿主后续对该 Agent 的所有读取。
  //
  // 所以这里只做**只读校验**：形状不对就返回 `null`（调用方退化为全局清单），
  // 形状对就把 `raw` 原样返回。`raw` 上带着 `Symbol(dsh.scope)`
  // （`ctx.extend({ [kScope]: key })`，`dsh-scope` 的 `createScope`），
  // 那正是 `chainLayers` 能解析这条链的前提。
  //
  // `id` / `session.id` 的校验必须保留：它们决定 `live` 标记与 `cwd` 兜底，
  // 而调用方只在 `view.agent !== null` 时才认「该会话是实时的」。
  if (ctxGet === null) return null
  return raw as AgentLike
}
