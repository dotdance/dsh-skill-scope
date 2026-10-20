import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { GlobalPanel } from './GlobalPanel.tsx'
import { en, NS, withParams, zh } from './locales.ts'
import { CloverIcon } from './parts.tsx'
import type { Translate, UseSessionLike } from './types.ts'
import { WorkspaceChip, WorkspaceModal } from './WorkspaceModal.tsx'

/**
 * 客户端入口。
 *
 * ## 四个注册面与它们的理由
 *
 * 1. `sidebar.panellist` / `skill-scope` —— 设计 7.1 要求入口**从侧栏可达**。
 *    `sidebar.panellist` 的每个 list id 对应一个 `main` 面板 key，侧栏按钮由 sidebar 服务
 *    自己渲染、标签也由它从 list metadata 解析。
 * 2. `main` / `skill-scope` —— 全局面板本体。**必须与 ① 用同一个 id**：
 *    少注册 `main` 会让侧栏按钮指向一个不存在的面板（`ui-layout` 的 `selectPanel`
 *    对未注册的 key 直接抛错）。
 * 3. `conversation.input.right` / `skill-scope-workspace` —— 工作区入口 chip。
 * 4. `shell.overlay` / `skill-scope-workspace-modal` —— 工作区弹层。
 *    `shell.overlay` 是 frame 级浮动层（`ui-layout` 的 SlotMap：`{ kind: 'list', scope: 'root' }`），
 *    root scope、不绑会话，正适合一个覆盖全 frame 的弹层。
 *
 * ③④ 的注册是**无条件**的；「只在空白会话显示」由 ③ 的组件在**渲染期**判断
 * （不变量 24 / C2：空白会话才代表「还没装配过、策略还能改」）。
 * **不能在注册期判断**：会话绑定只在渲染期经槽位 props 到达（见 `apply` 内的说明）。
 *
 * ## 为什么用 `slots.inject` 而不是直接 `slots.register`
 *
 * 官方两段式。`inject(name, cb)` 把注册的生命周期绑到「该槽位可用」这一条件上，
 * 槽位被卸载时注册会被自动回收。直接 `register` 会在槽位尚未存在时注册失败或泄漏。
 *
 * ## 结构性类型（**不 import 任何 DSH 客户端包**）
 *
 * `@deepseek-ai/dsh-client-*` 全部不在本仓库的 `dependencies`/`devDependencies` 里
 * （它们是宿主的 client baseline 种子模块，由宿主 shell 直接提供）。
 * 因此这里声明一个**最小结构面** `ClientContextLike`，只包含本插件真正调用的成员。
 * 好处有两个：编译期不依赖宿主包；单测可以用纯对象替身（见 `tests/support/fake-client-ctx.ts`）。
 */

/** 槽位注册选项的最小结构面（官方 `BaseOptions` + list/keyed 的 `KindOptions`）。 */
export interface SlotRegisterOptions {
  name: string
  /** list 槽位的条目 id。 */
  id?: string
  /** keyed 槽位的 key（`main` 是 keyed）。 */
  key?: string
  order?: number
  label?: () => string
  locale?: string
  store?: unknown
  inject?: () => Record<string, unknown>
}

/** `slots` 注册面。`register` 返回**幂等** disposer；`inject` 把注册绑到槽位可用性上。 */
export interface SlotsFace {
  register(options: SlotRegisterOptions, component: (props: never) => ReactNode): () => void
  inject(name: string, callback: () => unknown): () => void
}

/** `layout` 面。`selectPanel` 只在目标 key **已注册**后调用（未注册的 key 会抛错）。 */
export interface LayoutFace {
  selectPanel(panelId: string): void
}

/** `locale` 面。`register` 返回 disposer；`bind` 给出取值器。 */
export interface LocaleFace {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): Translate
}

/** `effect` 面：注册一个随插件卸载一起释放的副作用。 */
export interface EffectFace {
  effect(callback: () => unknown, label?: string): () => void
}

/**
 * 本插件需要的最小客户端 Context 面。**导出**它，因为测试要按它造替身，
 * 且未来若要写客户端集成测试可以直接复用（而不是在测试里重新声明一遍形状）。
 *
 * 注意：**会话状态不从这里读**。会话作用域槽位的会话绑定由宿主在**渲染期**注入组件
 * props（`sessionId` / `useSession`），而不是挂在 Context 上的服务——
 * 早先版本按 `ctx.get('sessionState')` 读，因该服务不存在而致工作区入口从未注册。
 */
export interface ClientContextLike {
  slots: SlotsFace
  layout: LayoutFace
  locale: LocaleFace
  effect(callback: () => unknown, label?: string): () => void
  /**
   * cordis 的可选服务读取入口。
   *
   * **必须走 `get`，不能读属性**：cordis 的服务是注入代理，读一个未在
   * `inject` 里声明的服务属性会**直接抛错**（实测
   * `cannot get property "sessionState" without inject`），而不是返回 `undefined`。
   * 因此 `ctx.sessionState === undefined` 这种防御写法永远不会执行到——
   * 取值本身就炸了。`ctx.get(name)` 是官方给「可选依赖」用的形式：
   * 缺服务时返回 `undefined`。
   */
  get(name: string): unknown
}

