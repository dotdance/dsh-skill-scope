import { useCallback, useState, type ReactNode } from 'react'
import { ApiError, post, ROUTES } from './api.ts'
import { CapabilityPanelBody, OfficialSkillsToggle, ViewBar } from './CapabilityPanel.tsx'
import { createDefaultTranslate } from './locales.ts'
import { isEnabled, toMcpRows, toSkillRows, type Domain } from './panel-model.ts'
import { usePolicyPanel } from './panel-state.ts'
import type { GlobalValue, Translate } from './types.ts'
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
 * **官方 skill 展示开关**（`showOfficialSkills`，存在全局策略里，两个面板同口径），
 * 以及保存响应「整体替换」的线上形状（全局响应就是完整的 `GlobalValue`）。
 */

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
    async (current: GlobalValue, next: GlobalValue): Promise<GlobalValue> =>
      post<GlobalValue>(ROUTES.globalSave, {
        mode: next.policy.mode,
        skills: next.policy.skills,
        mcps: next.policy.mcps,
        // 展示开关与名单一起提交：它存在同一个全局策略文件里，服务端按 revision 守卫。
        showOfficialSkills: next.policy.showOfficialSkills,
        revision: current.revision,
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    [sessionId],
  )

  /**
   * 翻转一项：**改数组**（名字在名单里 = 关）。
   *
   * 全局层没有「上层」，因此没有三态可言：开关只有开/关，写回的就是黑名单本身。
   */
  const toggle = useCallback(
    (current: GlobalValue, which: Domain, name: string, open: boolean): GlobalValue | null => {
      if (isEnabled(current.policy[which], name) === open) return null
      const updated = open
        ? current.policy[which].filter((item) => item !== name)
        : [...current.policy[which], name]
      return { ...current, policy: { ...current.policy, [which]: updated } }
    },
    [],
  )

  const load = useCallback(async (): Promise<GlobalValue> => loadGlobal(sessionId), [sessionId])

  const panel = usePolicyPanel<GlobalValue>({ load, save, toggle })

  /**
   * 展示开关：只改「官方 skill 列不列」，不改任何名字的开/关。
   *
   * 走 `panel.commit`（与名单开关同一条「乐观改 → 提交 → 失败回滚」通道），
   * 因为它在服务端与名单存在**同一个策略文件**里，共用 revision 守卫。
   * 打开后清单要等服务端回读才变（官方行由服务端过滤）——保存响应就是新的
   * 完整 `GlobalValue`，`usePolicyPanel` 会整体替换。
   */
  const setShowOfficialSkills = useCallback(
    (open: boolean) => {
      void panel.commit((current) =>
        current.policy.showOfficialSkills === open
          ? null
          : { ...current, policy: { ...current.policy, showOfficialSkills: open } },
      )
    },
    // `panel.commit` 自身由 `useCallback` 固定；不用 `panel`（每次渲染都是新对象）。
    [panel.commit],
  )

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

  const skillRows = toSkillRows(value.inventory.skills, (name) => isEnabled(value.policy.skills, name), t)
  const mcpRows = toMcpRows(value.inventory.mcps, (name) => isEnabled(value.policy.mcps, name), t)

  return (
    <div className={styles.panel} data-testid="global-panel">
      <div className={styles.header}>
        <h2 className={styles.title}>{t('global.title')}</h2>
      </div>

      {/*
        视图过滤器（全部 / 已启用 / 已禁用）：只筛列表，不写策略。
        官方 skill 展示开关挂在**同一行的右端**（`trailing`），不再单独占一行。
      */}
      <ViewBar
        view={panel.view}
        onChange={panel.setView}
        t={t}
        trailing={
          <OfficialSkillsToggle
            checked={value.policy.showOfficialSkills}
            onChange={setShowOfficialSkills}
            t={t}
          />
        }
      />

      <CapabilityPanelBody
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
