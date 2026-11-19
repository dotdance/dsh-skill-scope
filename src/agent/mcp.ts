import { serverNameOf } from '../inventory/mcp.ts'

/**
 * 收窄面：`restrict` 按**该 Agent 的作用域**加一层工具掩码，返回释放函数。
 * 只声明 `deny`（本插件从不使用 `allow`），保持接口最小。
 *
 * 第二个实参 `agent` 是**本插件自己加的**，不是宿主签名的一部分：
 * 宿主是 `tools.restrict(filter)`，生效层由被调用实例的 `ctx` 决定
 * （`dsh-tools` 的 `restrict(filter)` 只收一个参数）。这里多出来的 `agent` 由
 * `src/assembly.ts` 的 `makeScopedService` 消费——它拿 `agent.ctx.get('tools')`
 * 取**该 Agent 作用域**的实例再调 `restrict`，所以真正的参数解析发生在包装层。
 *
 * 因此 `agent` 保持可选只是为了让测试替身能忽略它；**生产调用点必须传**
 * （`src/agent/hooks.ts` 传的是 `scope`）。省略时 `readScopedService` 取不到
 * `agent.ctx`，`makeScopedService` 打一条 warn 并返回 no-op 句柄 —— 掩码整段不生效。
 */
export interface ScopedToolsFace {
  restrict(filter: { deny: string[] }, agent?: unknown): () => void
}

/** 一轮 MCP 限制的句柄：`key` 是当时隐藏集的规范化字符串。 */
export interface RestrictionState {
  key: string
  release: () => void
}

/**
 * 把「隐藏的 server 名」展开成**可以交给 `restrict` 的工具名**（设计 5.3）。
 *
 * 必须与 `restrictableNames` 求交，这不是保守，而是硬约束：
 * `tools.restrict()` 对任何一个未知名字都会抛
 * `tools.restrict() names unknown global tool(s) ...`（`dsh-tools/lib/index.js:2905-2906`），
 * 也就是整个收窄动作会失败、一条工具都关不掉。
 * `restrictableNames` 只含继承来的工具名——直接注册在 Agent 自己层上的工具天生不可收窄，
 * 所以这里绝不能拿「清单里有的工具名」当全集。
 *
 * 判定条件是「server 名命中隐藏集」，工具名只负责展开；升序去重保证
 * 同一隐藏集永远产出同一个数组，`key` 的比较才有意义。
 *
 * `knownServers` 是 loader 行给出的权威 server 名集合，透传给 `serverNameOf`
 * 做最长前缀匹配。**必须与 `computeHidden` 用同一个集合**：那边决定「隐藏集里有哪些
 * server 名」，这边决定「哪些工具名属于被隐藏的 server」；两边若用不同的解析口径，
 * 会出现「求值层认为某 server 被关，收窄层却展开不出它的工具」——表现为开关点了没反应。
 */
export function denyFor(
  toolNames: readonly string[],
  restrictableNames: ReadonlySet<string>,
  hiddenServers: readonly string[],
  knownServers?: ReadonlySet<string>,
): string[] {
  const hidden = new Set(hiddenServers)
  const deny = new Set<string>()
  for (const toolName of toolNames) {
    if (!restrictableNames.has(toolName)) continue
    const serverName = serverNameOf(toolName, knownServers)
    if (serverName === null || !hidden.has(serverName)) continue
    deny.add(toolName)
  }
  return [...deny].sort()
}

/**
 * 应用一轮 MCP 限制（设计 5.3）。
 *
 * `key` 相同表示「隐藏集合没变」：直接复用上一轮的句柄，**不重注册**。
 * 这不是性能优化，而是语义要求——重新 `restrict` 会追加一层新的掩码，
 * 旧层的 disposer 又掌握在别人手里，重复叠加会让释放变得不完整。
 *
 * 绝不用空数组调 `restrict`：`restrict({ deny: [] })` 会抛
 * `tools.restrict({}) is a no-op`（`dsh-tools/lib/index.js:2898`）。
 * 隐藏集为空时的正确表达是「没有任何限制」，即返回 `null` 并释放旧的。
 *
 * 本函数不重跑装配：`agent/created` 的 serial 派发已保证落地早于该 Agent 首次装配。
 */
export async function applyMcpRestriction(input: {
  tools: ScopedToolsFace
  deny: readonly string[]
  key: string
  previous: RestrictionState | null
  /**
   * 决定生效作用域的 Agent：装配层靠它取 `agent.ctx.get('tools')`（见 `ScopedToolsFace`）。
   * 生产调用点必传；测试替身可省略。
   */
  agent?: unknown
  /** 旧句柄释放失败的上报口（见 `releasePrevious`）。省略时静默吞掉。 */
  onReleaseError?: (error: unknown) => void
}): Promise<RestrictionState | null> {
  if (input.previous !== null && input.previous.key === input.key) {
    return input.previous
  }
  if (input.deny.length === 0) {
    releasePrevious(input)
    return null
  }
  /*
   * **先注册新的、再释放旧的**（顺序承重）。反过来的话，`restrict()` 抛错（它对未知
   * 工具名一律抛，见 `dsh-tools` 的 `restrict()`）时旧限制已经解除 —— 被禁工具立刻
   * 全部重新可见，而 `state.mcpKey` 仍是旧值、`mcpDispose` 仍指向**已释放**的句柄；
   * 下一轮若算出的 key 与旧 key 相同，`previous.key === key` 会直接复用这个死句柄，
   * 该 server 此后再也不会被禁。restriction 是「相交」语义，先叠一层再撤旧的等价。
   */
  const release = input.tools.restrict({ deny: [...input.deny] }, input.agent)
  releasePrevious(input)
  return { key: input.key, release }
}

/**
 * 释放旧句柄，**失败只上报、不抛**。
 *
 * `release()` 会同步 emit `tools/change`（`ScopedLayers` 的 undo 里调 `onChange()`），
 * 若某个监听器在 emit 时抛错，异常会从 `release()` 里冒出来。裸调用的话：新层已挂上、
 * 旧层已撤、`applyMcpRestriction` 却抛错 ⇒ `applyRound` 不更新 `state.mcpKey` 与
 * `mcpDispose`，状态仍指着**已死**的旧句柄 —— 这正是「先注册后释放」要消灭的那个状态，
 * 从释放这一侧重新进来。仓内 `releaseOne`（`src/agent/hooks.ts`）用的是同一口径。
 */
function releasePrevious(input: {
  previous: RestrictionState | null
  onReleaseError?: (error: unknown) => void
}): void {
  if (input.previous === null) return
  try {
    input.previous.release()
  } catch (error) {
    input.onReleaseError?.(error)
  }
}