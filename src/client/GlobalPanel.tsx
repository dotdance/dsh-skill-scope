import { useCallback, useState, type ReactNode } from 'react'
import { ApiError, post, ROUTES } from './api.ts'
import {
  ViewBar,
  WiredCapabilityBody,
  createDefaultTranslate,
  toMcpRows,
  toSkillRows,
  usePolicyPanel,
  type PolicyValue,
  type Translate,
} from './CapabilityPanel.tsx'
import styles from './styles.module.css'

/**
 * 全局能力面板。
 *
 * **不变量 4（承重）**：这里只渲染 `snapshot({})` 的返回行——即宿主 `readGlobalSkills` 的结果。
 * 请求体里**没有** `cwd`、**没有** `scope`，所以工程级 provider 不会混进来。
 * 面板也绝不自行向 anywhere 追加未被清单返回的名字。
 *
 * **不变量 21**：只切换清单里已有的名字，没有自由文本添加口。
 *
 * 本文件是**外壳**：行派生、开关接线、视图条、列表主体都在 `CapabilityPanel.tsx`，
 * 与工作区弹层共用。这里只剩全局面板独有的部分——`styles.panel` 外壳、标题、
 * `rev` 提示、以及保存响应「整体替换」的线上形状。
 */

/**
 * `CapabilityRow` 在 `parts.tsx`、`Translate` 在共享内核（`CapabilityPanel.tsx`）。
 * 这里只转发 `CapabilityRow`：`WorkspaceModal` 已从本模块取 `GlobalValue`，
 * 让它为这一个类型多开一条 import 路径没有收益。
 */
export type { CapabilityRow } from './parts.tsx'

/** 与宿主 `GlobalValue` / `WorkspaceValue` 同形的返回体（结构性声明，不 import 宿主代码）。 */
interface SkillRowValue {
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

interface McpRowValue {
  serverName: string
  toolCount: number
  /** 该 server 的完整工具名 `mcp__<server>__<tool>`；服务端已去重排序（`McpRow.toolNames`）。 */
  toolNames: string[]
  source: 'global' | 'scope'
  restrictable: boolean
  loaded: boolean
}

interface InventoryValue {
  skills: SkillRowValue[]
  mcps: McpRowValue[]
}

/**
 * 面板消费的策略视图。字段名与 `src/routes/handlers.ts` 的 `GlobalValue` 逐一对应。
 */
export interface GlobalValue extends PolicyValue {
  policy: { mode: 'blacklist'; skills: string[]; mcps: string[] }
  inventory: InventoryValue
}

/** 工作区视图 = 全局视图 + 工程信息。由 `WorkspaceModal` 消费。 */
export interface WorkspaceValue extends GlobalValue {
  cwd: string
  policyPath: string
  exists: boolean
  /** 该会话当前是否有 live Agent。`false` ⇒ 必须显示「非实时」。 */
  live: boolean
}

/** 组件对外属性。`sessionId` 可选：全局面板与具体会话无关（仅随保存请求透传）。 */
export interface GlobalPanelProps {
  sessionId?: string
  /** 取值器；缺省时查内置中文词条。 */
  t?: Translate
}

/**
 * 读路由返回体并做最小形状校验；形状不对时当作传输失败（宁可报错也不要渲染半张界面）。
 *
 * 异常文案统一交给共享内核的 `describeError`（`ApiError` 的 message 已是可读文案），
 * 这里不再自带一份同名不同实现的包装。
 */
async function loadGlobal(sessionId: string | undefined): Promise<GlobalValue> {
  // **不传 cwd、不传 scope**：不变量 4 要求全局清单只来自 snapshot({})。
  const value = await post<GlobalValue>(ROUTES.global, sessionId === undefined ? {} : { sessionId })
  if (value === null || typeof value !== 'object' || value.inventory === null || typeof value.inventory !== 'object') {
    throw new ApiError('network', '全局视图形状非法')
  }
  return value
}

export function GlobalPanel(props: GlobalPanelProps): ReactNode {
  // `createDefaultTranslate()` 每次渲染都新建一个函数会让 `useCallback` 的依赖永远变化，
  // 于是下面的加载与提交每帧重建。这里用惰性初值把它钉成一次。
  const [fallbackTranslate] = useState(createDefaultTranslate)
  const t = props.t ?? fallbackTranslate
  const sessionId = props.sessionId

  /**
   * 保存：全局路由的响应就是**完整的** `GlobalValue`，因此整体替换（不注入 `mergeSaved`）。
   *
   * `revision` 三态：`null` 表示「我期望文件还不存在」。原样透传，不做 `??` 折叠——
   * 把 `null` 折成 `undefined` 会改变服务端的守卫语义。
   */
  const save = useCallback(
    async (current: GlobalValue, nextPolicy: GlobalValue['policy']): Promise<GlobalValue> =>
      post<GlobalValue>(ROUTES.globalSave, {
        mode: nextPolicy.mode,
        skills: nextPolicy.skills,
        mcps: nextPolicy.mcps,
        revision: current.revision,
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    [sessionId],
  )

  const load = useCallback(async (): Promise<GlobalValue> => loadGlobal(sessionId), [sessionId])

  const panel = usePolicyPanel<GlobalValue>({ load, save })

  const refresh = (): void => {
    void panel.refresh()
  }

  const value = panel.value

  if (value === null) {
    return (
      <div className={styles.panel} data-testid="global-panel">
        <h2 className={styles.title}>{t('global.title')}</h2>
        {panel.error === null ? (
          <p className={styles.empty}>{t('state.loading')}</p>
        ) : (
          <p className={styles.empty} role="alert">
            {panel.error}
          </p>
        )}
      </div>
    )
  }

  const skillRows = toSkillRows(value.inventory.skills, value.policy.skills, t)
  const mcpRows = toMcpRows(value.inventory.mcps, value.policy.mcps, t)

  return (
    <div className={styles.panel} data-testid="global-panel">
      <div className={styles.header}>
        <h2 className={styles.title}>{t('global.title')}</h2>
      </div>

      {/* 视图过滤器（全部 / 已启用 / 已禁用）：只筛列表，不写策略。 */}
      <ViewBar view={panel.view} onChange={panel.setView} t={t} />

      <WiredCapabilityBody
        t={t}
        panel={panel}
        skills={skillRows}
        mcps={mcpRows}
        onRetry={refresh}
        mcpTestIdPrefix="mcp-"
        skillTestIdPrefix="skill-"
        searchInputId="skill-scope-global-search"
      />
    </div>
  )
}
