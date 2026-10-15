import { PolicyStore as Store, type LockLike, type PolicyStore } from './policy/store.ts'
import { AgentStates } from './agent/state.ts'
import { installAgentHooks, type HookContextLike, type HookDeps } from './agent/hooks.ts'
import type { SkillsServiceLike } from './inventory/skills.ts'
import type { ScopedSkillsFace } from './agent/skills.ts'
import type { ScopedToolsFace } from './agent/mcp.ts'
import type { McpToolFace } from './inventory/mcp.ts'
import { registerRoutes, type FetchRegisterFace } from './routes/register.ts'
import type { RouteDeps } from './routes/handlers.ts'
import { asRecord, readFunction } from './shared/unknown.ts'

/**
 * Host 半边的装配（设计 5.3 / 6.1 / 8.5）。
 *
 * ## 为什么单独一个模块，而不是全塞进 `src/index.ts`
 *
 * `src/index.ts` 的 `apply()` 拿到的 `Context` 是 cordis 的服务注入代理：
 * 读一个未在 `inject` 声明的服务属性会**抛错**，`ctx.get(name)` 才是可选依赖的读法。
 * 这里把「怎么从宿主 ctx 取服务」全部收在一个函数里，剩下四个模块
 * （policy / inventory / agent / routes）都只依赖**结构性最小面**，
 * 于是它们既能在真实宿主里跑，也能被纯对象替身直接驱动（现有单测就是这么做的）。
 *
 * ## 装配顺序（有依赖，勿打乱）
 *
 * 1. 先建 `PolicyStore` 与 `AgentStates`：两者都是纯内存对象，不读服务。
 * 2. 再装 Agent 钩子（`installAgentHooks`）：它要订 `agent/created`、`agent/disposed`、
 *    `skills/change`、`tools/change` 四个事件（后两个是**斜杠**，与宿主 emit 一致）。
 * 3. 最后注册路由：**用可选嵌套注入**（`ctx.inject(['connection'], …)`）。
 *    headless profile 没有 `connection` 时只跳过路由（设计 6.1），策略照旧生效。
 *
 * ## 设计依据
 *
 * - `inject = ['skills','tools','agents']` 是**硬依赖**：清单与执行都取不到替代（设计 5.1）。
 * - `connection` / `sessionQuery` / `agentPresets` 都是**可选**：缺了只降级对应功能。
 */

/** 取服务的函数面（cordis `ctx.get`）。 */
export interface ServiceGetter {
  get(name: string): unknown
}

/** 装配所需的宿主 ctx 最小面。**只声明本模块真正调用的成员。** */
export interface AssemblyContext extends ServiceGetter {
  on(event: string, listener: (...args: never[]) => unknown): () => void
  effect(callback: () => unknown): unknown
  inject(names: readonly string[], callback: () => void): void
  logger: { info(message: string): void; warn(message: string): void }
}

/**
 * 读 `loader` 行里配置的 MCP server 名（设计 4.3，**只读**）。
 *
 * 依据：loader 行里 `options.name === '@deepseek-ai/dsh-mcp-client'` 的
 * `options.config.serverName`。这能覆盖「已配置但没有产出任何工具」的 server
 * （典型是启动失败），它们只能只读展示、不可 `restrict`。
 *
 * 失败一律返回空数组：loader 不可读时清单里少几行只读项，不影响可关闭项的正确性；
 * 但**绝不能**因为读不到 loader 就抛错，那会让整条路由失败。
 */
export function readLoaderServers(getter: ServiceGetter): () => Promise<string[]> {
  return async (): Promise<string[]> => {
    try {
      const loader = getter.get('loader')
      const entries = readFunction(loader, 'entries')
      if (entries === null) return []
      const rows = entries.call(loader) as unknown
      if (rows === null || typeof rows !== 'object' || typeof (rows as Iterable<unknown>)[Symbol.iterator] !== 'function') {
        return []
      }
      const names: string[] = []
      for (const entry of rows as Iterable<unknown>) {
        const options = asRecord(asRecord(entry)?.['options'])
        if (options === null) continue
        if (options['name'] !== '@deepseek-ai/dsh-mcp-client') continue
        const config = asRecord(options['config'])
        const serverName = config?.['serverName']
        if (typeof serverName === 'string' && serverName !== '') names.push(serverName)
      }
      return names
    } catch {
      // loader 不可读只少几行只读项，不影响可关闭项的正确性；绝不抛错。
      return []
    }
  }
}