/** 插件要求宿主提供的服务名。与 `package.json` 的 `dsh.client.inject` **不同**：
 * 那是包名图（依赖哪些客户端包），这里是 cordis 服务名（`slots`/`layout`/`locale`）。 */
export const inject = ['slots', 'layout', 'locale'] as const

/** 槽位 id 常量。**侧栏与 main 共用同一个 id**，避免「侧栏按钮指向不存在的面板」。 */
export const PANEL_ID = 'skill-scope'
export const WORKSPACE_CHIP_ID = 'skill-scope-workspace'
export const WORKSPACE_MODAL_ID = 'skill-scope-workspace-modal'

/**
 * 装配客户端插件：注册词条与三个槽位，返回 `undefined`。
 *
 * `effect` 顺序**有依赖**：locale 必须先注册，否则下面 `bind` 出来的取值器在
 * 首帧拿不到词条（会闪一段 key 文本）。这不是致命错误，但顺序是免费的。
 */
export function apply(ctx: ClientContextLike): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`)
  const bind = ctx.locale.bind(NS)
  const t: Translate = (key, params) => withParams(bind(key), params)

  // --- 全局面板：侧栏可达 + main 面板 ---
  // `sidebar.panellist` 的 id 必须与 `main` 的 key 一致：sidebar 用这个 id 找面板并解析标签。
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        label: () => t('panel.label'),
      },
      /*
       * 侧栏按钮本体由 sidebar 服务渲染，**这里的组件就是它的图标位**。
       * 槽位传入 `{ size, active }`：展开态 16、折叠态 18（`lib/client.js:190` 实测），
       * 图标必须跟随这个 size，否则折叠成 56px 轨道时图标会偏小。
       */
      ((props: { size?: number }) => <CloverIcon size={props.size} />) as unknown as (
        props: never,
      ) => ReactNode,
    ),
  )

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
      },
      // 面板本体不需要会话绑定：全局视图与工程无关。
      (() => <GlobalPanel t={t} />) as unknown as (props: never) => ReactNode,
    ),
  )

  // --- 工作区 chip + 弹层 ---
  //
  // **注册是无条件的，空白判断发生在渲染期**。
  //
  // 教训（实测缺陷）：这里原先在**注册期**用 `ctx.get('sessionState')` 判断空白会话。
  // 但 DSH 里**不存在**名为 `sessionState` 的 cordis 服务（全安装检索零命中），
  // 于是它恒为 `undefined`，入口**从未注册**——工作区控制 UI 因此完全不显示。
  //
  // 正确机制（会话作用域槽位的官方契约）：宿主在**渲染期**把会话绑定注入组件 props ——
  // `props.sessionId` 与 `props.useSession`（`session` hook 经 `standardHookPropName`
  // 映射为 `useSession`）。空白与否取自 `useSession(s => s.blank)`。
  // 因此注册是无条件的，空白判断放在组件内：`if (blank !== true) return null`。
  //
  // 弹层与 chip 一起注册：`shell.overlay` 是 root scope 的常驻浮动层，注册一次即可，
  // 开合只是它内部的一次重渲染，不需要反复注册/注销。
  // root scope **拿不到** `props.sessionId`（该标准面属会话作用域），
  // 因此弹层的会话 id 由 chip 在渲染期写入下面的可变引用。

  // 开合状态放在闭包里，用订阅通知已注册的槽位重渲染（槽位注册只有一次）。
  let open = false
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const readOpen = (): boolean => open

  /** 会话 id 在渲染期由槽位标准 props 给出，注册期还没有；用可变引用承接。 */
  let sessionId: string | undefined

  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: WORKSPACE_CHIP_ID,
        order: 30,
      },
      ((props: { sessionId?: string; useSession?: UseSessionLike; useSyncExternalStore?: never }) => {
        sessionId = props.sessionId
        return (
          <WorkspaceChip
            hasSession={typeof props.sessionId === 'string' && props.sessionId !== ''}
            t={t}
            {...(props.useSession === undefined ? {} : { useSession: props.useSession })}
            onOpen={() => {
              open = true
              notify()
            }}
          />
        )
      }) as unknown as (props: never) => ReactNode,
    ),
  )

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: WORKSPACE_MODAL_ID,
        order: 50,
      },
      (() => {
        const isOpen = useSyncExternalStore(subscribe, readOpen, readOpen)
        if (!isOpen) return null
        return (
          <WorkspaceModal
            sessionId={sessionId ?? ''}
            t={t}
            onClose={() => {
              open = false
              notify()
            }}
          />
        )
      }) as unknown as (props: never) => ReactNode,
    ),
  )
}
