import type { LayerPolicy } from './schema.ts'

/** 一个会话实际生效的两层策略。工作区层缺失用 `null` 表示「不进一步收窄」。 */
export interface EffectivePolicy {
  global: LayerPolicy
  workspace: LayerPolicy | null
}

/** 两层生效集求值用到的清单（名字本身，不含元数据）。 */
export interface Inventories {
  skills: readonly string[]
  mcps: readonly string[]
}

/**
 * 单层的生效集合（设计 4.1）。
 *
 * **只有黑名单一种语义**：名单是「要关掉的」，
 * 所以生效集是差集。`default` 与 `blacklist` 都走这一条——`default` 只作为
 * 历史取值存在，`normalizePolicy` 已把它归一到 `blacklist`，这里再兜一次
 * 是为了让 `allowedNames` 在不经过解析的调用点上也不会漏掉名单。
 *
 * 保留 `names` 的原始顺序，便于 UI 按清单的稳定次序渲染。
 */
export function allowedNames(names: readonly string[], policy: LayerPolicy): string[] {
  const denied = new Set([...policy.skills, ...policy.mcps])
  if (denied.size === 0) return [...names]
  return names.filter((name) => !denied.has(name))
}

/**
 * 两层生效集求值的结果（设计 4.2）。
 * `key` 是一个规范化字符串，用于「目标集没变就不重注册」的廉价比较；
 * **刻意不含清单内容**——清单变化由各自的 `skills/change` / `tools/change` 处理，
 * 这里只需要识别「隐藏集合本身」是否变化。
 */
export interface HiddenResult {
  skills: string[]
  mcps: string[]
  key: string
}

/**
 * 计算一个会话**被关掉**的名字（全局层是硬上限，见不变量 1、2、3、19）。
 *
 * 关键顺序：先对清单应用全局层，**再**对该结果应用工作区层。
 * 因此工作区层永远无法把全局层关掉的名字重新打开——这正是「全局是硬上限」的算法表达。
 * 工作区层为 `null` 时跳过第二层，即「不进一步收窄」。
 */
export function hiddenNames(inventories: Inventories, effective: EffectivePolicy): HiddenResult {
  const skillsAllowed = allowedNames(inventories.skills, effective.global)
  const skillsEffective =
    effective.workspace === null ? skillsAllowed : allowedNames(skillsAllowed, pick(effective.workspace, 'skills'))

  const mcpsAllowed = allowedNames(inventories.mcps, effective.global)
  const mcpsEffective =
    effective.workspace === null ? mcpsAllowed : allowedNames(mcpsAllowed, pick(effective.workspace, 'mcps'))

  // 用 Set 判定「是否还在生效集里」：清单可达 512 项（`MAX_NAMES`），
  // 逐个 `includes` 是 O(n²)；这里只要结果顺序与 `inventories` 一致即可。
  const skillsAlive = new Set(skillsEffective)
  const mcpsAlive = new Set(mcpsEffective)
  const skills = inventories.skills.filter((name) => !skillsAlive.has(name)).sort()
  const mcps = inventories.mcps.filter((name) => !mcpsAlive.has(name)).sort()
  return { skills, mcps, key: `skills=${skills.join(',')}|mcps=${mcps.join(',')}` }
}

/**
 * 把「一份名单两个域」的 `LayerPolicy` 收窄成只看某一域的等价策略。
 * `LayerPolicy` 只有单个 `mode`，所以求值时必须把另一域的名单清空，
 * 否则 MCP 名单会被误当成 skill 的关闭名单。
 *
 * 白名单删除后这条仍然必要：`allowedNames` 把两份名单并成一个拒绝集，
 * 分域求值时若不先清空另一域，skill 段会把 MCP 的名字也当成要关的。
 */
function pick(policy: LayerPolicy, domain: 'skills' | 'mcps'): LayerPolicy {
  if (domain === 'skills') return { mode: policy.mode, skills: policy.skills, mcps: [] }
  return { mode: policy.mode, skills: [], mcps: policy.mcps }
}
