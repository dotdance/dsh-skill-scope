import type { EffectivePolicy } from '../policy/evaluate.ts'
import { hiddenNames } from '../policy/evaluate.ts'
import type { PolicyStore } from '../policy/store.ts'
import { classifyMcp, serverNameOf, type McpToolFace } from '../inventory/mcp.ts'
import { readAgentSkills, type SkillsServiceLike } from '../inventory/skills.ts'
import { applyMcpRestriction, denyFor, type RestrictionState, type ScopedToolsFace } from './mcp.ts'
import { applySkillShadow, type ScopedSkillsFace } from './skills.ts'
import { AgentStates, reground, serial, type AgentLike, type AgentState } from './state.ts'

/**
 * 事件接线（设计 5.1、v1.4 的「创建时落地 + 回合边界生效」）。
 *
 * 本层是插件的**执行入口**：把宿主事件翻成「重新求值策略 → 重算隐藏集 → 重新落地」。
 *
 * 关键时序（勿改）：
 * - 收窄动作**只在 `agent/created` 与该会话后续的清单变化时**执行；本层**不挂**
 *   `agent/pre-step` 或 `system-prompt/assemble`。`agent/created` 的 serial 派发已能保证
 *   落地早于该 Agent 首次装配，因此不需要「装配内重建 + 重跑一次装配」那条链，
 *   也不必接管装配瀑布（实测依据见 `docs/dsh-runtime-facts.md` §4）。
 * - 策略**不冻结**：每一次重新落地前都重读全局层与工作区层并重新求值。于是保存的效果
 *   落在**下一个回合边界**——当前回合已经装配完的 schema 不受影响（不变量 18）。
 */

/** Host 侧的 ctx 最小面：`on` 订阅、`effect` 纳管、`logger`、`get` 取服务。 */
export interface HookContextLike {
  on(event: string, listener: (...args: never[]) => unknown): () => void
  effect(callback: () => unknown): unknown
  get(name: string): unknown
  logger: { warn(message: string): void }
}

/** `installAgentHooks` 的依赖（v1.2：**不含 `systemPrompt`**）。 */
export interface HookDeps {
  store: PolicyStore
  states: AgentStates
  skills: SkillsServiceLike
  tools: McpToolFace
  loaderServers: () => Promise<string[]>
  /** 当前 Agent 作用域上的 skill 注册面（shadow 用）。 */
  scoped: ScopedSkillsFace
  /** 当前 Agent 作用域上的工具收窄面（restriction 用）。 */
  scopedTools: ScopedToolsFace
  logger: { warn(message: string): void }
}

/** `agent/created` 的事件负载（只用到 `agent`）。 */
interface AgentCreatedPayload {
  agent?: unknown
}

/** 收成 `AgentLike`；形状不符时返回 `null`（宿主不保证负载形状）。 */
function asAgentLike(value: unknown): AgentLike | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const session = record['session']
  if (typeof session !== 'object' || session === null) return null
  const sessionRecord = session as Record<string, unknown>
  if (typeof record['id'] !== 'string' || typeof sessionRecord['id'] !== 'string') return null
  const header = sessionRecord['header']
  const cwd =
    typeof header === 'object' && header !== null
      ? (header as Record<string, unknown>)['cwd']
      : undefined
  return {
    id: record['id'],
    ctx: record['ctx'] as AgentLike['ctx'],
    session: {
      id: sessionRecord['id'],
      ...(typeof cwd === 'string' ? { header: { cwd } } : {}),
    },
    // **必须原样保留宿主对象本体**：`dsh-scope` 的层查找（`peek(scope)` /
    // `scopeChainOf(key)` 的 `scopeParents` WeakMap）全部**按对象身份**索引。
    // 上面造的 `{ id, ctx, session }` 是**新对象**，虽字段相同却 `!==` 本体，
    // 拿它当 `snapshot({ scope })` 会查不到 agent 层，只落到全局层——
    // 于是**每个被遮蔽的名字都读回 `modelInvocable: true`**（实测 137 个全部误报）。
    raw: value,
  }
}

