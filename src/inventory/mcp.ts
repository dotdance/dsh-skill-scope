/**
 * MCP 清单分类（设计 4.4）。把「工具名 / 可收窄名集 / loader 已挂载的 server 名」
 * 三种原始信号，折算成面板可以直接渲染的三态：
 * 有工具且可收窄、有工具但只读（agent 自有层）、loader 挂着但尚未产出工具。
 */

import { MCP_SERVER_NAME_MAX } from '../policy/schema.ts'

/**
 * 从工具名反解 server 名。取「紧跟 `mcp__` 前缀之后的那一段」，**非贪婪**。
 *
 * 不能用「第一个 `__` 之前的文本」：工具名自身合法地包含 `__`，
 * 例如 `mcp__codegraph__codegraph_explore` 属于 server `codegraph`，
 * 而第一个 `__` 之前只有 `mcp`——那是前缀的一部分，不是 server 名。
 *
 * `dsh-tools` 的 `publicToolName` 可能因超长而加哈希后缀截断，
 * 但它始终保留 `mcp__` 前缀，所以解析入口不变。
 * 前缀缺失或 server 段形状不合法时返回 `null`，由调用方决定如何处理该名字。
 *
 * `input.knownServers` 给出**已知 server 名集合**（来自 loader 行，有权威来源）时，
 * 改为**最长前缀匹配**：这是设计 4.3 的要求。它的必要性在于 server 名允许下划线
 * （`MCP_NAME_RE` 的 `[A-Za-z0-9_-]`），所以 `mcp__` 之后「第一个 `__`」并不必然是
 * 边界——`server_na__me` 这种名字会让非贪婪正则切错。有已知集合时不需要猜：
 * 逐个比对哪个已知名真的是该工具名的前缀，取**最长**的那个。
 *
 * 没有已知集合（或集合里没有命中项）时退化为非贪婪启发式，即设计 4.3 说的
 * 「只有遇到未知 server 时才退化」。退化是**有损**的，所以调用方应当把这种情形
 * 视为诊断信号（`classifyMcp` 目前只把它当普通结果，不额外记日志）。
 */
export function serverNameOf(toolName: string, knownServers?: ReadonlySet<string>): string | null {
  if (!toolName.startsWith(MCP_PREFIX)) return null
  if (knownServers !== undefined) {
    let best: string | null = null
    for (const server of knownServers) {
      // 必须是 `mcp__<server>__` 整段前缀：只比 `server` 会让 `foo` 命中 `foobar` 的工具名。
      if (!toolName.startsWith(`${MCP_PREFIX}${server}__`)) continue
      if (best === null || server.length > best.length) best = server
    }
    if (best !== null) return best
  }
  const matched = HEURISTIC_SERVER.exec(toolName)
  const server = matched?.[1]
  if (server === undefined || server.length > MCP_SERVER_NAME_MAX) return null
  return server
}

const MCP_PREFIX = 'mcp__'
/**
 * 退化用的启发式：非贪婪取最短 server 段。
 *
 * 字符集与长度上限**从 `MCP_NAME_RE` 派生**（去掉其 `^`/`$` 锚点），
 * 这样 server 名的合法形状仍然只有一个定义处。不用 `MCP_NAME_RE.source.slice(1,-1)`
 * 再拼：那种「切字符串当正则」的写法对正则的书写形式有隐含依赖，读代码的人
 * 必须先算出切片结果才能确定这个正则匹配什么。
 */
const SERVER_SHAPE = `[A-Za-z0-9_-]{1,${MCP_SERVER_NAME_MAX}}`
const HEURISTIC_SERVER = new RegExp(`^${MCP_PREFIX}(${SERVER_SHAPE}?)__(.+)$`)

/**
 * `dsh-tools` 服务的最小面。
 * - `schemas(scope)`：某层可见的工具定义，只需要名字。
 * - `view(scope).restrictableNames`：**只含继承来的（非 agent 自有层）工具名**。
 *   直接注册在 agent 自己层上的工具永远不可被收窄，所以不能拿它当「可收窄」的全集。
 */
