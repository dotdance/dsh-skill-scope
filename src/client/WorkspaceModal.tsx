import { useCallback, useState, type ReactNode } from 'react'
import { ApiError, post, ROUTES } from './api.ts'
import {
  ViewBar,
  WiredCapabilityBody,
  createDefaultTranslate,
  toMcpRows,
  toSkillRows,
  usePolicyPanel,
  type Translate,
} from './CapabilityPanel.tsx'
import type { GlobalValue, WorkspaceValue } from './GlobalPanel.tsx'
import { CloseIcon, CloverIcon } from './parts.tsx'
import styles from './styles.module.css'

/**
 * 工作区入口：输入框右侧的 chip + 点击后打开的弹层。
 *
 * **不变量 5（承重）**：工作区清单必须由**服务端**以 `scope: agent` 读取。
 * 客户端只传 `sessionId`——把 agent 对象塞进请求体既不可能（不可序列化）也不该做。
 * 面板因此不自行拼清单，只渲染服务端给的 `inventory`。
 *
 * **不变量 24 / C2**：无 live Agent 时**不许**假装是实时视图（必须出现「非实时」）。
 * 空白会话**有** live Agent，所以它是**实时**路径——两者不能混为一谈。
 *
 * 本文件是**外壳**：行派生、开关接线、视图条、列表主体都在 `CapabilityPanel.tsx`，
 * 与全局面板共用。这里只剩工作区弹层独有的部分——`overlay`+`modal` 外壳、关闭按钮、
 * 实时性提示、顶部说明段（末尾带「被全局关闭」计数），以及保存响应「只合并 revision 与 policy」。
 */

/**
 * 工作区返回体的完整形状：`WorkspaceValue` + 一个可选的 UI 辅助字段。
 *
 * 曾经这里还有 `inherited: { total, disabledGlobally }` 与一个 `deriveInherited` 本地推导，
 * 供 MCP 段顶部那句「继承自全局：N 项（全局已关闭 M 项）」使用。2026-10-14 那行按用户
 * 要求删除（两处面板都删），`inherited` 因此**不再被面板读取**——服务端仍在返回它
 * （`buildWorkspaceView`），保留是为了不改线上形状；前端不声明它就不会误用。
 */
export interface WorkspaceRouteValue extends WorkspaceValue {
  disabledGlobally?: string[]
}

export interface WorkspaceModalProps {
  sessionId: string
  onClose: () => void
  /** 取值器；缺省时查内置中文词条。 */
  t?: Translate
}

