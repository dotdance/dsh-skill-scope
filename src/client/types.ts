/**
 * 客户端共用的**类型叶子**。
 *
 * 这里只放类型，不放任何运行时代码：两个面板外壳（`GlobalPanel` / `WorkspaceModal`）
 * 与共享内核（`CapabilityPanel`）都要用到同一批线上形状，而它们之间的 import 方向
 * 必须是单向的 —— 让外壳互相 import 类型会成环（曾经 `WorkspaceModal` 就从
 * `GlobalPanel` 取 `WorkspaceValue`，读起来像是一个面板依赖另一个面板）。
 *
 * 这些形状与宿主 `src/routes/handlers.ts` 的返回体同形，但**不 import 宿主代码**：
 * 客户端产物与宿主是两份构建，跨端 import 会把服务端模块拖进浏览器包。
 */

/** 词条取值器。缺省实现见 `CapabilityPanel.tsx` 的 `createDefaultTranslate`。 */
export type Translate = (key: string, params?: Record<string, string>) => string

/**
 * 会话订阅钩子（槽位标准 props 的 `useSession`）。
 *
 * `index.tsx` 注册槽位、`WorkspaceModal.tsx` 消费它，两处必须是同一个类型，
 * 否则「注册时传什么」与「渲染时收到什么」无法互相校验。
 */
export type UseSessionLike = (selector: (state: { blank: boolean }) => boolean) => boolean

/** 服务端返回的一行 skill（宿主 `GroupedSkillRow`）。 */
export interface SkillRowValue {
  name: string
  description: string
  source: string
  modelInvocable: boolean
  /**
   * 来源分组的稳定 key 与显示名，**由服务端算好**（见 `src/routes/handlers.ts` 的
   * `GroupedSkillRow`）。前端不重算：路径归一化与插件名提取只该有一份实现。
   * 旧版服务端不返回这两个字段时它们是 `undefined`，卡片就退回扁平渲染。
   */
  group?: string
  groupLabel?: string
  /**
   * 真实来源（插件名或磁盘注册根绝对路径），**由服务端算好**。
   * `null` = 没有磁盘出处（runtime 注入的 skill）。旧版服务端不给这个字段时是
   * `undefined`，与 `null` 同样处理——两种情况都渲染成本地化文案，不必区分，
   * 因为用户看到的行为应当一致。
   */
  sourceLabel?: string | null
}

/** 服务端返回的一行 MCP server（宿主 `McpRow`）。 */
export interface McpRowValue {
  serverName: string
  toolCount: number
  /** 该 server 的完整工具名 `mcp__<server>__<tool>`；服务端已去重排序（`McpRow.toolNames`）。 */
  toolNames: string[]
  source: 'global' | 'scope'
  restrictable: boolean
  loaded: boolean
}

/** 一个视图里带的完整清单。 */
export interface InventoryValue {
  skills: SkillRowValue[]
  mcps: McpRowValue[]
}

/**
 * 全局层的策略形状。除两份名单外还带展示开关 `showOfficialSkills`
 * （宿主 `LayerPolicy`，见 `src/policy/schema.ts`）。
 */
export interface GlobalPolicyValue {
  mode: 'blacklist'
  skills: string[]
  mcps: string[]
  /** 面板是否展示官方（`@deepseek-ai`）基础设施 skill。缺省 `false`。 */
  showOfficialSkills: boolean
}

/** 全局路由的返回体。字段名与宿主 `GlobalValue` 逐一对应。 */
export interface GlobalValue {
  policy: GlobalPolicyValue
  revision: string | null
  inventory: InventoryValue
}

/**
 * 工作区路由的返回体。字段名与宿主 `WorkspaceValue` 逐一对应。
 *
 * **不继承 `GlobalValue`**：三态语义下它带的是两份策略（`global` + `workspace`），
 * 而不是一份「本层名单」。
 *
 * - `global`：全局层（黑名单）。只读用途，供客户端判断「这一项与全局是否不同」。
 * - `workspace`：本工程的决定（`名字 → 布尔`）。**键不存在 = 跟随全局**。
 *
 * 最终状态 = `workspace[名字] ?? !global.includes(名字)`，与服务端 `openResolver`
 * 同一公式（`src/policy/evaluate.ts`）。
 */
export interface WorkspaceValue {
  global: GlobalPolicyValue
  workspace: { skills: Record<string, boolean>; mcps: Record<string, boolean> }
  revision: string | null
  cwd: string
  policyPath: string
  exists: boolean
  /** 该会话当前是否有 live Agent。`false` ⇒ 必须显示「非实时」。 */
  live: boolean
  inventory: InventoryValue
}