/**
 * 取 `fetch.register` 面（设计 6.1）。
 *
 * `connection` 是可选服务：headless profile 里没有它。**用 `ctx.get` 读**，
 * 不能读属性（未声明的服务属性会抛错）。拿不到就返回 `null`，路由整体跳过。
 */
export function readFetchRegister(ctx: AssemblyContext): FetchRegisterFace | null {
  const connection = asRecord(ctx.get('connection'))
  if (connection === null) return null
  const fetchFace = asRecord(connection['fetch'])
  if (fetchFace === null) return null
  const register = readFunction(fetchFace, 'register')
  if (register === null) return null
  return {
    register: (spec) => register.call(fetchFace, spec) as () => unknown,
  }
}

/**
 * 造一个**按 Agent 惰性解析作用域**的服务面代理（skill 注册面与工具收窄面同形）。
 *
 * 为什么必须是代理而不能一次性取好：`dsh-skill` 的 `register()` 用 `scopeOf(this.ctx)`
 * 决定落到哪一层（`dsh-skill/lib/index.js:195`）。作用域由**被调用的服务实例**决定，
 * 因此只有 `agent.ctx.get('skills')` 取到的实例才是该 Agent 的作用域层。
 * 注册期还不知道会是哪个 agent，所以这里把解析推迟到每次调用。
 *
 * skill 侧调 `register(skill)`、工具侧调 `restrict({ deny })`，两者除了服务名与方法名
 * 之外**逐段相同**（连两条 fail-open 警告的措辞都对齐），所以用一份实现参数化：
 * 两份副本一旦分叉，会出现「skill 落不下去但工具收窄安静地落到错的层」这类只在一侧复现的缺陷。
 *
 * 取不到 agent 作用域服务时返回 no-op disposer 并记 warning：
 * 落地失败是功能降级，但**绝不能**让 `agent/created` 的监听器抛错
 * （该事件的监听器抛错会让会话创建失败）。
 */
function makeScopedService(
  logger: { warn(message: string): void },
  serviceName: string,
  methodName: string,
): (argument: unknown, agent?: unknown) => () => void {
  return (argument, agent) => {
    const target = readScopedService(agent, serviceName)
    if (target === null) {
      logger.warn(
        `dsh-skill-scope: 取不到 agent 作用域的 ${serviceName} 服务，本轮 ${serviceName} 变更未落地（fail-open）`,
      )
      return () => {}
    }
    const method = readFunction(target, methodName)
    if (method === null) {
      logger.warn(
        `dsh-skill-scope: agent 作用域的 ${serviceName} 服务没有 ${methodName}，本轮变更未落地（fail-open）`,
      )
      return () => {}
    }
    const dispose = method.call(target, argument) as unknown
    return typeof dispose === 'function' ? (dispose as () => void) : () => {}
  }
}

/** skill 注册面（`register(skill, agent)`）。 */
function makeScopedSkills(logger: { warn(message: string): void }): ScopedSkillsFace {
  const register = makeScopedService(logger, 'skills', 'register')
  return { register }
}

/** MCP 收窄面（`restrict({ deny }, agent)`），与 skill 侧同形。 */
function makeScopedTools(logger: { warn(message: string): void }): ScopedToolsFace {
  const restrict = makeScopedService(logger, 'tools', 'restrict')
  return { restrict }
}

/**
 * 从 agent 的 ctx 取一个服务实例。
 * `agent` 形状不符（缺 `ctx.get`）时返回 `null`，由调用方降级。
 */
function readScopedService(agent: unknown, serviceName: string): unknown {
  const agentCtx = asRecord(agent)?.['ctx']
  const get = readFunction(agentCtx, 'get')
  if (get === null) return null
  try {
    // `ctx.get` 必须绑定接收者：cordis 的实现走 `this.registry`，丢 `this` 会抛错。
    return get.call(agentCtx, serviceName)
  } catch {
    return null
  }
}

/** 装配的产物，便于测试与调用方复用。 */
export interface Assembly {
  store: PolicyStore
  states: AgentStates
  disposeHooks: () => void
  disposeRoutes: () => void
  /**
   * 「策略保存后对该会话立刻重新落地」入口（设计 `docs/design.md` §3.7「保存驱动」那条边）。
   *
   * 保存走 `fs.writeFile`，不发 `skills/change` / `tools/change`，所以这条路径**必须**由
   * 保存成功的一方显式调用；否则同一会话里改策略只有等新会话才生效（用户实测缺陷）。
   * 实现方（路由）必须吞掉它的异常并 warn：重新落地是**尽力而为**的收敛动作，
   * 绝不能因为它的异常把「策略已成功写入磁盘」这个事实回报成保存失败。
   */
  reapplyAfterSave: () => Promise<void>
}