/** 取工程名：`cwd` 的 basename。用 `/` 与 `\` 都切，避免宿主报一个 Windows 路径时整条标题变成完整路径。 */
function projectNameOf(cwd: string): string {
  const parts = cwd.split(/[/\\]/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? cwd
}

/** 读工作区路由。**只传 sessionId**（不变量 5：scope 由服务端给）。 */
async function loadWorkspace(sessionId: string): Promise<WorkspaceRouteValue> {
  const value = await post<WorkspaceRouteValue>(ROUTES.workspace, { sessionId })
  if (value === null || typeof value !== 'object' || value.inventory === null || typeof value.inventory !== 'object') {
    throw new ApiError('network', '工作区视图形状非法')
  }
  return value
}

export function WorkspaceModal(props: WorkspaceModalProps): ReactNode {
  const [fallbackTranslate] = useState(createDefaultTranslate)
  const t = props.t ?? fallbackTranslate
  const sessionId = props.sessionId

  /**
   * 保存：工作区路由**只返回可合并的字段**，因此注入 `mergeSaved` 只取 `revision`
   * 与 `policy`，绝不整体替换视图。
   *
   * 设计 6.2 规定保存路由只返回 `{ revision }`。而读取路由返回的是**视图快照**：
   * `exists` / `cwd` / `policyPath` / `inventory` / `live` —— 这些是「读取那一刻」的事实。
   * 保存响应**不能**用来覆盖它们：
   * - 本仓库 host 侧（`src/routes/handlers.ts`）出于方便会把整个 `WorkspaceValue` 回吐，
   *   其中的 `exists` 是**写文件之前**采集的旧值，拿它覆盖会把状态行改错。
   * - 真实场景里 `exists` 是对的（保存后文件确实存在了），但**界面此刻仍应显示用户做出
   *   这次保存所依据的状态**，否则「未创建，保存后创建」会在保存后瞬间变成「已有策略」，
   *   用户就看不出这次保存到底创建了什么。
   *
   * 因此只合并 `revision`（下一次保存的乐观锁依据）与 `policy`（服务端规范化后的名单，
   * 比如排序、去重、上限截断）。其余视图字段保留读取时的那一份。
   */
  const save = useCallback(
    async (current: WorkspaceRouteValue, nextPolicy: GlobalValue['policy']): Promise<WorkspaceRouteValue> =>
      post<WorkspaceRouteValue>(ROUTES.workspaceSave, {
        sessionId,
        mode: nextPolicy.mode,
        skills: nextPolicy.skills,
        mcps: nextPolicy.mcps,
        revision: current.revision,
      }),
    [sessionId],
  )

  const mergeSaved = useCallback(
    (previous: WorkspaceRouteValue, saved: WorkspaceRouteValue): WorkspaceRouteValue => ({
      ...previous,
      revision: saved.revision,
      ...(saved.policy === undefined ? {} : { policy: saved.policy }),
    }),
    [],
  )

  const load = useCallback(async (): Promise<WorkspaceRouteValue> => loadWorkspace(sessionId), [sessionId])

  const panel = usePolicyPanel<WorkspaceRouteValue>({ load, save, mergeSaved })

  const refresh = (): void => {
    void panel.refresh()
  }

  const value = panel.value

  if (value === null) {
    return (
      <div className={styles.overlay} role="dialog" aria-modal="true" data-testid="workspace-modal">
        <div className={styles.modal}>
          <div className={styles.panelHead}>
            {panel.loadFailed ? (
              <p className={styles.empty} role="alert">
                {panel.error}
              </p>
            ) : (
              <p className={styles.empty}>{t('state.loading')}</p>
            )}
          </div>
        </div>
      </div>
    )
  }

  /*
   * 被全局关闭的名单由服务端给（`disabledGlobally`，skill 名 + MCP server 名并集）。
   * 2026-10-14 之后它**只剩一个用处**：`toMcpRows` 的 `excludeNames` —— 全局关掉的 MCP
   * 整条不出现在列表里（全局层是硬上限）。原先它还喂段尾那句「被全局关闭 N 项」的计数，
   * 那句按用户要求删掉了。
   *
   * 缺省时退回 `[]`：旧版服务端不给这个字段时，宁可让一条本该被摘除的 MCP 照常显示
   * （可见的过度授予），也不要凭空摘掉一条用户配的项（静默失效更糟）。
   */
  const disabledGlobally = value.disabledGlobally ?? []
  const skillRows = toSkillRows(value.inventory.skills, value.policy.skills, t)
  const mcpRows = toMcpRows(value.inventory.mcps, value.policy.mcps, t, disabledGlobally)
  const project = projectNameOf(value.cwd)

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" data-testid="workspace-modal">
      <div className={styles.modal}>
        <div className={styles.panelHead}>
          <div className={styles.header}>
            <h2 className={styles.title}>{t('workspace.title').replace('{project}', project)}</h2>
            <button
              type="button"
              className={styles.closeButton}
              aria-label={t('action.close')}
              data-testid="workspace-close"
              onClick={() => {
                props.onClose()
              }}
            >
              <CloseIcon />
            </button>
          </div>

          {/*
            说明段兼任「非实时」告知（不变量 24 / C2）：无 live Agent 时必须给出理由，
            不能只挂一个徽章让用户猜。实时时用中性说明，非实时时追加那句提示。
            两者合并成一段，是为了对齐目标效果「头部只有标题 + 一段说明」的形状。

            2026-10-14（后一次改动）：段首加「下面是未被全局禁用的项」，同时**删掉段尾那句
            「被全局关闭 N 项」计数** —— 用户明确要求按此文案收口，全屏不再报关闭项数。
            代价是「被全局关掉几项」这个信息不再有任何位置呈现：列表只是变短。
          */}
          <p className={styles.intro}>
            {value.live ? (
              t('workspace.intro')
            ) : (
              <>
                {/*
                  「非实时」必须是**独立可定位的文本节点**：不变量 24 要求这一段可被单独断言，
                  屏幕阅读器也会把它当作一句独立的警示来读。写进同一个字符串插值里
                  会让 `findByText('非实时')` 永远匹配不到（text is broken up by multiple elements）。
                */}
                <strong className={styles.introWarn} data-testid="workspace-not-live">
                  {t('state.notLive')}
                </strong>{' '}
                {t('state.notLiveHint')} {t('workspace.intro')}
              </>
            )}
          </p>
          {value.live ? <span hidden data-testid="workspace-live" /> : null}

          {/* 视图过滤器（全部 / 已启用 / 已禁用）：只筛列表，不写策略。 */}
          <ViewBar view={panel.view} onChange={panel.setView} t={t} />
        </div>

        <div className={styles.panelBody}>
          <div className={styles.body}>
            <WiredCapabilityBody
              t={t}
              panel={panel}
              skills={skillRows}
              mcps={mcpRows}
              onRetry={refresh}
              mcpTestIdPrefix="mcp-"
              skillTestIdPrefix="ws-skill-"
              searchInputId="skill-scope-ws-search"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 输入框右侧的 chip。
 *
 * **不变量 24 / C2（承重）**：chip 只在**空白会话**出现。会话一旦有了内容，
 * 就不该再给「为这个工程配策略」的入口——那会让用户以为改动只影响当前对话。
 * 判定取自槽位标准 props 的 `useSession`（会话状态由宿主提供，不在这里猜）。
 */
export interface WorkspaceChipProps {
  sessionId?: string
  /** 会话订阅钩子；由 `conversation.input.right` 槽位的标准 props 提供。 */
  useSession?: (selector: (state: { blank: boolean }) => boolean) => boolean
  t?: Translate
  /** 是否有可用会话。没有会话时 chip 不渲染（它不是全局面板的一部分）。 */
  hasSession: boolean
  onOpen: () => void
}

export function WorkspaceChip(props: WorkspaceChipProps): ReactNode {
  const [fallbackTranslate] = useState(createDefaultTranslate)
  const t = props.t ?? fallbackTranslate
  // 默认「不空白」：拿不到会话状态时**不**渲染入口，而不是默认出现（误开入口比少一个入口更糟）。
  const blank = props.useSession === undefined ? false : props.useSession((state) => state.blank)
  if (!props.hasSession || !blank) return null
  return (
    <button type="button" className={styles.chip} data-testid="workspace-chip" onClick={props.onOpen}>
      {/*
        与侧栏「全局 Skills」条目**同一个图标**（用户要求两处一致）。
        尺寸这里取 15：chip 的字号比侧栏行略小，16 会显得图标压过文字。
      */}
      <CloverIcon size={15} />
      {t('action.open')}
    </button>
  )
}