export interface McpToolFace {
  schemas(scope?: unknown): Array<{ name: string }>
  view(scope?: unknown): { restrictableNames: ReadonlySet<string> }
}

/** 面板渲染的一行 MCP server。 */
export interface McpRow {
  serverName: string
  toolCount: number
  /**
   * 该 server 的工具名**全量**，完整形态 `mcp__<server>__<tool>`，已去重并按名升序。
   *
   * 与 `toolCount` 是同一批名字的两种呈现：计数用于收起态的一行摘要，名单用于展开区
   * 逐条展示。**保留完整形态**而不是剥掉 `mcp__<server>__` 前缀：面板同时给出 server 名，
   * 前缀看似冗余，但用户拿这个名字去对照日志、源码与 `restrict` 报错文本时，必须是同一串字符。
   *
   * loader-only server（只配置了、没产出工具）为**空数组**，不是 `undefined`：
   * 「没有工具」是一种确定的事实，与「这个字段不存在」不该混为一谈。
   */
  toolNames: string[]
  source: 'global' | 'scope'
  /** 至少一个工具出现在 `restrictableNames` 里；为 false 时 UI 只读。 */
  restrictable: boolean
  /** `false` 表示 loader 已挂载但尚未产出任何工具（可能仍在连接/启动）。 */
  loaded: boolean
}

/**
 * 把三条原始信号折算成 server 行。
 *
 * 分组依据是 `scopeToolNames` ∪ `ownToolNames` 里能解析出的 server 名：
 * - 拥有工具的 server：`source: 'scope'`、`loaded: true`；`restrictable` 取
 *   「该 server **至少一个**工具出现在 `restrictableNames`」——用「至少一个」而不是「全部」，
 *   因为同一 server 可以同时从继承层与 agent 自有层贡献工具，只要有一条继承工具就该允许收窄。
 * - 只在 `loaderServers` 里出现、没产出任何工具的 server：补一行 `toolCount: 0`、
 *   `source: 'global'`、`restrictable: false`、`loaded: false`，让用户看见「挂了但没起来」。
 *
 * `toolCount` 按工具名去重——同一工具可能同时出现在两个入参里（继承+自有），重复计入会虚高。
 * `toolNames` 是同一批去重后的名字，供展开区逐条展示（见该字段的注释）。
 * 输出按 `serverName` 升序，保证 UI 渲染次序稳定。
 */
export function classifyMcp(input: {
  scopeToolNames: readonly string[]
  restrictableNames: ReadonlySet<string>
  loaderServers: readonly string[]
  ownToolNames?: readonly string[]
}): McpRow[] {
  const toolNamesByServer = new Map<string, Set<string>>()
  for (const toolName of [...input.scopeToolNames, ...(input.ownToolNames ?? [])]) {
    const serverName = serverNameOf(toolName)
    if (serverName === null) continue
    const bucket = toolNamesByServer.get(serverName) ?? new Set<string>()
    bucket.add(toolName)
    toolNamesByServer.set(serverName, bucket)
  }

  const rows: McpRow[] = []
  for (const [serverName, toolNames] of toolNamesByServer) {
    rows.push({
      serverName,
      toolCount: toolNames.size,
      // 排序放服务端：与下面的 `serverName` 升序同理，次序稳定由一处保证，
      // 前端不做第二份排序实现。
      toolNames: [...toolNames].sort(),
      source: 'scope',
      restrictable: [...toolNames].some((toolName) => input.restrictableNames.has(toolName)),
      loaded: true,
    })
  }

  for (const serverName of input.loaderServers) {
    if (toolNamesByServer.has(serverName)) continue
    rows.push({ serverName, toolCount: 0, toolNames: [], source: 'global', restrictable: false, loaded: false })
  }

  return rows.sort((left, right) => (left.serverName < right.serverName ? -1 : left.serverName > right.serverName ? 1 : 0))
}