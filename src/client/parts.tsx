import { useState, type ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './styles.module.css'

/**
 * 面板共享的展示逻辑与小组件。
 *
 * 两个面板（全局面板、工作区弹层）共用同一个可切换能力列表与同一段回合提示，
 * 因此这一份共享实现保留在自己的模块里，由两个面板 import——而不是互相 import（那会成环）。
 * 入口文件同级、无 `panel/` 子目录。
 */

/** 一行可切换能力的展示模型（Skill 与 MCP 共用的形状）。 */
export interface CapabilityRow {
  name: string
  description: string
  /** 来源标签：「全局」/「本作用域」等（已翻译）。 */
  source: string
  /**
   * 该能力的**出处**：插件名（如 `superpowers-dsh`）或磁盘注册根绝对路径
   * （如 `~/node_modules/gbrain/skills`）。
   *
   * **与 `source` 是两个不同的字段，不可合并**：`source` 回答「这一行是全局层还是
   * 本作用域」（取值 `global`/`scope`，MCP 段在用），这里回答「这个东西是谁提供的」。
   * 原先详情行直接渲染服务端的 `source` 值（`custom`），对用户没有信息量。
   *
   * `undefined` = 这一行没有出处概念（MCP 行不填）→ 详情行**整行不渲染**，
   * 而不是渲染成空值，避免出现「来源：（空）」这种无信息的行。
   */
  origin?: string
  /**
   * 该行包含的成员名单（MCP 行的完整工具名 `mcp__<server>__<tool>`）。
   *
   * **可选**：Skill 行没有这个概念（不挂这个键），因此它是 `undefined`；MCP 行由
   * `toMcpRows` 挂上服务端的 `toolNames`。判定与 `origin` 同形——`undefined` 与空数组
   * 都导致**工具段整段不渲染**，而不是渲染成一个空标题，避免「工具：（空）」这种噪音行。
   * 空数组照实传进来也可以：`loader-only` server（挂了但没产出工具）就是这个情形，
   * 它已经在收起态的 `0 tools` 里说明了事实，展开区不必再重复一次。
   */
  tools?: string[]
  enabled: boolean
  /**
   * 这一行在本层被**显式改过**，且改的方向与上层（全局）不同。
   *
   * 只有工作区弹层会挂它：全局层没有上层，跨层差异无从谈起。挂上时卡片显然要给出
   * 视觉标记（`overriddenLabel` 的红色标签），否则用户看不出「这一项是我在本工程改的」
   * 还是「它本来就是这样」——两者在列表里长得完全一样。
   */
  overridden?: boolean
  /**
   * `true` 时**不渲染开关**（不变量 22/26：loader-only 或 restrictable:false 的行只读）。
   * 只读这一事实只由「没有开关」体现，卡片上不展示任何原因文案。
   */
  readonly?: boolean
  /**
   * 来源分组的稳定 key（服务端算好；注册根绝对路径，或 runtime skill 的哨兵值）。
   *
   * **可选**：MCP 行没有分组，Skill 行才有。`undefined` 表示「这一行不参与分组」。
   * 分组只在**全部可见行都有 `group`** 时才启用，所以两个面板可以共用同一段渲染：
   * 全局面板的 MCP 段与工作区弹层的 MCP 段会自动保持扁平，不会凭空多出一个空组。
   */
  group?: string
  /** 分组显示名（插件名或文件夹 basename）。`''` 表示「无来源」，由前端换成本地化文案。 */
  groupLabel?: string
}

export interface CapabilityListProps {
  /** 分段标题。 */
  title: string
  rows: readonly CapabilityRow[]
  /** 搜索框占位文案。 */
  searchPlaceholder: string
  /** 空列表文案。 */
  emptyText: string
  /** 切一项。只读行不会触发。 */
  onToggle(name: string, next: boolean): void
  /** 提供时给每行挂 `data-testid="${testIdPrefix}${name}"`。 */
  testIdPrefix?: string
  /** 分区标题元素的 id：供 `<section aria-labelledby>` 引用，让屏幕阅读器听出所在分区。 */
  sectionTitleId?: string
  /**
   * 外部搜索词（由面板顶部的单一搜索框传入）。
   *
   * **由外部传入而不是各自持有一份**：目标效果是「一个搜索框同时过滤技能与 MCP」，
   * 两个分区各留一个输入框会让同一个词要输两遍，且两个框的过滤状态无法一致。
   * 未传时退化为「不过滤」。
   */
  externalQuery?: string
  /** 已启用/已禁用状态 tag 的文案。 */
  enabledLabel: string
  disabledLabel: string
  /**
   * 「与全局不同」标记的文案（红色 tag）。
   *
   * 只有工作区弹层会出现这个标记；全局面板照样传一个——与其它标签同理，
   * 少传一处就会在那一处渲染出一个空 tag。
   */
  overriddenLabel: string
  /** 展开详情里「状态」这一行的键名。 */
  detailStateKey: string
  /** 展开详情里「来源」这一行的键名。 */
  detailSourceKey: string
  /**
   * 展开详情里「工具」这一行的键名。只在**行带 `tools` 且有内容**时才用到（即 MCP 行），
   * 但两个面板都传 —— 与 `ungroupedLabel` 同理：少传一处就会让那个面板的 MCP 展开区
   * 出现一行没有键名的值。
   */
  detailToolsKey: string
  /** 展开/收起按钮的可达名。 */
  expandLabel: string
  collapseLabel: string
  /** 分区计数后缀（如「项」）。为 `undefined` 时不显示计数后缀。 */
  countLabel?: string
  /**
   * 「无来源」分组的显示名（runtime 注入的 skill 没有路径，服务端给空 `groupLabel`）。
   * 只在分组启用时才用到；未传时该组会显示为空 —— 因此两个面板都必须传。
   */
  ungroupedLabel?: string
  /**
   * 详情行「来源」的**值**文案，用于没有磁盘出处的 skill（行上 `origin === undefined`）。
   *
   * 与 `ungroupedLabel` 分开是必要的：那个管**分组头**，这个管**详情值**。
   * 但两者不能各自为政 —— 若只传 `ungroupedLabel`，用户会在分组头看到「运行时注入」，
   * 展开后却在「来源」处看到一块空白，像是没加载出来。所以两个面板都传同一个键，
   * 由面板层决定（见 `GlobalPanel.tsx` / `WorkspaceModal.tsx` 的 `detailOriginRuntimeKey`）。
   */
  ungroupedOriginLabel?: string
}

/**
 * 转义正则元字符。
 *
 * 搜索框的内容会进 `RegExp`：不转义时用户输入 `(` 或 `[` 会抛 `SyntaxError`，
 * 把一个「输入过滤」变成白屏。这是审查里常见的真实缺陷，所以在这里一次性堵住。
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 一个内联 SVG 箭头（chevron）。**不引第三方图标库**：宿主模块表里没有它，引了会多打一份包。 */
function Chevron(props: { open: boolean; className?: string }): ReactNode {
  return (
    <svg
      className={props.className}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4 6.5L8 10.5L12 6.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 放大镜图标（搜索框内）。 */
export function SearchIcon(): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** 关闭图标（✕）。 */
export function CloseIcon(): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 四叶草（**空心线描**）—— 本插件的标识图标，**两个入口共用同一个**：
 * 侧栏 `sidebar.panellist` 的图标位与输入框右侧的工作区 chip。
 *
 * **为什么是四叶草而不是工具图形**：最初想画交叉的斧头与锤子，试了 8 轮都没成——
 * 两件工具的头部各需约 10×6px，在 16px 画布上还要留出交叉的柄，必然糊成一团灰块。
 * 旁证：Tabler 与 Lucide 都把 `hammer`、`axe` 作为**各自独立**的图标发布，
 * 没有一家提供交叉的那对——这个缺席本身就说明该构图在该尺寸下不成立。
 * 四叶草是一个紧凑的集中块面、无交叉结构，16px 下轮廓依然完整。
 *
 * **叶形要点（试错得到，勿轻易改）**：叶要**接近圆形**、外缘只有**浅凹口**，
 * 且内侧在圆心附近**相接**。走偏的两个反例：notch 加深会让它变成「四个心形花瓣」
 * 的花；叶子拉长再加宽又会变成「圆环套星」。
 *
 * **单色 `currentColor`**：图标会出现在两处继承色不同的位置
 * （侧栏未选中是次级色、选中/悬停是强调色，chip 是一颗按钮）。
 * 单一 `currentColor` 让它自动贴合任何一处的文字色，不会出现色块不一致。
 */
export function CloverIcon(props: { size?: number }): ReactNode {
  const size = props.size ?? 16
  /*
   * 一片朝上的叶，再绕中心 (12,12) 旋转 0/90/180/270 度拼成四叶。
   * 只写一遍路径数据，四个方向靠 `transform` 复用——改一处即四处同时生效。
   *
   * **这段路径数据是渲染验证过的，改前必须重新渲染确认**：
   * 它由参数化生成器产出（内半径 1.2 / 浅凹口 1.2 / 半宽 6.2），
   * 手工重排控制点极易漏掉 `Z` 之前的收口段，结果是四片叶子变成四根开钩——
   * 实测踩过一次。
   *
   * 线宽 1.7 是按 16px 显示尺寸定的（viewBox 24，实际约 1.13px）；
   * 更粗（≥2.2）会让四片挤在一起，更细（≤1.4）在深色下又会发虚。
   */
  const leaf =
    'M12 10.8C15.844 9.296 18.2 6.288 16.34 2.528' +
    'C14.604 0.836 13.24 2 12 2.6C10.76 2 9.396 0.836 7.66 2.528' +
    'C5.8 6.288 8.156 9.296 12 10.8Z'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      {[0, 90, 180, 270].map((angle) => (
        <path key={angle} d={leaf} transform={`rotate(${angle} 12 12)`} />
      ))}
    </svg>
  )
}

/**
 * 一张能力卡：开关 + 名称 + 状态 tag + 展开箭头，展开后显示描述与「状态」明细。
 *
 * **状态 tag 复用宿主 `Tag` 基元**（`tone="success"` / `"neutral"`），理由与原先的来源标签一致：
 * ① 主题与暗色由基元统一处理，自己写会漂移；② `Tag` 在宿主模块表里，`require` 命中单例，
 * 不会重复打包一份样式；③ 它让本 bundle 真的 import 了
 * `@deepseek-ai/dsh-client-ui-primitives`，而该包属于宿主 client baseline 的种子模块，
 * 运行期由宿主 shell 提供——这正是不需要在 `dsh.client.external` 里声明它的原因。
 */
function CapabilityCard(props: CapabilityListProps & { row: CapabilityRow; testId?: string }): ReactNode {
  const { row, testId } = props
  const [open, setOpen] = useState(false)
  const readonly = row.readonly === true
  const stateText = row.enabled ? props.enabledLabel : props.disabledLabel

  return (
    <li
      className={readonly ? `${styles.card} ${styles.cardDisabled}` : styles.card}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      <div className={styles.cardHead}>
        <div className={styles.cardMain}>
          {/*
            只读行**不渲染开关**（不变量 22/26）。但为了两列卡片的名称左边缘对齐，
            这里仍然占一个等宽的空位——否则只读卡的名字会比可切换卡往左跳一格。
          */}
          {readonly ? (
            <span className={styles.switch} aria-hidden="true" style={{ visibility: 'hidden' }} />
          ) : (
            <Switch
              checked={row.enabled}
              label={row.name}
              onChange={(next) => {
                props.onToggle(row.name, next)
              }}
            />
          )}
          <span className={styles.cardName} title={row.name}>
            {row.name}
          </span>
        </div>
        <div className={styles.cardTail}>
          {/*
            跨层差异标记：只在工作区弹层出现（全局层从不设置 `overridden`）。
            **颜色留给「跨层不一致」这一件事**，不表示错误——红色在这里是强调，
            状态本身仍由开关位置与 `stateText` 表达。这也照顾色弱用户：不必分辨红绿，
            读一眼文字「与全局不同」即可。
          */}
          {row.overridden === true ? (
            <span className={styles.overridden} data-testid="ws-overridden" title={props.overriddenLabel}>
              <Tag tone="danger">{props.overriddenLabel}</Tag>
            </span>
          ) : null}
          <Tag tone={row.enabled ? 'success' : 'neutral'}>{stateText}</Tag>
          <button
            type="button"
            className={styles.expandButton}
            aria-expanded={open}
            aria-label={`${open ? props.collapseLabel : props.expandLabel}: ${row.name}`}
            onClick={() => {
              setOpen((previous) => !previous)
            }}
          >
            <Chevron open={open} className={open ? `${styles.expandChevron} ${styles.expandChevronOpen}` : styles.expandChevron} />
          </button>
        </div>
      </div>
      {open ? (
        <div className={styles.cardBody}>
          {row.description === '' ? null : <p className={styles.cardDescription}>{row.description}</p>}
          <div className={styles.detailRow}>
            <span className={styles.detailKey}>{props.detailStateKey}</span>
            <span className={styles.detailValue}>{stateText}</span>
          </div>
          {/*
            工具名单：只在**有工具**时渲染。空数组与 `undefined` 同样整段不渲染 ——
            loader-only server 的 `0 tools` 已在收起态说明，展开后不该出现空标题。
            用 `<ul>`/`<li>` 而不是一串 `<span>`：这是清单，屏幕阅读器应当报出「N 项」，
            用户也能按列表逐条跳到某个工具名。
          */}
          {row.tools === undefined || row.tools.length === 0 ? null : (
            <div className={styles.detailRow}>
              <span className={styles.detailKey}>{props.detailToolsKey}</span>
              <ul className={styles.toolList}>
                {row.tools.map((toolName) => (
                  <li key={toolName} className={styles.toolName} title={toolName}>
                    {toolName}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/*
            出处只在**有出处概念**的行上渲染。判定用 `origin !== undefined || group !== undefined`：
            - `origin` 有值 → 直接渲染（插件名或磁盘注册根路径）；
            - `origin` 无值但 `group` 有值 → 这是一个 **runtime 注入的 skill**（服务端对
              无磁盘出处给了 `sourceLabel: null`），渲染本地化文案。**不能留空**：
              分组头写着「运行时注入」，展开后「来源」却是空白，用户会以为没加载出来；
            - 两者都无值 → MCP 行，完全没有出处概念 → 整行不渲染，避免「来源：（空）」。
          */}
          {row.origin === undefined && row.group === undefined ? null : (
            <div className={styles.detailRow}>
              <span className={styles.detailKey}>{props.detailSourceKey}</span>
              {/*
                值用 `.detailOrigin` 而不是 `.detailValue`：它可能是长绝对路径，需要任意位置
                断行。
                `title` 保留完整值：路径换行后仍可悬停看全文，也可选中复制。
              */}
              {row.origin === undefined ? (
                <span className={styles.detailOrigin}>{props.ungroupedOriginLabel ?? ''}</span>
              ) : (
                <span className={styles.detailOrigin} title={row.origin}>
                  {row.origin}
                </span>
              )}
            </div>
          )}
        </div>
      ) : null}
    </li>
  )
}

/**
 * 把行按 `group` 归拢，并**保持组内原有顺序**。
 *
 * 组的先后按**首次出现**决定，不排序：服务端的清单已按 skill 名做过稳定排序
 * （`compareSkillSummary`），组内顺序因此与扁平视图一致。组间用「首次出现」而不是
 * 按名字排序，是为了让顺序与清单同源 —— 换一次排序就会让用户折叠过的组跳位置。
 */
function groupRows(rows: readonly CapabilityRow[]): Array<{ key: string; label: string; rows: CapabilityRow[] }> {
  const order: string[] = []
  const buckets = new Map<string, CapabilityRow[]>()
  for (const row of rows) {
    const key = row.group ?? ''
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = []
      buckets.set(key, bucket)
      order.push(key)
    }
    bucket.push(row)
  }
  return order.map((key) => ({
    key,
    label: buckets.get(key)?.[0]?.groupLabel ?? '',
    rows: buckets.get(key) ?? [],
  }))
}

/** 一行都不缺 `group` 时才启用分组。空列表不分组（没有行可归拢）。 */
function groupsEnabled(rows: readonly CapabilityRow[]): boolean {
  return rows.length > 0 && rows.every((row) => row.group !== undefined)
}

/**
 * 计数文案 `启用量/总量`。**分区标题与分组头共用这一份**，两处口径不许分叉。
 *
 * 两个数都取自**同一批可见行**（搜索过滤之后），所以搜索时两个数一起变小 ——
 * 不会出现「4/34」而屏幕上只剩 3 张卡片。
 *
 * 只读行（MCP 的未加载 / 不可限制项）照样计入总量与启用数：它们也是列表里实实在在
 * 占了一格的东西，从总量里扣掉会让「这一组有几个」对不上眼前的卡片数。
 */
function countText(rows: readonly CapabilityRow[]): string {
  return `${rows.filter((row) => row.enabled).length}/${rows.length}`
}

/**
 * 一段可切换能力列表。折叠状态由本组件自己持有（默认展开），调用方不干预。
 *
 * **不变量 21（承重）**：这里**没有**按名字自由添加的输入框。用户只能切换清单里**已经存在**
 * 的名字；添加不存在的名字既没有输入口，也没有对应的写入字段。搜索框只做**过滤**，不产生新条目。
 *
 * 版式：分区头（标题 + 计数 + 折叠箭头）→ 两列卡片网格。搜索框在面板顶部统一渲染，
 * 本组件只接收 `externalQuery` 做过滤，因此「技能」与「MCP」被同一个词同时过滤。
 *
 * **来源分组（可选）**：当每一行都带 `group` 时，卡片不再平铺，而是按组渲染成若干
 * 可独立折叠的小节（见 `SkillGroups`）。只要有一行缺 `group`，整段就保持扁平 ——
 * 这样 MCP 段与工作区弹层的 MCP 段自动不受影响，两个面板共用同一段实现。
 */
export function CapabilityList(props: CapabilityListProps): ReactNode {
  const { rows, testIdPrefix } = props
  const [open, setOpen] = useState(true)

  const query = (props.externalQuery ?? '').trim()
  const matcher = query === '' ? null : new RegExp(escapeRegExp(query), 'i')
  const visible = matcher === null ? rows : rows.filter((row) => matcher.test(row.name))

  return (
    <section
      className={styles.section}
      /*
       * `<section>` 只有在有可达名时才映射为 `region` 地标。把标题 id 接上 `aria-labelledby`
       * 有两个好处：屏幕阅读器可以把每个分段当独立地标跳转；测试也能用
       * `getByRole('region', { name: 'Skill' })` 精确定位到某一个分段。
       */
      {...(props.sectionTitleId === undefined ? {} : { 'aria-labelledby': props.sectionTitleId })}
    >
      <div className={styles.sectionHead}>
        <button
          type="button"
          className={styles.sectionToggle}
          aria-expanded={open}
          onClick={() => {
            setOpen((previous) => !previous)
          }}
        >
          {/*
            标题用 `<span>` 而不是 `<h3>`：它被包在 `<button>` 里，而 `<button>` 的内容模型
            是「短语内容」，放标题元素是无效 HTML（浏览器会把它拆出按钮，导致
            `getByRole('button', { name })` 取不到完整名字）。分区标题的可达名由
            `<section aria-labelledby>` 指到按钮本身来提供，语义不变。
          */}
          <span className={styles.sectionTitle} id={props.sectionTitleId}>
            {props.title}
          </span>
          <span className={styles.sectionCount} data-testid={`${testIdPrefix ?? ''}count`}>
            {props.countLabel === undefined
              ? countText(visible)
              : `${countText(visible)} ${props.countLabel}`}
          </span>
          <span className={open ? `${styles.sectionChevron} ${styles.sectionChevronOpen}` : styles.sectionChevron}>
            <Chevron open={open} />
          </span>
        </button>
      </div>
      {open ? (
        visible.length === 0 ? (
          <p className={styles.empty}>{props.emptyText}</p>
        ) : groupsEnabled(visible) ? (
          <SkillGroups
            groups={groupRows(visible)}
            section={props}
            {...(testIdPrefix === undefined ? {} : { testIdPrefix })}
          />
        ) : (
          <ul className={styles.cards}>
            {visible.map((row) => (
              <CapabilityCard
                key={row.name}
                {...props}
                row={row}
                {...(testIdPrefix === undefined ? {} : { testId: `${testIdPrefix}${row.name}` })}
              />
            ))}
          </ul>
        )
      ) : null}
    </section>
  )
}

/**
 * 按来源分组的卡片区：每组一个小节头（组名 + 项数 + 折叠箭头）+ 两列卡片网格。
 *
 * **每组各自持有一份折叠状态**（`openGroups` 是 `Set` 而不是单个布尔）：用户折叠
 * `gbrain` 那一组之后，不该把 `superpowers` 也一起折掉——那样「视觉分组」就退化成
 * 「整段折叠」，批量浏览反而更费事。
 *
 * **默认全部展开**：需求是「方便批量管理」，进去先看到全貌再决定折哪一组；
 * 默认折叠会让用户每进一次都要先点开 6 组。
 */
function SkillGroups(params: {
  groups: Array<{ key: string; label: string; rows: CapabilityRow[] }>
  section: CapabilityListProps
  testIdPrefix?: string
}): ReactNode {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const toggle = (key: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div
      className={styles.groups}
      {...(params.testIdPrefix === undefined ? {} : { 'data-testid': `${params.testIdPrefix}groups` })}
    >
      {params.groups.map((group) => {
        const open = !collapsed.has(group.key)
        /*
         * 组名兜底：服务端对「无路径」的 runtime skill 给 `groupLabel: ''`。
         * 直接渲染空串会得到一个光秃秃的箭头，用户不知道折的是什么，因此换成本地化文案
         * （`group.ungrouped`）。这里**不回落到 key** —— 那是给无路径组用的哨兵值
         * （`\u0000ungrouped`），渲染出来是一串控制字符。
         */
        const label = group.label === '' ? (params.section.ungroupedLabel ?? '') : group.label
        return (
          <section key={group.key} className={styles.group} data-testid={`group:${group.key}`}>
            <button
              type="button"
              className={styles.groupToggle}
              aria-expanded={open}
              onClick={() => {
                toggle(group.key)
              }}
            >
              <span className={styles.groupChevron} data-open={open ? 'true' : 'false'}>
                <Chevron open={open} />
              </span>
              {/* `title` 给的是**分组 key**（绝对路径），鼠标悬停能看到它到底指哪个目录 —— 
                  显示名只留 basename / 插件名，两个不同的 `skills` 目录可能同名。 */}
              <span className={styles.groupTitle} title={group.key}>
                {label}
              </span>
              {/*
                `启用/总量`：只显示总数「34」时，用户看不出这一组被关掉了几项。
                文案由 `countText` 统一产出，与分区标题用的是同一份实现。
              */}
              <span className={styles.groupCount}>{countText(group.rows)}</span>
            </button>
            {open ? (
              <ul className={styles.cards}>
                {group.rows.map((row) => (
                  <CapabilityCard
                    key={row.name}
                    {...params.section}
                    row={row}
                    {...(params.testIdPrefix === undefined ? {} : { testId: `${params.testIdPrefix}${row.name}` })}
                  />
                ))}
              </ul>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}

/**
 * 开关。**用 `<button role="switch" aria-checked>` 而不是 `<input type="checkbox">`**：
 * 测试按 `getByRole('switch', { name })` 取它，并且断言 `aria-checked` **实体属性**的值
 * （`toHaveProperty('aria-checked', 'true')`）。checkbox 的 `aria-checked` 是浏览器隐式映射，
 * 在 jsdom 下读不到实体属性，会让「断言回滚」这条用例变成假绿。
 *
 * 结构为**两层**：外层 `button` 透明、只管命中与无障碍；内层 track/thumb 两个 `span` 画视觉。
 * 两个内层 `span` 都是 `aria-hidden` 的纯装饰——可达名由 `button` 的 `aria-label` 提供，
 * 不能让屏幕阅读器把轨道与滑块也念一遍。改结构的原因见 `styles.module.css` 的 `.switch` 注释。
 */
export function Switch(props: { checked: boolean; label: string; onChange: (next: boolean) => void }): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className={props.checked ? `${styles.switch} ${styles.switchOn}` : styles.switch}
      onClick={() => {
        props.onChange(!props.checked)
      }}
    >
      <span className={styles.switchTrack} aria-hidden="true">
        <span className={styles.switchThumb} />
      </span>
    </button>
  )
}

/** 可重试的错误条（Review Focus 6：失败必须可见且可重试，绝不白屏）。 */
export function ErrorAlert(props: { message: string; retryLabel: string; onRetry: () => void }): ReactNode {
  return (
    <div className={styles.alert} role="alert">
      <span>{props.message}</span>
      <button type="button" className={styles.button} onClick={props.onRetry}>
        {props.retryLabel}
      </button>
    </div>
  )
}
