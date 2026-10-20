/**
 * 面板共用的词条与占位符替换。
 *
 * 两个面板共用 `NS` 与这里的字典：各写一份会让「同一句话两处不同」成为必然。
 * 类型定义在 `types.ts`（那个模块不引入任何运行时代码）。
 */

import type { Translate } from './types.ts'

/** locale 命名空间。与 `apply` 里 `ctx.locale.register(NS, ...)` 一致。 */
export const NS = 'skill-scope'

/**
 * 把 `{key}` 占位符替换成 `params` 里的值；`params` 缺失时原样返回。
 *
 * 宿主 i18n 的 `t` 与本文件的兜底词条都过这一层：替换规则只该有一份实现，
 * 否则「宿主有 i18n」与「没有 i18n」两种路径下的文案可能不一致。
 * 未在 `params` 里出现的占位符保持原样（缺参时报出可见的 `{key}` 比静默吞掉更好排查）。
 */
export function withParams(template: string, params?: Record<string, string>): string {
  if (params === undefined) return template
  return Object.entries(params).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  )
}

/** 中文词条（权威文案；英文是它的对照翻译）。 */
export const zh = {
  'panel.label': '全局 Skills',
  'global.title': '全局能力 · 对所有工作区生效',
  'workspace.title': '本工程能力 · 只影响 {project}',
  'view.all': '全部',
  'view.enabled': '已启用',
  'view.disabled': '已禁用',
  'view.overridden': '与全局不同',
  'section.skills': 'Skill',
  'section.mcps': 'MCP',
  'search.placeholder': '搜索',
  'action.retry': '重试',
  'action.close': '关闭',
  'action.open': '工作区 Skills',
  'state.notLive': '非实时',
  'state.notLiveHint': '该会话当前没有实时 Agent，下面显示的是全局清单，不是本作用域的完整集合。',
  'state.loading': '加载中…',
  'state.empty': '没有条目',
  'state.global': '全局',
  'state.scope': '本作用域',
  'state.enabled': '已启用',
  'state.disabled': '已禁用',
  'state.overridden': '与全局不同',
  'action.expand': '展开',
  'action.collapse': '收起',
  'detail.state': '状态',
  'detail.source': '来源',
  // 展开详情里「工具」这一行的键名（MCP 行专用，值是逐条的工具名清单）。
  'detail.tools': '工具',
  // 详情行的「来源」值：runtime 注入的 skill 没有磁盘出处，服务端给 `sourceLabel: null`。
  // 与 `group.ungrouped` 分开：那条是**分组头**文案（大写名词短语），这条是**值**的位置，
  // 两者语境不同，将来要改其中一个不该连带改另一个。
  'detail.originRuntime': '运行时注入（无磁盘文件）',
  'count.unit': '项',
  'group.ungrouped': '运行时注入',
  // 只读行不渲染任何原因文案（「未加载」「只读」等），只由「没有开关」这一事实体现。
  // 这句文案是与用户确认过的措辞，不要按「已有会话的下一回合也会生效」之类的推论去改它 ——
  // 该推论未经实测，且与用户明确要求冲突。
  'workspace.intro': '初始默认继承全局配置；你可以覆盖修改 skill 开关状态，改动只对本 workspace 新开的会话生效。',
} as const

/** 英文词条。键必须与 `zh` 完全一致（少一条就是一段只显示 key 的界面）。 */
export const en: Record<keyof typeof zh, string> = {
  'panel.label': 'Global Skills',
  'global.title': 'Global capabilities · applies to all workspaces',
  'workspace.title': 'Project capabilities · affects {project} only',
  'view.all': 'All',
  'view.enabled': 'Enabled',
  'view.disabled': 'Disabled',
  'view.overridden': 'Differs from global',
  'section.skills': 'Skills',
  'section.mcps': 'MCP',
  'search.placeholder': 'Search',
  'action.retry': 'Retry',
  'action.close': 'Close',
  'action.open': 'Workspace Skills',
  'state.notLive': 'Not live',
  'state.notLiveHint': 'This session has no live agent, so the list below is the global inventory, not this scope’s full set.',
  'state.loading': 'Loading…',
  'state.empty': 'No entries',
  'state.global': 'Global',
  'state.scope': 'This scope',
  'state.enabled': 'Enabled',
  'state.disabled': 'Disabled',
  'state.overridden': 'Differs from global',
  'action.expand': 'Expand',
  'action.collapse': 'Collapse',
  'detail.state': 'State',
  'detail.source': 'Source',
  'detail.tools': 'Tools',
  'detail.originRuntime': 'Runtime-injected (no file on disk)',
  'count.unit': 'items',
  'group.ungrouped': 'Runtime-injected',
  'workspace.intro': 'By default everything inherits the global configuration; you can override any skill switch here. Changes apply only to new sessions in this workspace.',
}

/**
 * 无宿主 i18n 时的兜底词条。
 *
 * 宿主 i18n 的取值器（`index.tsx` 的 `t`）与本函数都过 `withParams`：替换规则只有
 * 一份实现，所以「有宿主 i18n」与「没有 i18n」两条路径的文案行为必然一致。
 * 定义在 `zh` / `en` 之后：调用时才读字典，但顺序保持「字典在先」更容易读。
 */
export function createDefaultTranslate(): Translate {
  const dictionary: Record<string, string> = zh
  return (key, params) => withParams(dictionary[key] ?? key, params)
}
