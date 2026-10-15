/**
 * 全局面板与工作区弹层的**共享内核**。
 *
 * 两个面板原先各写一份行派生、开关接线与词条包（重构前 `GlobalPanel.tsx` 494 行、
 * `WorkspaceModal.tsx` 585 行）。逐段归一化比对后，可复用的是：
 *
 *   1. 纯函数（本文件上半部）—— 可单测、无 React
 *   2. `usePolicyPanel` —— 加载 / 乐观改 / 回滚，**保存的线上形状与合并策略由外壳注入**
 *   3. `CapabilityPanelBody` —— 视图条 + 搜索框 + 锁提示 + 错误条 + 两段 `CapabilityList`
 *
 * 两个外壳只保留**真正不同**的部分：
 *   - 外壳：全局用 `styles.panel`（main 槽位内），工作区用 `overlay` + `modal` + 关闭按钮
 *   - 标题与说明文案
 *   - 工作区独有：非实时提示、顶部说明段（「下面是未被全局禁用的项…」）
 *   - 保存请求体与响应合并
 *
 * 承重不变量（不可为「复用」而抹平）：
 *   - 视图按钮只是**列表谓词**，不发保存请求。
 *   - 工作区保存后**只合并 `revision` 与 `policy`**，绝不整体替换视图（响应里的
 *     `exists` 是写文件之前采集的旧值）。见 `docs/design.md`。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  CapabilityList,
  ErrorAlert,
  SearchIcon,
  type CapabilityRow,
} from './parts.tsx'
import styles from './styles.module.css'
import { zh } from './locales.ts'
import type { Translate } from './translate.ts'
import { asRecord } from '../shared/unknown.ts'

export type { Translate } from './translate.ts'

// --- 视图（纯前端列表谓词，不是策略模式） ---

/**
 * 名单视图：只决定**列表里显示哪些行**，不改任何一行开关，也不落盘。
 *
 * 与已废弃的「模式选择器」的关键区别：旧按钮按下会重写名单（一次真实写入）。
 */
export type PolicyView = 'all' | 'enabled' | 'disabled'

/** 视图按钮的呈现顺序：全部 → 已启用 → 已禁用。`ViewBar` 按它渲染。 */
export const VIEW_ORDER: readonly PolicyView[] = ['all', 'enabled', 'disabled']

/** 视图按钮的 `data-testid`；两面板共用，测试引用它而不手抄字符串。 */
export const viewTestId = (view: PolicyView): string => `view-${view}`


// --- 词条 ---

/**
 * 无宿主 i18n 时的兜底词条。
 *
 * 两处原先各写一份：全局版直接用 `withParams`，工作区版内联展开了一遍同样的 `{k}`
 * 替换。合并成一份，行为等价（`params === undefined` 时原样返回）。
 */
export function createDefaultTranslate(): Translate {
  const dictionary: Record<string, string> = zh
  return (key, params) => {
    const template = dictionary[key] ?? key
    if (params === undefined) return template
    return Object.entries(params).reduce(
      (text, [k, v]) => text.replaceAll(`{${k}}`, v),
      template,
    )
  }
}

/** 把任意抛出物收成一句可展示的文案：`Error` 取 message，其余 `String()`。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- 行派生 ---

/** 名单里列的就是被关掉的（唯一语义）。 */
export function isEnabled(names: readonly string[], name: string): boolean {
  return !names.includes(name)
}

/** `toSkillRows` 需要的最小字段面（宽于真实响应，便于单测构造）。 */
export type SkillLike = {
  name: string
  description: string
  source: string
  modelInvocable: boolean
  group?: string | undefined
  groupLabel?: string | undefined
  sourceLabel?: string | null | undefined
}

/** `toMcpRows` 需要的最小字段面。 */
export type McpLike = {
  serverName: string
  toolCount: number
  /** 该 server 的完整工具名 `mcp__<server>__<tool>`，服务端已去重排序（`McpRow.toolNames`）。 */
  toolNames: string[]
  source: string
  restrictable: boolean
  loaded: boolean
}

/**
 * Skill 行派生。两面板原为同一份实现，**分组与出处字段必须原样透传**：
 *  - `CapabilityList` 靠「每一行都有 `group`」决定是否启用分组；前端补默认值会把
 *    「服务端没给」伪装成「给了空组」，MCP 段也会跟着被分组。
 *  - `origin` 只在有值时挂：`null`/`undefined` 都表示「无磁盘出处」，挂空串会破坏
 *    「runtime skill 出文案 / MCP 行整行不渲染」那个判断。
 */
