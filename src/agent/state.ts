import type { EffectivePolicy } from '../policy/evaluate.ts'

/**
 * 执行层看到的 Agent 最小面（设计 5.1）。
 * 刻意只声明本层真正用到的三个成员，避免把 `dsh-agent` 的具体实现拉进类型依赖。
 */
export interface AgentLike {
  id: string
  ctx: { get(name: string): unknown }
  session: { id: string; header?: { cwd?: string } }
  /**
   * 宿主的原始 Agent 对象本体（由 `asAgentLike` 原样保存）。
   *
   * **承重字段，不能删**：`dsh-scope` 的层查找按**对象身份**索引
   * （`peek(scope)` 用 `this.scoped.get(scope)`；`scopeChainOf(key)` 用 `scopeParents`
   * WeakMap）。`asAgentLike` 返回的是新造的 `{ id, ctx, session }`，字段相同但
   * `!==` 本体；拿它当 `snapshot({ scope })` 会查不到 agent 层，退化成只读全局层，
   * 于是**每个已遮蔽的名字都读回 `modelInvocable: true`**（实测 137 个全部误报
   * 为「漏网」）。要读 agent 层，必须传这个本体。
   *
   * 测试替身可以省略；省略时读取方退回用替身自身。
   */
  raw?: unknown
}

/** 一个 Agent 的执行层状态（设计 5.1）。 */
export interface AgentState {
  agent: AgentLike
  /** 当前生效的两层策略；装配前为 `null`。 */
  policy: EffectivePolicy | null
  /** 上一轮 skill 阴影对应的隐藏集 `key`；空串表示尚未装配。 */
  skillKey: string
  /** 上一轮 MCP 限制对应的隐藏集 `key`；空串表示尚未装配。 */
  mcpKey: string
  /** 上一轮 skill 阴影的释放函数。 */
  skillDispose: (() => void) | null
  /** 上一轮 MCP 限制的释放函数。 */
  mcpDispose: (() => void) | null
}

/**
 * 按 Agent id 归档的执行层状态（设计 5.1）。
 * 用对象实例持有 Map 而非模块级单例：宿主可以按 profile 建多份，测试也能互不干扰。
 */
export class AgentStates {
  private readonly byId = new Map<string, AgentState>()

  /** 幂等：同一个 Agent（同对象或同 id）永远拿到同一个状态。 */
  ensure(agent: AgentLike): AgentState {
    const existing = this.byId.get(agent.id)
    if (existing !== undefined) return existing
    const state: AgentState = {
      agent,
      policy: null,
      skillKey: '',
      mcpKey: '',
      skillDispose: null,
      mcpDispose: null,
    }
    this.byId.set(agent.id, state)
    return state
  }

  get(agentId: string): AgentState | undefined {
    return this.byId.get(agentId)
  }

  delete(agentId: string): AgentState | undefined {
    const state = this.byId.get(agentId)
    if (state === undefined) return undefined
    this.byId.delete(agentId)
    return state
  }

  ids(): string[] {
    return [...this.byId.keys()]
  }
}

/**
 * 用最新求值出的策略覆盖状态（设计 v1.4）。
 *
 * 策略**不冻结**：无论这次是首次装配还是任何一次变更通知，调用方都会重新读取
 * 全局层与工作区层并求值，然后在这里无条件覆盖。因此不存在「首个快照获胜」的规则——
 * 一次保存会重新接地所有存活 Agent，变化在下一个回合边界生效。
 */
export function reground(state: AgentState, policy: EffectivePolicy): void {
  state.policy = policy
}

/**
 * 建一条按提交顺序执行的串行链（设计 5.1）。
 *
 * 每个操作都接在同一条 `tail` 之后，`finally` 里释放。释放用的是「忽略结果的续接」，
 * 因此某个操作 reject 不会把链打断——后续操作照常排在前一个的 `finally` 之后执行。
 */
export function serial(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation)
    // 链尾吞掉结果与错误，只保留「前一个已完成」这一事实；调用方拿到的仍是 result 本身。
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}