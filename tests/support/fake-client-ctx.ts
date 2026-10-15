/**
 * 客户端 Context 的测试替身（`src/client/index.tsx` 的 `apply` 收的那种）。
 *
 * **为什么不复用 `tests/support/fake-ctx.ts`**：那个替身是**宿主侧**的，只声明
 * `get/on/effect/inject/logger`。客户端的 `apply` 需要的是另一套面（`slots`/`layout`/`locale`），
 * 两套面没有交集，硬塞进一个类型只会让两边都变糊。这里单独造一个客户端替身。
 *
 * **为什么只记录不执行**：`slots.register` 返回 disposer、`slots.inject` 会回调注册函数；
 * 测试关心的是「注册了什么」（名字/id/order），不是「渲染成什么」。因此替身把 `inject`
 * 实现为**立即回调**（与官方行为一致：槽位可用即注册），把 `register` 实现为记录 + 返回 disposer。
 */

/** 一次槽位注册的可读快照（形状来自官方 `BaseOptions` + `KindOptions`）。 */
export interface SlotRegistration {
  name: string
  id?: string
  key?: string
  order?: number
  label?: () => string
  [field: string]: unknown
}

/** 客户端 `apply` 真正用到的 Context 面（纯结构性，不 import 任何 DSH 包）。 */
export interface FakeClientContextOptions {
  /** 每次 `slots.register` 时回调，供断言收集。 */
  onSlotRegister?: (options: SlotRegistration) => void
  /** 每次 `layout.selectPanel(panelId)` 时回调。 */
  onSelectPanel?: (panelId: string) => void
  /** `locale.bind(ns)` 的替身：把 key 原样返回（测试断言的是 key 或中文词条）。 */
  translate?: (key: string) => string
}

/**
 * 造一个最小客户端 Context 替身。
 * 结构性满足 `ClientContextLike`；返回值上带 `slotRegistrations` / `selectPanelCalls` / `effects` 便于断言。
 */
export function makeFakeClientCtx(options: FakeClientContextOptions = {}) {
  const slotRegistrations: SlotRegistration[] = []
  const selectPanelCalls: string[] = []
  const effects: Array<() => unknown> = []
  const localeRegistrations: Array<{ ns: string; dicts: unknown }> = []
  const translate = options.translate ?? ((key: string) => key)

  const ctx = {
    slotRegistrations,
    selectPanelCalls,
    effects,
    localeRegistrations,
    slots: {
      register(registration: SlotRegistration): () => void {
        slotRegistrations.push(registration)
        options.onSlotRegister?.(registration)
        return () => {
          const index = slotRegistrations.indexOf(registration)
          if (index >= 0) slotRegistrations.splice(index, 1)
        }
      },
      inject(_name: string, callback: () => unknown): () => void {
        // 官方行为：槽位可用时立刻调用注册回调，并把它的 disposer 接过来。
        const disposer = callback()
        return typeof disposer === 'function' ? (disposer as () => void) : () => {}
      },
    },
    layout: {
      selectPanel(panelId: string): void {
        selectPanelCalls.push(panelId)
        options.onSelectPanel?.(panelId)
      },
    },
    locale: {
      register(ns: string, dicts: unknown): () => void {
        localeRegistrations.push({ ns, dicts })
        return () => {}
      },
      bind(_ns: string): (key: string) => string {
        return translate
      },
    },
    effect(callback: () => unknown, _label?: string): () => void {
      effects.push(callback)
      const disposer = callback()
      return typeof disposer === 'function' ? (disposer as () => void) : () => {}
    },
    /**
     * 模拟 cordis 的**可选服务**读取入口，必须与真实宿主一致。
     *
     * 真实 cordis 的服务是注入代理：读一个**未在 `inject` 里声明**的服务属性会
     * 直接抛错（实测 `cannot get property "sessionState" without inject`），
     * 而不是返回 `undefined`。所以生产代码只能走 `ctx.get(name)`。
     * 这个替身**故意只提供 `get`、不提供任何服务属性**，
     * 好让「不小心改回属性读取」在测试里立刻失败。
     * 见 `src/client/index.tsx` 的 `ClientContextLike.get` 注释。
     *
     * **不提供 `sessionState`**：那个服务在 DSH 里根本不存在。
     * 曾经的 `get('sessionState') → { blank }` 替身给了生产代码一个假契约，
     * 掩盖了「入口从未注册」的缺陷。现在返回 `undefined`，与真实宿主一致。
     */
    get(_name: string): unknown {
      return undefined
    },
  }

  return ctx
}
