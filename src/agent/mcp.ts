import { serverNameOf } from '../inventory/mcp.ts'

/**
 * 收窄面：`restrict` 按**该 Agent 的作用域**加一层工具掩码，返回释放函数。
 * 只声明 `deny`（本插件从不使用 `allow`），保持接口最小。
 *
 * `agent` 与 `ScopedSkillsFace.register` 同理是**必需的第二实参**：`tools.restrict()`
 * 的生效层由被调用实例的 ctx 决定，真实装配传入的代理按 agent 惰性解析
 * `agent.ctx.get('tools')`。替身可忽略该参数。
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
  /** 决定生效作用域的 Agent；真实代理靠它取 `agent.ctx.get('tools')`。替身可忽略。 */
  agent?: unknown
}): Promise<RestrictionState | null> {
  if (input.previous !== null && input.previous.key === input.key) {
    return input.previous
  }
  input.previous?.release()
  if (input.deny.length === 0) return null
  const release = input.tools.restrict({ deny: [...input.deny] }, input.agent)
  return { key: input.key, release }
}