export function toSkillRows(
  skills: readonly SkillLike[],
  policySkills: readonly string[],
  t: Translate,
): CapabilityRow[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: skill.source,
    enabled: isEnabled(policySkills, skill.name),
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
 * MCP 行派生。`excludeNames` 是工作区独有的「被全局关掉则不列出」（全局传空）。
 * 只读判定：未加载或宿主不允许限制都不可切换。
 *
 * `tools` 原样透传服务端的 `toolNames`（**不在这里排序、不去重、不改写前缀**）：
 * 展开区要显示的就是用户能在日志与源码里对得上的那串完整名字，服务端已保证次序稳定。
 * 空数组也照传——`CapabilityCard` 用「空即不渲染工具段」来决定，前端不参与这个判断。
 */
export function toMcpRows(
  mcps: readonly McpLike[],
  policyMcps: readonly string[],
  t: Translate,
  excludeNames: readonly string[] = [],
): CapabilityRow[] {
  return mcps
    .filter((server) => !excludeNames.includes(server.serverName))
    .map((server) => {
      const readonly = !server.restrictable || !server.loaded
      return {
        name: server.serverName,
        description: `${server.toolCount} tools`,
        tools: server.toolNames,
        source: server.source === 'global' ? t('state.global') : t('state.scope'),
        enabled: isEnabled(policyMcps, server.serverName),
        ...(readonly ? { readonly: true } : {}),
      }
    })
}

// --- 数据 hook ---

/**
 * 面板数据的最小形状。两条路由都返回这三个字段（外加各自的视图字段）。
 *
 * `revision` 三态：`null` 表示「我期望文件还不存在」。**不可折叠成 `undefined`** ——
 * 那会改变服务端的乐观锁守卫语义。
 */
export type PolicyValue = {
  revision: string | null
  policy: { skills: string[]; mcps: string[] }
}

/**
 * 面板数据骨架：加载一次，改动走「乐观改 → 提交 → 成功合并/失败回滚」。
 *
 * **线上形状与合并策略由外壳注入**，因为两处语义不同且都承重：
 *  - 全局：保存响应就是完整的 `GlobalValue`，整体替换。
 *  - 工作区：只合并 `revision` 与 `policy`（`exists` 是写文件前的旧值）。
 */
export type PolicyPanelOptions<TValue extends PolicyValue> = {
  /** 读取。外壳用 `useCallback` 保证引用稳定。 */
  load: () => Promise<TValue>
  /** 提交一次策略改动。`mutate` 收到当前值、返回**新策略**。 */
  save: (current: TValue, nextPolicy: TValue['policy']) => Promise<TValue>
  /** 保存成功后的值合并。省略则整体替换（全局即如此）。 */
  mergeSaved?: ((current: TValue, saved: TValue) => TValue) | undefined
}

export type PolicyPanelState<TValue extends PolicyValue> = {
  value: TValue | null
  error: string | null
  busy: boolean
  /**
   * 最近一次触发的加载错误是否是**首次**加载失败（`value` 仍为 `null`）。
   * 外壳据此决定渲染「加载中」还是「错误 + 重试」。
   */
  loadFailed: boolean
  refresh: () => Promise<void>
  /** 名单视图（纯前端过滤谓词）。 */
  view: PolicyView
  setView: (next: PolicyView) => void
  /** 搜索关键词；一个输入框同筛两段。 */
  query: string
  setQuery: (next: string) => void
  /**
   * `mutate` 收到当前值、返回**新策略**；`null` 表示「不改」（例如目标状态已达成时）。
   * 与重构前两个面板的 `commit` 契约一致。
   */
  commit: (mutate: (current: TValue) => TValue['policy'] | null) => Promise<void>
  /** 翻转一个名字到**指定**目标状态（不是盲翻转，避免连点导致状态发散）。 */
  toggle: (name: string, next: boolean, which: 'skills' | 'mcps') => void
}

/**
 * 加载 + 三件改动操作。
 *
 * 回滚依赖**提交时刻捕获的快照**，不是 `value` 的闭包 —— 后者在连续快速点击时会拿到
 * 过期的值，回滚到更早的状态。提交串行化（`chain`），避免并发写入互相覆盖。
 */
export function usePolicyPanel<TValue extends PolicyValue>({
  load,
  save,
  mergeSaved,
}: PolicyPanelOptions<TValue>): PolicyPanelState<TValue> {
  const [value, setValue] = useState<TValue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [view, setView] = useState<PolicyView>('all')
  const [query, setQuery] = useState('')

  // 卸载后不再 setState；每次 refresh 递增以重新触发加载。
  const alive = useRef(true)
  const [nonce, setNonce] = useState(0)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )

  const refresh = useCallback(async (): Promise<void> => {
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    let current = true
    setError(null)
    setLoadFailed(false)
    load().then(
      (loaded) => {
        if (current && alive.current) {
          setValue(loaded)
          setLoadFailed(false)
        }
      },
      (cause: unknown) => {
        if (current && alive.current) {
          setError(describeError(cause))
          setLoadFailed(true)
        }
      },
    )
    return () => {
      current = false
    }
  }, [nonce, load])

  // 提交串行化：并发 POST 会互相覆盖策略，且回滚快照会错位。
  const chain = useRef<Promise<void>>(Promise.resolve())

  /*
   * `value` 的镜像 ref：`commit` 必须**同步**读到「当前这一刻」的值。
   *
   * 不能靠 `setValue(prev => …)` 的 updater 把结果写在闭包变量里再当场读取 ——
   * React 18 起 updater 会被调度到渲染阶段执行，`setValue(...)` 返回时变量仍是初始值
   * （`current === null`），于是 `commit` 直接 early-return：**开关点了没反应，
   * 既不发保存请求、也不报错**。实测症状就是这个（保存调用数 0、`role="alert"` 不出现）。
   *
   * 每次渲染同步刷新镜像，`commit` 只读它。
   */
  const valueRef = useRef<TValue | null>(null)
  valueRef.current = value

  const commit = useCallback(
    async (mutate: (current: TValue) => TValue['policy'] | null): Promise<void> => {
      // 同步读镜像 ref（见上方 `valueRef` 注释：updater 里取值是错的）。
      const current = valueRef.current
      if (current === null) return
      const nextPolicy = mutate(current)
      // 目标状态已达成：不改（返回 `null`），避免无谓写入。
      if (nextPolicy === null) return
      setValue({ ...current, policy: nextPolicy })
      setBusy(true)
      const snapshot: TValue = current
      const optimistic: TValue = { ...snapshot, policy: nextPolicy }
      chain.current = chain.current
        .then(() => save(optimistic, nextPolicy as TValue['policy']))
        .then(
          (saved) => {
            if (!alive.current) return
            setValue((prev) =>
              prev === null
                ? prev
                : mergeSaved === undefined
                  ? saved
                  : mergeSaved(prev, saved),
            )
            setError(null)
          },
          (cause: unknown) => {
            if (!alive.current) return
            // 回滚到**提交时刻**的快照，不是更早的某个值。
            setValue(snapshot)
            setError(describeError(cause))
          },
        )
        .finally(() => {
          if (alive.current) setBusy(false)
        })
      return chain.current
    },
    [save, mergeSaved],
  )

  const toggle = useCallback(
    (name: string, next: boolean, which: 'skills' | 'mcps') => {
      void commit((current) => {
        // 目标状态已达成：不改（返回 `null`），避免无谓写入。
        if (isEnabled(current.policy[which], name) === next) return null
        const listed = current.policy[which].includes(name)
        const updated = next
          ? current.policy[which].filter((item) => item !== name)
          : [...current.policy[which], name]
        return { ...current.policy, [which]: updated }
      })
    },
    [commit],
  )

  return {
    value,
    error,
    busy,
    loadFailed,
    refresh,
    view,
    setView,
    query,
    setQuery,
    commit,
    toggle,
  }
}

