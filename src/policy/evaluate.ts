import type { LayerPolicy } from './schema.ts'
import type { Domain, WorkspacePolicy } from './workspace-schema.ts'

/**
 * 一个会话实际生效的两层策略（设计 4.2）。
 *
 * 两层形状**不同**：
 * - `global` 是黑名单（`LayerPolicy`，名单里的是要关掉的）；
 * - `workspace` 是逐项绝对状态（`WorkspacePolicy`，`名字 → 布尔`）。
 *
 * 因此工作区层可以**打开**全局关着的项：全局从「硬上限」退化为「默认值」。
 * 这是设计变更而非实现细节——旧版不变量 1/2/3/19（「全局是硬上限、工作区只能收窄」）
 * 已被本条取代，见 `docs/design.md`。
 */
export interface EffectivePolicy {
  global: LayerPolicy
  workspace: WorkspacePolicy | null
}

/** 两层生效集求值用到的清单（名字本身，不含元数据）。 */
export interface Inventories {
  skills: readonly string[]
  mcps: readonly string[]
}

/**
 * 两层生效集求值的结果（设计 4.3）。
 * `key` 是一个规范化字符串，用于「目标集没变就不重注册」的廉价比较；
 * **刻意不含清单内容**——清单变化由各自的 `skills/change` / `tools/change` 处理，
 * 这里只需要识别「隐藏集合本身」是否变化。
 */
export interface HiddenResult {
  skills: string[]
  mcps: string[]
  key: string
}

const deniedOf = (global: LayerPolicy, domain: Domain): readonly string[] =>
  domain === 'skills' ? global.skills : global.mcps

/**
 * 建一个「某域名字 → 是否启用」的判定函数（设计 4.1）。
 *
 * 规则只有一条：**工作区有决定就用决定，没有就跟随全局**。
 * `false` 是有效值，所以只能写 `??`，不能用 `||`（`false || 默认` 会吞掉「明令关」）。
 *
 * 返回函数而不是单次判定：调用方（`hiddenNames`、工作区视图）都是按域遍历，
 * 每次调用都重建 Set 会让 512 项的清单退化成 O(n²)。全局名单里同一个名字
 * 可能同时出现在 skills 与 mcps，所以两个域必须各建一个 Set，不能合并。
 */
export function openResolver(effective: EffectivePolicy, domain: Domain): (name: string) => boolean {
  const denied = new Set(deniedOf(effective.global, domain))
  const local = effective.workspace?.[domain]
  return (name) => local?.[name] ?? !denied.has(name)
}

/**
 * 计算一个会话**被关掉**的名字（设计 4.1）。
 *
 * 逐名字解析，不再做「集合求交」：旧实现先用全局名单求差集、再用工作区名单求差集，
 * 那个顺序本身就是「工作区只能收窄」的算法表达。现在工作区可以反向覆盖，
 * 集合运算表达不了这件事，必须逐名字取状态。
 */
export function hiddenNames(inventories: Inventories, effective: EffectivePolicy): HiddenResult {
  const openSkill = openResolver(effective, 'skills')
  const openMcp = openResolver(effective, 'mcps')
  const skills = inventories.skills.filter((name) => !openSkill(name)).sort()
  const mcps = inventories.mcps.filter((name) => !openMcp(name)).sort()
  return { skills, mcps, key: `skills=${skills.join(',')}|mcps=${mcps.join(',')}` }
}
