/**
 * 面板的**数据模型**（纯函数与常量，无 React、无 JSX）：名单视图谓词 + 行派生。
 *
 * 两个面板（全局面板、工作区弹层）共用这一份：它们只在**取值函数**（`isOpen` /
 * `isOverridden`）上不同，渲染看到的是同一批 `CapabilityRow`。
 * 浏览器产物与宿主是两份构建，所以这里不 import 任何宿主代码。
 */
import type { CapabilityRow } from './parts.tsx'
import type { McpRowValue, SkillRowValue, Translate } from './types.ts'


// --- 视图（纯前端列表谓词，不是策略模式） ---

/**
 * 名单视图：只决定**列表里显示哪些行**，不改任何一行开关，也不落盘。
 *
 * 与已废弃的「模式选择器」的关键区别：旧按钮按下会重写名单（一次真实写入）。
 *
 * `overridden` 只有工作区层有意义：它筛「本工程改过全局的项」。
 * 全局层没有上层可对照，所以那一层按 `VIEW_ORDER` 渲染，少一个按钮。
 */
export type PolicyView = 'all' | 'enabled' | 'disabled' | 'overridden'

/** 视图按钮的呈现顺序：全部 → 已启用 → 已禁用。`ViewBar` 按它渲染。 */
export const VIEW_ORDER: readonly PolicyView[] = ['all', 'enabled', 'disabled']

/**
 * 工作区层的视图按钮：在 `VIEW_ORDER` 之后多一个「与全局不同」。
 *
 * **不放进 `VIEW_ORDER`**：全局层渲染它只会得到一个永远空着的列表 ——
 * 全局层没有「上一层」，「与全局不同」在那里无定义。
 */
export const WORKSPACE_VIEW_ORDER: readonly PolicyView[] = [...VIEW_ORDER, 'overridden']

/** 视图按钮的 `data-testid`；两面板共用，测试引用它而不手抄字符串。 */
export const viewTestId = (view: PolicyView): string => `view-${view}`


// --- 行派生 ---

/** 两个域的稳定名字。求值、翻转、渲染都按它分派。 */
export type Domain = 'skills' | 'mcps'

/**
 * 取一层的「某项是否打开」。
 *
 * 两层形状不同（全局是黑名单数组，工作区是逐项表），所以行派生不再接收「名单」，
 * 只接收一个取值函数。这样两个面板共用同一段渲染，而语义差异只存在于各自的取值函数里。
 */
type OpenLookup = (name: string) => boolean

/** 取「这一项是否与上层不同」（只为工作区提供；全局层没有上层）。 */
type OverrideLookup = (name: string) => boolean

/** 全局层的取值规则：名单里列的就是被关掉的（唯一语义）。 */
export function isEnabled(names: readonly string[], name: string): boolean {
  return !names.includes(name)
}

/**
 * Skill 行派生。两面板原为同一份实现，**分组与出处字段必须原样透传**：
 *  - `CapabilityList` 靠「每一行都有 `group`」决定是否启用分组；前端补默认值会把
 *    「服务端没给」伪装成「给了空组」，MCP 段也会跟着被分组。
 *  - `origin` 只在有值时挂：`null`/`undefined` 都表示「无磁盘出处」，挂空串会破坏
 *    「runtime skill 出文案 / MCP 行整行不渲染」那个判断。
 *
 * 入参用的是线上形状（`SkillRowValue`），不是「最小字段面」：多声明一份更窄的
 * 本地类型只会让两个外壳的数据多过一道不必要的适配。
 */
export function toSkillRows(
  skills: readonly SkillRowValue[],
  isOpen: OpenLookup,
  t: Translate,
  isOverridden: OverrideLookup = () => false,
): CapabilityRow[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: skill.source,
    enabled: isOpen(skill.name),
    ...(isOverridden(skill.name) ? { overridden: true } : {}),
    // 不变量 22：Skill 行按 `modelInvocable` 区分，但**仍然可切换** ——
    // 不可调用只是标出来，不是只读（可调用性是宿主的事实，不是本面板的权限）。
    // `modelInvocable` 因此只影响展示，不参与「是否只读」的判定。
    ...(skill.group === undefined ? {} : { group: skill.group }),
    ...(skill.groupLabel === undefined ? {} : { groupLabel: skill.groupLabel }),
    ...(skill.sourceLabel === undefined || skill.sourceLabel === null
      ? {}
      : { origin: skill.sourceLabel }),
  }))
}

/**
 * MCP 行派生。与 `toSkillRows` 同形：**不排除任何行**——全局关掉的 server 也要留在
 * 列表里，否则用户在工程里没有入口把它打开。
 *
 * 只读判定：未加载或宿主不允许限制都不可切换。
 *
 * `tools` 原样透传服务端的 `toolNames`（**不在这里排序、不去重、不改写前缀**）：
 * 展开区要显示的就是用户能在日志与源码里对得上的那串完整名字，服务端已保证次序稳定。
 * 空数组也照传——`CapabilityCard` 用「空即不渲染工具段」来决定，前端不参与这个判断。
 */
export function toMcpRows(
  mcps: readonly McpRowValue[],
  isOpen: OpenLookup,
  t: Translate,
  isOverridden: OverrideLookup = () => false,
): CapabilityRow[] {
  return mcps.map((server) => {
    const readonly = !server.restrictable || !server.loaded
    return {
      name: server.serverName,
      description: `${server.toolCount} tools`,
      tools: server.toolNames,
      source: server.source === 'global' ? t('state.global') : t('state.scope'),
      enabled: isOpen(server.serverName),
      ...(isOverridden(server.serverName) ? { overridden: true } : {}),
      ...(readonly ? { readonly: true } : {}),
    }
  })
}