/** `assemble` 的可注入依赖；缺省时用真实实现。生产只传 `ctx`。 */
export interface AssembleDeps {
  store?: PolicyStore
  lock?: LockLike
}

/**
 * 装配 Host 半边。返回可释放的句柄（`disposeHooks` / `disposeRoutes`）。
 *
 * **失败一律 fail-open**：任一可选环节（loader / connection / sessionQuery）不可用时
 * 只降级该环节并记 warning，绝不让插件加载失败——否则一个诊断信息会把整个 harness 拖下水。
 * 唯一允许抛错的是硬依赖缺失（`skills` / `tools` / `agents`），那由 `inject` 保证不会发生。
 */
export function assemble(ctx: AssemblyContext, deps: AssembleDeps = {}): Assembly {
  const store = deps.store ?? new Store({ logger: ctx.logger, ...(deps.lock === undefined ? {} : { lock: deps.lock }) })
  const states = new AgentStates()

  const skills = ctx.get('skills') as SkillsServiceLike | undefined
  const tools = ctx.get('tools') as McpToolFace | undefined

  // 硬依赖缺失时只记 warning 并继续：`inject` 已保证它们到场，
  // 但测试替身与未来的降级 profile 可能不带，此处不抛错（fail-open）。
  const safeSkills: SkillsServiceLike = skills ?? { snapshot: async () => ({ skills: [], complete: false }) }
  const safeTools: McpToolFace = tools ?? { schemas: () => [], view: () => ({ restrictableNames: new Set<string>() }) }

  const loaderServers = readLoaderServers(ctx)

  // --- Agent 钩子（设计 5.3：只在 agent/created 与清单变化时落地） ---
  const hookCtx: HookContextLike = {
    on: (event, listener) => ctx.on(event, listener as (...args: never[]) => unknown),
    effect: (callback) => ctx.effect(callback),
    get: (name) => ctx.get(name),
    logger: ctx.logger,
  }
  const hookDeps: HookDeps = {
    store,
    states,
    skills: safeSkills,
    tools: safeTools,
    loaderServers,
    // 两个 scoped 面都**按 agent 惰性解析**：作用域由被调用的服务实例决定，
    // 注册期还不知道 agent，见 makeScopedSkills 的说明。
    scoped: makeScopedSkills(ctx.logger),
    scopedTools: makeScopedTools(ctx.logger),
    logger: ctx.logger,
  }
  const disposeHooks = installAgentHooks(hookCtx, hookDeps)

  /**
   * 保存后重新落地的**尽力而为**包装。
   *
   * 为什么在这里兜底而不是让路由自己 try/catch：两个保存路由（global / workspace）
   * 都需要同一份语义，漏掉一处就会让「保存成功但没生效」重新出现。失败只 warn：
   * 策略**已经**写进磁盘了，把重新落地的异常上报成保存失败会让用户重试，
   * 而重试的是同一个已经成功的写入。
   */
  const reapplyAfterSave = async (): Promise<void> => {
    try {
      await disposeHooks.reapply()
    } catch (error) {
      ctx.logger.warn(`dsh-skill-scope: 保存后重新落地失败（策略已写入，下一回合重试）：${String(error)}`)
    }
  }

  // --- 路由（设计 6.1：connection 可选嵌套注入） ---
  const routeDeps: RouteDeps = {
    store,
    states,
    skills: safeSkills,
    tools: safeTools,
    loaderServers,
    logger: ctx.logger,
    // `resolveSession` 只需 `get` + `logger.warn`；`AssemblyContext` 两者都有，
    // 因此 `ctx` 本身就直接满足该接口，不必再包一层转发对象。
    ctx,
    // 保存路由在写入成功后调用它，补齐设计 `docs/design.md` §3.7 那条「策略变化由保存驱动」的边。
    reapplyAfterSave,
  }

  let disposeRoutes: () => void = () => {}
  ctx.inject(['connection'], () => {
    const fetchRegister = readFetchRegister(ctx)
    if (fetchRegister === null) {
      ctx.logger.warn(`dsh-skill-scope: connection 服务在册但没有 fetch.register，路由未注册（策略仍生效）`)
      return
    }
    disposeRoutes = registerRoutes(ctx, routeDeps, fetchRegister)
  })

  return { store, states, disposeHooks: disposeHooks.stopAll, disposeRoutes, reapplyAfterSave }
}
