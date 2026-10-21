/**
 * 全局面板与工作区弹层的**共享展示层**：视图条 + 搜索框 + 错误条 + 两段 `CapabilityList`。
 *
 * 两个面板原先各写一份（重构前 `GlobalPanel.tsx` 494 行、`WorkspaceModal.tsx` 585 行）。
 * 逐段归一化比对后，可复用的部分被拆成三个模块：
 *
 *   - `panel-model.ts` —— 纯函数：视图谓词、行派生（可单测、无 React）
 *   - `panel-state.ts` —— `usePolicyPanel`：加载 / 乐观改 / 回滚
 *   - 本文件 —— 展示：`ViewBar` / `CapabilityPanelBody` / `SearchRow`
 *
 * 两个外壳只保留**真正不同**的部分：外层容器与标题、说明文案、保存请求体与响应合并。
 *
 * 承重不变量（不可为「复用」而抹平）：
 *   - 视图按钮只是**列表谓词**，不发保存请求。
 *   - 工作区保存后**只合并 `revision` 与 `workspace`**，绝不整体替换视图（响应里的
 *     `exists` 是写文件之前采集的旧值）。见 `docs/design.md`。
 */
import type { ReactNode } from 'react'
import {
  CapabilityList,
  ErrorAlert,
  SearchIcon,
  Switch,
  type CapabilityRow,
} from './parts.tsx'
import styles from './styles.module.css'
import { VIEW_ORDER, viewTestId, type PolicyView } from './panel-model.ts'
import type { PolicyPanelState } from './panel-state.ts'
import type { Translate } from './types.ts'
import { asRecord } from '../shared/unknown.ts'


// --- 视图条 ---

/**
 * 视图按钮。切换**只改组件状态**，不触发保存。
 *
 * 按钮集合由 `views` 注入：全局层用 `VIEW_ORDER`（三种），工作区层用
 * `WORKSPACE_VIEW_ORDER`（多一个「与全局不同」）。
 *
 * `trailing` 渲染在**同一行的右端**（不是新起一行）：官方 skill 展示开关在全局
 * 与工作区两个面板里都放这里，靠 `margin-left: auto` 贴右；窄容器里整行会换行，
 * 开关自然落到下一行，不会挤压视图按钮。
 */
export function ViewBar({
  view,
  onChange,
  t,
  views = VIEW_ORDER,
  trailing,
}: {
  view: PolicyView
  onChange: (next: PolicyView) => void
  t: Translate
  views?: readonly PolicyView[]
  /** 行尾的附加控件（官方 skill 展示开关）。 */
  trailing?: ReactNode
}): ReactNode {
  return (
    <div className={styles.modeRow} data-testid="view-row">
      {views.map((candidate) => (
        <button
          key={candidate}
          type="button"
          className={`${styles.modeButton} ${view === candidate ? styles.modeButtonActive : ''}`}
          aria-pressed={view === candidate}
          data-testid={viewTestId(candidate)}
          onClick={() => {
            onChange(candidate)
          }}
        >
          {t(`view.${candidate}`)}
        </button>
      ))}
      {trailing === undefined ? null : <div className={styles.modeRowTrailing}>{trailing}</div>}
    </div>
  )
}

/**
 * 「显示官方 Skill」开关（全局层状态，两个面板共用）。
 *
 * 它是**展示开关**：只决定官方（`@deepseek-ai`）行列不列，不关闭任何东西；打开后
 * 那些行回到清单、可逐项关闭。值存在全局策略里，所以工作区面板读到的是同一个值，
 * 两处永远同口径（写入由调用方注入：全局面板走 `global/save`，工作区面板附带在
 * `workspace/save` 上，见两个外壳的注释）。
 *
 * 可见文案用短句（视图条只有一行），完整解释放在 `title`：鼠标悬停能看到
 * 「默认隐藏」「这是全局开关」这两条容易误解的事实。
 */
export function OfficialSkillsToggle({
  checked,
  onChange,
  t,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  t: Translate
}): ReactNode {
  return (
    <span className={styles.toggleRow} title={t('panel.showOfficialSkillsTitle')}>
      <Switch checked={checked} label={t('panel.showOfficialSkills')} onChange={onChange} />
      <span className={styles.toggleLabel}>{t('panel.showOfficialSkills')}</span>
    </span>
  )
}

// --- 面板主体 ---

/** 两段列表共用的词条包。抽一次，避免改文案时两处漂移。 */
function listLabels(t: Translate): {
  searchPlaceholder: string
  emptyText: string
  enabledLabel: string
  disabledLabel: string
  overriddenLabel: string
  detailStateKey: string
  detailSourceKey: string
  detailToolsKey: string
  expandLabel: string
  collapseLabel: string
  ungroupedLabel: string
  ungroupedOriginLabel: string
} {
  return {
    searchPlaceholder: t('search.placeholder'),
    emptyText: t('state.empty'),
    enabledLabel: t('state.enabled'),
    disabledLabel: t('state.disabled'),
    overriddenLabel: t('state.overridden'),
    detailStateKey: t('detail.state'),
    detailSourceKey: t('detail.source'),
    detailToolsKey: t('detail.tools'),
    expandLabel: t('action.expand'),
    collapseLabel: t('action.collapse'),
    ungroupedLabel: t('group.ungrouped'),
    ungroupedOriginLabel: t('detail.originRuntime'),
  }
}