// --- 视图条 ---

/** 三个视图按钮。切换**只改组件状态**，不触发保存。 */
export function ViewBar({
  view,
  onChange,
  t,
}: {
  view: PolicyView
  onChange: (next: PolicyView) => void
  t: Translate
}): ReactNode {
  return (
    <div className={styles.modeRow} data-testid="view-row">
      {VIEW_ORDER.map((candidate) => (
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
    </div>
  )
}

// --- 面板主体 ---

/** 两段列表共用的词条包。抽一次，避免改文案时两处漂移。 */
export function listLabels(t: Translate): {
  searchPlaceholder: string
  emptyText: string
  enabledLabel: string
  disabledLabel: string
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
 * **接口只声明真正会被用到的成员。** 曾经这里有 `onViewChange` / `searchInputId`
 * 两个参数，但函数体从不读它们：视图条由两个面板壳渲染，搜索框由 `SearchRow` 渲染。
 * 留着它们的害处不是「多几个字段」，而是**假接口**：读代码的人看到某个字段被传进来，
 * 会以为有对应分支，然后去这里找一个不存在的分支。
 */
export type CapabilityPanelBodyProps = {
  t: Translate
  error: string | null
  onRetry: () => void
  query: string
  view: PolicyView
  skills: readonly CapabilityRow[]
  mcps: readonly CapabilityRow[]
  onToggleSkill: (name: string, next: boolean) => void
  onToggleMcp: (name: string, next: boolean) => void
  /** MCP 段的 testid 前缀。**两壳不同**：全局是 `mcp-`，工作区是 `ws-mcp-`。 */
  mcpTestIdPrefix: string
  /** Skill 段的 testid 前缀。**两壳不同**：全局是 `skill-`，工作区是 `ws-skill-`。 */
  skillTestIdPrefix: string
}

/**
 * 视图条 + 错误条 + 两段列表。
 *
 * 搜索框由外壳渲染（各自的位置与图标不同）、查询值经 `query` 传入
 * （`CapabilityList` 的 `externalQuery`），因此一个输入框**同筛两段**。
 */
export function CapabilityPanelBody(props: CapabilityPanelBodyProps): ReactNode {
  const { t } = props
  const labels = listLabels(t)
  /*
   * 视图过滤在**这里**做，而不是交给外壳 —— 两个外壳都必须过同一道谓词，
   * 复制到两处就等于给了「一处漏改」的机会（本次重构的动机之一）。
   * 视图只筛行，不碰开关，也不发保存请求。
   */
  const visible = (rows: readonly CapabilityRow[]): readonly CapabilityRow[] =>
    props.view === 'all' ? rows : rows.filter((row) => row.enabled === (props.view === 'enabled'))
  return (
    <>
      {props.error === null ? null : (
        <ErrorAlert
          message={props.error}
          retryLabel={t('action.retry')}
          onRetry={props.onRetry}
        />
      )}

      <CapabilityList
        title={t('section.skills')}
        sectionTitleId="skill-scope-skills-title"
        rows={visible(props.skills)}
        {...labels}
        externalQuery={props.query}
        testIdPrefix={props.skillTestIdPrefix}
        countLabel={t('count.unit')}
        onToggle={props.onToggleSkill}
      />
      <CapabilityList
        title={t('section.mcps')}
        sectionTitleId="skill-scope-mcps-title"
        rows={visible(props.mcps)}
        {...labels}
        externalQuery={props.query}
        testIdPrefix={props.mcpTestIdPrefix}
        countLabel={t('count.unit')}
        onToggle={props.onToggleMcp}
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
export function SearchRow({
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
export function readInputValue(target: EventTarget | null): string {
  const record = asRecord(target)
  const value = record?.['value']
  return typeof value === 'string' ? value : ''
}

/**
 * 外壳 → `CapabilityPanelBody` 的接线参数。
 *
 * 抽出来的理由：这段接线在两个外壳里**逐字相同**，复制两份就意味着「一处改了另一处忘了」。
 * 外壳仍然负责自己独有的部分：加载/保存的线上形状、标题、外层容器、
 * 以及工作区特有的继承说明与页脚。
 *
 * **没有 `value` 字段。** 外壳自己已经持有 `value`，要看什么直接读，
 * 不需要经本组件转一手。
 */
export type WiredBodyProps<TValue extends PolicyValue> = {
  t: Translate
  panel: PolicyPanelState<TValue>
  skills: readonly CapabilityRow[]
  mcps: readonly CapabilityRow[]
  onRetry: () => void
  mcpTestIdPrefix: string
  skillTestIdPrefix: string
  /** 搜索框的 DOM id（两壳各自唯一）。省略则不渲染搜索框。 */
  searchInputId?: string
}

export function WiredCapabilityBody<TValue extends PolicyValue>(
  props: WiredBodyProps<TValue>,
): ReactNode {
  const { t, panel } = props

  return (
    <>
      {props.searchInputId === undefined ? null : (
        <SearchRow
          id={props.searchInputId}
          value={panel.query}
          onChange={panel.setQuery}
          t={t}
        />
      )}
      <CapabilityPanelBody
        t={t}
        error={panel.error}
        onRetry={props.onRetry}
        query={panel.query}
        view={panel.view}
        skills={props.skills}
        mcps={props.mcps}
        onToggleSkill={(name, next) => {
          panel.toggle(name, next, 'skills')
        }}
        onToggleMcp={(name, next) => {
          panel.toggle(name, next, 'mcps')
        }}
        mcpTestIdPrefix={props.mcpTestIdPrefix}
        skillTestIdPrefix={props.skillTestIdPrefix}
      />
    </>
  )
}
