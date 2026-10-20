/**
 * 面板的**数据层**：`usePolicyPanel` 与它的入参/出参类型。
 *
 * 只管数据，不碰 JSX。两个外壳（全局面板、工作区弹层）用同一个 hook，把「保存的
 * 线上形状与合并策略」作为参数注入 —— 这是两层唯一真正不同的地方。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Domain, PolicyView } from './panel-model.ts'


/** 把任意抛出物收成一句可展示的文案：`Error` 取 message，其余 `String()`。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// --- 数据 hook ---

/**
 * 面板数据骨架：加载一次，改动走「乐观改 → 提交 → 成功合并/失败回滚」。
 *
 * 两层返回体的形状不同（全局是完整值、工作区是 `{global, workspace}`），而
 * **只有 `revision` 与提交/合并的规则是共用的**，所以 `TValue` 不受约束，
 * 读写规则由外壳注入。
 *
 * `revision` 三态：`null` 表示「我期望文件还不存在」，**不可折叠成 `undefined`**
 * —— 那会改变服务端的乐观锁守卫语义。
 */
export type PolicyPanelOptions<TValue> = {
  /** 读取。外壳用 `useCallback` 保证引用稳定。 */
  load: () => Promise<TValue>
  /**
   * 提交一次改动。收到的是**整个新值**，不是「新策略」。
   *
   * 两层形状不同，把它们硬塞进一个共同字段只会逼出一层适配代码：
   * 全局写 `{mode, skills[], mcps[]}`，工作区写 `{workspace: {skills: {}, mcps: {}}}`。
   */
  save: (current: TValue, next: TValue) => Promise<TValue>
  /**
   * 把一项翻到**指定**目标状态，返回新值；`null` 表示「目标状态已达成，不发请求」。
   *
   * 这是两层唯一真正不同的地方：全局改数组（在/不在），工作区改表（键在则用表值，
   * 不在则跟随全局）。
   */
  toggle: (current: TValue, which: Domain, name: string, open: boolean) => TValue | null
  /** 保存成功后的值合并。省略则整体替换（全局即如此）。 */
  mergeSaved?: ((current: TValue, saved: TValue) => TValue) | undefined
}

export type PolicyPanelState<TValue> = {
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
  commit: (mutate: (current: TValue) => TValue | null) => Promise<void>
  /** 翻转一个名字到**指定**目标状态（不是盲翻转，避免连点导致状态发散）。 */
  toggle: (name: string, next: boolean, which: Domain) => void
}

/**
 * 加载 + 三件改动操作。
 *
 * 回滚依赖**提交时刻捕获的快照**，不是 `value` 的闭包 —— 后者在连续快速点击时会拿到
 * 过期的值，回滚到更早的状态。提交串行化（`chain`），避免并发写入互相覆盖。
 */
export function usePolicyPanel<TValue>({
  load,
  save,
  toggle: applyToggle,
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
    async (mutate: (current: TValue) => TValue | null): Promise<void> => {
      // 同步读镜像 ref（见上方 `valueRef` 注释：updater 里取值是错的）。
      const current = valueRef.current
      if (current === null) return
      const next = mutate(current)
      // 目标状态已达成：不改（返回 `null`），避免无谓写入。
      if (next === null) return
      setValue(next)
      setBusy(true)
      const snapshot: TValue = current
      chain.current = chain.current
        .then(() => save(snapshot, next))
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
    (name: string, next: boolean, which: Domain) => {
      void commit((current) => applyToggle(current, which, name, next))
    },
    [commit, applyToggle],
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