/**
 * 面板主体的数据与回调。外壳组装后传入。
 *
 * **接口只声明真正会被用到的成员。** 外壳自己已经持有 `value`，要看什么直接读，
 * 不需要经本组件转一手。曾经这里有 `onViewChange` 这个参数，但函数体从不读它
 * （视图条由两个外壳渲染）—— 留着它的害处不是「多几个字段」，而是**假接口**：
 * 读代码的人看到某个字段被传进来，会以为有对应分支，然后去这里找一个不存在的分支。
 *
 * 搜索框由本组件渲染（`searchInputId` 由外壳给出，各自唯一）：两个外壳的位置与图标相同，
 * 复制两份就等于给了「一处漏改」的机会。
 */
type CapabilityPanelBodyProps<TValue> = {
  t: Translate
  panel: PolicyPanelState<TValue>
  skills: readonly CapabilityRow[]
  mcps: readonly CapabilityRow[]
  onRetry: () => void
  /** MCP 段的 testid 前缀。两壳都用 `mcp-`，同名项因此可按前缀唯一定位。 */
  mcpTestIdPrefix: string
  /** Skill 段的 testid 前缀。**两壳不同**：全局是 `skill-`，工作区是 `ws-skill-`（同一批 skill 名会同时出现在两个面板）。 */
  skillTestIdPrefix: string
  /** 搜索框的 DOM id。两壳各自唯一（全局 `skill-scope-global-search`、工作区 `skill-scope-ws-search`）。 */
  searchInputId: string
}

/**
 * 搜索框 + 错误条 + 两段列表。
 *
 * 查询值是**一个**（`panel.query`），经 `CapabilityList` 的 `externalQuery` 同时喂给两段，
 * 因此一个输入框**同筛两段**。
 */
export function CapabilityPanelBody<TValue>(props: CapabilityPanelBodyProps<TValue>): ReactNode {
  const { t, panel } = props
  const labels = listLabels(t)
  /*
   * 视图过滤在**这里**做，而不是交给外壳 —— 两个外壳都必须过同一道谓词，
   * 复制到两处就等于给了「一处漏改」的机会（本次重构的动机之一）。
   * 视图只筛行，不碰开关，也不发保存请求。
   */
  const visible = (rows: readonly CapabilityRow[]): readonly CapabilityRow[] => {
    if (panel.view === 'all') return rows
    /*
     * 「与全局不同」问的是**跨层差异**（`row.overridden` 由服务端算、外壳传下来），
     * 不是开关位置。所以它不能和下面两个视图共用 `row.enabled === …` 的写法：
     * 一个被本工程打开的全局关闭项，`enabled` 为 true，却正是这个视图要展示的行。
     */
    if (panel.view === 'overridden') return rows.filter((row) => row.overridden === true)
    return rows.filter((row) => row.enabled === (panel.view === 'enabled'))
  }
  return (
    <>
      <SearchRow id={props.searchInputId} value={panel.query} onChange={panel.setQuery} t={t} />
      {panel.error === null ? null : (
        <ErrorAlert
          message={panel.error}
          retryLabel={t('action.retry')}
          onRetry={props.onRetry}
        />
      )}

      <CapabilityList
        title={t('section.skills')}
        sectionTitleId="skill-scope-skills-title"
        rows={visible(props.skills)}
        {...labels}
        externalQuery={panel.query}
        testIdPrefix={props.skillTestIdPrefix}
        countLabel={t('count.unit')}
        onToggle={(name, next) => {
          panel.toggle(name, next, 'skills')
        }}
      />
      <CapabilityList
        title={t('section.mcps')}
        sectionTitleId="skill-scope-mcps-title"
        rows={visible(props.mcps)}
        {...labels}
        externalQuery={panel.query}
        testIdPrefix={props.mcpTestIdPrefix}
        countLabel={t('count.unit')}
        onToggle={(name, next) => {
          panel.toggle(name, next, 'mcps')
        }}
      />
    </>
  )
}

/**
 * 顶部统一搜索框：**一份**输入同时过滤技能与 MCP 两段。
 *
 * 两个面板共用它，是为了让「同一个词在两段里同时生效」这条行为只有一处实现。
 * 分工区各留一个输入框会让同一个词要输两遍，且两个框的过滤状态无法一致。
 */
function SearchRow({
  id,
  value,
  onChange,
  t,
}: {
  id: string
  value: string
  onChange: (next: string) => void
  t: Translate
}): ReactNode {
  return (
    <div className={styles.searchRow}>
      <span className={styles.searchIcon}>
        <SearchIcon />
      </span>
      <input
        id={id}
        className={styles.search}
        type="search"
        value={value}
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        onChange={(event) => {
          onChange(readInputValue(event.target))
        }}
      />
    </div>
  )
}

/**
 * 从受控输入框读值（受 `noUncheckedIndexedAccess` 约束，需显式判空）。
 *
 * 不直接用 `event.target.value`：`EventTarget` 上没有 `value`，需要先收窄类型。
 */
function readInputValue(target: EventTarget | null): string {
  const record = asRecord(target)
  const value = record?.['value']
  return typeof value === 'string' ? value : ''
}