/** 取该 Agent 的 cwd；缺失或空串时返回 `null`（调用方 warn 后放弃本轮）。 */
function cwdOf(agent: AgentLike): string | null {
  const cwd = agent.session.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

/**
 * 重读两层策略、求值、并写入状态（策略不冻结，见文件头）。
 *
 * 工作区策略读不出来（例如 cwd 下没有文件）时用 `EMPTY_POLICY`——「没有工作区策略」
 * 的正确语义就是「不进一步收窄」，而不是「保持上一次的值」。
 */
async function evaluate(deps: HookDeps, agent: AgentLike): Promise<EffectivePolicy> {
  const cwd = cwdOf(agent)
  const global = await deps.store.loadGlobal()
  if (cwd === null) return { global: global.policy, workspace: null }
  const workspace = await deps.store.loadWorkspace(cwd)
  return { global: global.policy, workspace: workspace.policy }
}

/**
 * 读当前清单并算隐藏集。
 *
 * `complete !== true` 是**承重判断**：服务没能枚举完整时清单是残缺的，
 * 用它去重算隐藏集会把「本来关着的名字」当成「清单里不存在」而悄悄放行。
 * 所以这里返回 `null` 让调用方放弃本轮，绝不降级成「按残缺清单执行」。
 */
async function computeHidden(
  deps: HookDeps,
  agent: AgentLike,
  effective: EffectivePolicy,
): Promise<{
  hidden: { skills: string[]; mcps: string[]; key: string }
  toolNames: string[]
  knownServers: ReadonlySet<string>
} | null> {
  const cwd = cwdOf(agent)
  // 这里传的是 `agent`（可能是 `asAgentLike` 造的替身，不是宿主本体）。**本处无害**，
  // 但依赖一条容易失效的性质：`dsh-skill` 的 `collectFresh` 是
  // `[layers.global, ...chainLayers(options.scope)]`，全局层**永远先并入**，
  // 所以**名字集合不随 `scope` 变**，变的只有 `invocation` 标记；而 `hiddenNames`
  // 只吃名字 ⇒ 结果不受影响。实测（3150 实例，两种 scope 各读一次）：
  //   `[NS] standIn=141 raw=141 onlyStandIn=0 onlyRaw=0 same=true`
  // 若哪天改成按 `modelInvocable` 判定，这里就必须像复验那样传 `agent.raw`
  // （对象身份索引，见 `src/agent/skills.ts` 复验段注释）。
  //
  // `showOfficialSkills: true` 是**承重**的，不是"顺手取全量"：掩蔽集是
  // 「清单 − 允许集」反推出来的，清单里没有的名字永远不会被遮蔽。用户在面板上
  // 打开过「显示官方 Skill」并关掉某条官方 skill 之后，即使把开关关回去，
  // 那条决定仍然有效——所以这里必须始终按全量清单求值。面板展示口径的过滤
  // 只发生在路由层（`src/routes/handlers.ts`）。
  const inventory = await readAgentSkills(deps.skills, agent, cwd ?? '', { showOfficialSkills: true })
  if (inventory.complete !== true) {
    deps.logger.warn(
      `dsh-skill-scope: skill 清单不完整（incomplete），本轮不改变收窄状态（agent=${agent.id}）`,
    )
    return null
  }
  const toolNames = deps.tools.schemas(agent).map((schema) => schema.name)
  // loader 行给出的 server 名是**权威命名来源**（用户配了什么就是什么），
  // 用它做最长前缀匹配，避免全靠启发式切分。`loaderServers` 读不到时返回空集，
  // `serverNameOf` 会退化为启发式（见其注释），此时行为与旧版一致。
  const knownServers = new Set(await deps.loaderServers())
  const hidden = hiddenNames(
    { skills: inventory.rows.map((row) => row.name), mcps: toolNames.map((name) => serverNameOrTool(name, knownServers)) },
    effective,
  )
  return { hidden, toolNames, knownServers }
}

/**
 * MCP 隐藏集的口径转换：`hiddenNames` 吃的是 **server 名**，
 * 而工具名单是 `mcp__<server>__<tool>`。这里把工具名折成它所属的 server 名，
 * 使求值层与 UI 层（`classifyMcp` 也是按 server 名收窄）口径一致。
 *
 * **复用 `serverNameOf`，不再在这里手写一份正则**：本函数原先自带
 * `/^mcp__([A-Za-z0-9_-]{1,32}?)__/`，与 `inventory/mcp.ts` 的那份重复，
 * 且把 32 这个数字又写了一遍。两份实现一旦分叉，UI 分组与收窄判定会按不同的
 * server 名行事——同一台 server 在一处算「codegraph」、在另一处算别的名字。
 *
 * 传 `knownServers`（loader 行给出的权威 server 名集合）以获得最长前缀匹配；
 * 解析不出 server 的裸工具名原样保留（它们不会被任何 server 名命中）。
 */
function serverNameOrTool(toolName: string, knownServers: ReadonlySet<string>): string {
  return serverNameOf(toolName, knownServers) ?? toolName
}

/**
 * 落地一轮收窄：先 shadow，再 restriction，并把 disposer 记进状态。
 *
 * 两件事都经 `serial` 串行，避免同一 Agent 的两个触发源交叉注册；
 * shadow 的成功名单只在 `applied` 非空时替换 `skillDispose`（`null` 释放器表示「本轮没有任何遮蔽」）。
 */
async function applyRound(
  deps: HookDeps,
  state: AgentState,
  hidden: { skills: string[]; mcps: string[]; key: string },
  toolNames: readonly string[],
  knownServers: ReadonlySet<string>,
  isActive: () => boolean = () => true,
): Promise<void> {
  const cwd = cwdOf(state.agent) ?? ''
  const chain = serial()

  // ── Skill 侧：key 未变则不动（差分维护，不变量 23）。
  //
  // **不要把这次调用再套一层 `chain(...)`**：`applySkillShadow` 自己就会用传进去的
  // `serial` 包住函数体。外面再包一次，同一个链上就会出现「操作排在自己后面」的自锁，
  // promise 永不 resolve（挂起时症状是测试超时，而不是报错）。
  const skillKey = hidden.skills.join(',')
  if (skillKey !== state.skillKey) {
    const result = await applySkillShadow({
      skills: deps.skills as never,
      scoped: {
        // 异步定义读取结束前 Agent 可能已卸载；禁止后续注册产生残留。
        register: (definition, agent) => isActive() ? deps.scoped.register(definition, agent) : () => {},
      },
      cwd,
      agent: state.agent,
      hidden: hidden.skills,
      serial: chain,
      logger: deps.logger,
      // 落地后回读复验：发现漏网只记 warning，**不回滚、不抛错**。
      // 抛错会冒到本文件的 catch 而 fail-open ⇒ **一个 skill 都关不上**，
      // 所以失败降级为警告、保留其余生效项。详见 `src/agent/skills.ts` 的复验段注释。
      verifyStillVisible: true,
      // 复验必须用**宿主本体**当 scope：`dsh-scope` 按对象身份查层，
      // 替身查不到 agent 层。详见 `src/agent/skills.ts` 复验段注释。
      scopeOf: state.agent.raw ?? state.agent,
      ...(state.skillDispose === null ? {} : { previous: state.skillDispose }),
    })
    if (!isActive()) {
      releaseOne(deps, 'skill shadow', result.release)
      return
    }
    state.skillDispose = result.release
    state.skillKey = skillKey
  }

  // ── MCP 侧：隐藏的 server 名展开成可收窄工具名后比较 key。
  // `applyMcpRestriction` **不**接收 `serial`，所以这次必须由本层串行化。
  if (!isActive()) return
  const restrictable = deps.tools.view(state.agent).restrictableNames
  // 与 `computeHidden` 同一个 `knownServers`（本函数由它算出隐藏集后调用），
  // 两边口径必须一致，否则会出现「隐藏集里有这个 server，却展开不出它的工具」。
  const deny = denyFor(toolNames, restrictable, hidden.mcps, knownServers)
  const mcpKey = `${hidden.mcps.join(',')}|deny=${deny.join(',')}`
  if (mcpKey !== state.mcpKey) {
    const next = await chain(() =>
      applyMcpRestriction({
        tools: deps.scopedTools,
        deny,
        key: mcpKey,
        previous: mcpRestrictionOf(state),
        agent: state.agent,
      }),
    )
    if (!isActive()) {
      releaseOne(deps, 'mcp restriction', next?.release ?? null)
      return
    }
    state.mcpKey = mcpKey
    state.mcpDispose = next === null ? null : next.release
  }
}

/**
 * 把状态里存的释放函数重新包成 `RestrictionState`。
 * `applyMcpRestriction` 的 `previous` 需要 `{key, release}`；状态只存了 key 与 release，
 * 两者拼回去即可（`key` 用于「相同则直接复用」的判定）。
 */
function mcpRestrictionOf(state: AgentState): RestrictionState | null {
  if (state.mcpDispose === null) return null
  return { key: state.mcpKey, release: state.mcpDispose }
}

/** 释放一个状态上剩下的 list shadow 与 restriction；任何失败只 warn。 */
function releaseState(deps: HookDeps, state: AgentState): void {
  releaseOne(deps, 'skill shadow', state.skillDispose)
  releaseOne(deps, 'mcp restriction', state.mcpDispose)
  state.skillDispose = null
  state.mcpDispose = null
  state.skillKey = ''
  state.mcpKey = ''
}

/** 释放单个 disposer；`null` 表示本轮没有落地任何东西，直接跳过。 */
function releaseOne(deps: HookDeps, label: string, dispose: (() => void) | null): void {
  if (dispose === null) return
  try {
    dispose()
  } catch (error) {
    deps.logger.warn(`dsh-skill-scope: 释放 ${label} 失败：${String(error)}`)
  }
}

/**
 * 装好四件监听器并返回停止函数与「保存后重新落地」入口。
 *
 * 注册的事件（**只有这四个**，见文件头）：
 * - `agent/created`：创建时落地。整个函数体包 try/catch —— 该事件是 serial 派发的，
 *   监听器抛错**会让会话创建失败**，所以任何异常都必须降级成「本会话按空策略运行」+ warn。
 * - `agent/disposed`：释放该会话的全部 shadow/restriction 并摘掉状态（不变量 15）。
 * - `skills/change` / `tools/change`：清单变化时**先重读策略**（v1.4：跨回合重读，不冻结），
 *   再按差分重算对应一侧。名称用**斜杠**，与宿主的 `emit` 逐字一致（见下方注册处的注释）。
 *
 * 返回值同时经 `ctx.effect` 纳管：插件卸载时释放全部存活状态。
 *
 * **`reapply` 是第五条路径，且不经事件（承重）**：策略保存走 `Store` 的 `fs.writeFile`，
 * 既不触碰 Skill 注册表也不触碰 Tool 注册表，因此**不会**发出 `skills/change` /
 * `tools/change`——保存这个动作在事件面**没有任何监听者**。设计 `docs/design.md` §3.7
 * 写明的「策略变化由保存驱动」这条边必须由路由层**显式调用** `reapply` 补齐，
 * 否则同一会话里改策略只有等新会话才生效（用户实测缺陷）。
 * 它复用 `onChange`：行为与「清单变化」完全一致（重读策略 → 差分重算 → 只动变化的那一侧）。
 */
export function installAgentHooks(
  ctx: HookContextLike,
  deps: HookDeps,
): { stopAll: () => void; reapply: () => Promise<void> } {
  /** 每个 Agent 一条串行链，保证「创建」与「清单变化」不交叉。 */
  const chains = new Map<string, <T>(operation: () => Promise<T>) => Promise<T>>()
  const chainFor = (agentId: string): (<T>(operation: () => Promise<T>) => Promise<T>) => {
    const existing = chains.get(agentId)
    if (existing !== undefined) return existing
    const chain = serial()
    chains.set(agentId, chain)
    return chain
  }

  interface ApplyState {
    applying: boolean
    pending: boolean
    disposed: boolean
  }
  let stopped = false
  const applyStates = new Map<string, ApplyState>()
  const applyStateFor = (agentId: string): ApplyState => {
    const existing = applyStates.get(agentId)
    if (existing !== undefined) return existing
    const created = { applying: false, pending: false, disposed: false }
    applyStates.set(agentId, created)
    return created
  }

  const drainAgent = async (state: AgentState, schedule: ApplyState, source: string): Promise<void> => {
    if (schedule.disposed || schedule.applying || stopped) return
    schedule.applying = true
    const isActive = (): boolean => !stopped && !schedule.disposed
    // 持续不完整的 provider 不得让 agent/created 永久挂起；一次有限重读后等后续通知。
    let retriedIncomplete = false
    try {
      do {
        schedule.pending = false
        try {
          await chainFor(state.agent.id)(async () => {
            const effective = await evaluate(deps, state.agent)
            if (!isActive()) return
            const computed = await computeHidden(deps, state.agent, effective)
            if (!isActive()) return
            if (computed === null) {
              if (!retriedIncomplete) {
                retriedIncomplete = true
                schedule.pending = true
              }
              return
            }
            reground(state, effective)
            const previousSkillKey = state.skillKey
            const previousMcpKey = state.mcpKey
            await applyRound(deps, state, computed.hidden, computed.toolNames, computed.knownServers, isActive)
            // 注册会改变宿主 revision。即使未收到通知，也在落地后重新读一次完整清单。
            if (previousSkillKey !== state.skillKey || previousMcpKey !== state.mcpKey) schedule.pending = true
          })
        } catch (error) {
          ctx.logger.warn(`dsh-skill-scope: ${source} 落地失败（agent=${state.agent.id}）：${String(error)}`)
        }
      } while (schedule.pending && isActive())
    } finally {
      schedule.applying = false
    }
  }

  const requestAgentApply = (state: AgentState, source: string): Promise<void> => {
    const applyState = applyStateFor(state.agent.id)
    if (stopped || applyState.disposed) return Promise.resolve()
    applyState.pending = true
    return applyState.applying ? Promise.resolve() : drainAgent(state, applyState, source)
  }

  const onCreated = async (payload: AgentCreatedPayload): Promise<void> => {
    if (stopped) return
    const agent = asAgentLike(payload?.agent)
    if (agent === null) {
      ctx.logger.warn('dsh-skill-scope: agent/created 负载形状不符，跳过落地')
      return
    }
    if (cwdOf(agent) === null) {
      ctx.logger.warn(`dsh-skill-scope: agent/created 缺少 cwd，跳过落地（agent=${agent.id}）`)
      return
    }
    const state = deps.states.ensure(agent)
    await requestAgentApply(state, 'agent/created')
  }

  const onDisposed = (value: unknown): void => {
    const agent = asAgentLike(value)
    if (agent === null) return
    const applyState = applyStates.get(agent.id)
    if (applyState !== undefined) {
      applyState.disposed = true
      applyState.pending = false
    }
    const state = deps.states.get(agent.id)
    if (state === undefined) return
    releaseState(deps, state)
    deps.states.delete(agent.id)
    chains.delete(agent.id)
    applyStates.delete(agent.id)
  }

  const onChange = async (): Promise<void> => {
    await Promise.all(deps.states.ids().flatMap((agentId) => {
      const state = deps.states.get(agentId)
      return state === undefined ? [] : [requestAgentApply(state, '清单变化后重新')]
    }))
  }

  const offCreated = ctx.on('agent/created', onCreated as never)
  const offDisposed = ctx.on('agent/disposed', onDisposed as never)
  // 事件名**必须带斜杠**：宿主发出的是 `skills/change`（`dsh-skill` 的 `notifyChange()`）
  // 与 `tools/change`（`dsh-tools` 的 `ScopedLayers` 变更回调）。cordis 的 `EventsService`
  // 用事件名做**精确字符串键**（`on()` 写 `_hooks[name]`、`dispatch()` 读 `_hooks[name]`，
  // 无任何归一化），所以写成点号的 `skills.change` **不会报错、也永远不会被调用**。
  const offSkills = ctx.on('skills/change', onChange as never)
  const offTools = ctx.on('tools/change', onChange as never)

  /**
   * 释放全部存活状态（插件卸载）。
   *
   * **必须同时退订四个监听器**：`ctx.on` 的返回值是退订函数，不退订就是监听器泄漏——
   * 下次 `agent/created` 会同时跑新旧两份执行层，收窄被叠加两次。
   * 宿主自身的 ctx 生命周期可能顺带清掉监听器，但本函数是设计里承诺的释放点，
   * 不能依赖宿主代劳（设计不变量 15：卸载不留残留）。
   *
   * 每个退订各自 try/catch：一个失败不影响其余，也不影响 `chains.clear()`。
   */
  const stopAll = (): void => {
    if (stopped) return
    stopped = true
    for (const schedule of applyStates.values()) {
      schedule.disposed = true
      schedule.pending = false
    }
    for (const off of [offCreated, offDisposed, offSkills, offTools]) {
      try {
        off()
      } catch (error) {
        ctx.logger.warn(`dsh-skill-scope: 退订监听器失败：${String(error)}`)
      }
    }
    for (const agentId of deps.states.ids()) {
      const state = deps.states.get(agentId)
      if (state !== undefined) releaseState(deps, state)
      deps.states.delete(agentId)
    }
    chains.clear()
    applyStates.clear()
  }

  // `ctx.effect` 的契约是「回调返回释放函数」，所以传 `stopAll` 本身即可，
  // 不必再包一层 `() => stopAll` 的同义包装。
  ctx.effect(() => stopAll)
  return { stopAll, reapply: onChange }
}
