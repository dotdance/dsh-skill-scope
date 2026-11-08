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
   * 必须是纯函数，可能用于预览、保存及重放。返回值表示操作是否成功；
   * 保存失败或被取消时返回 false，让调用方跳过成功后的刷新。
   */
  commit: (mutate: (current: TValue) => TValue | null) => Promise<boolean>
  /** 翻转一个名字到**指定**目标状态（不是盲翻转，避免连点导致状态发散）。 */
  toggle: (name: string, next: boolean, which: Domain) => void
}

/**
 * 加载 + 三件改动操作。
 *
 * 保存时从最近一次成功的服务端状态重算操作；成功后重放尚未发送的操作，
 * 失败则取消本批剩余操作并回滚到最近确认的状态。
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

  // 已确认的服务端状态与待保存操作队列。
  const confirmed = useRef<TValue | null>(null)
  const pending = useRef<Array<{
    mutate: (current: TValue) => TValue | null
    done: (success: boolean) => void
  }>>([])
  const running = useRef(false)
  const refreshPending = useRef(false)
  const saveFailed = useRef(false)
  const generation = useRef(0)
  const valueRef = useRef<TValue | null>(null)

  // 卸载后不再 setState；每次 refresh 递增以重新触发加载。
  const alive = useRef(true)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    // StrictMode 会重放 setup → cleanup → setup；每次 setup 都恢复当前挂载状态。
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (!alive.current) return
    if (running.current) {
      refreshPending.current = true
      return
    }
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    if (running.current) {
      refreshPending.current = true
      return
    }
    let current = true
    const startedAt = generation.current
    setError(null)
    setLoadFailed(false)
    load().then(
      (loaded) => {
        if (current && alive.current) {
          // 读取期间发生了保存：这份响应可能已过期，等队列清空后重新读。
          if (startedAt !== generation.current) {
            if (!saveFailed.current) void refresh()
            return
          }
          confirmed.current = loaded
          valueRef.current = loaded
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
  }, [nonce, load, refresh])

  // 同步更新镜像，确保同一渲染周期内的连续操作也能累积。
  const publish = useCallback((next: TValue): void => {
    valueRef.current = next
    if (alive.current) setValue(next)
  }, [])

  const commit = useCallback(
    async (mutate: (current: TValue) => TValue | null): Promise<boolean> => {
      const current = valueRef.current
      if (current === null || !alive.current) return false
      const next = mutate(current)
      if (next === null) return true
      generation.current++
      publish(next)
      setBusy(true)
      const completion = new Promise<boolean>((done) => pending.current.push({ mutate, done }))
      if (!running.current) {
        running.current = true
        void (async () => {
          try {
            while (pending.current.length > 0) {
              const operation = pending.current[0]
              if (operation === undefined) break
              const base = confirmed.current ?? current
              const target = operation.mutate(base)
              if (target !== null) {
                const saved = await save(base, target)
                confirmed.current = mergeSaved === undefined ? saved : mergeSaved(target, saved)
              }
              saveFailed.current = false
              pending.current.shift()
              operation.done(true)
              // 服务端结果只更新确认状态，尚未发送的操作仍保留在界面上。
              let preview = confirmed.current ?? base
              for (const queued of pending.current) preview = queued.mutate(preview) ?? preview
              publish(preview)
              if (alive.current) setError(null)
            }
          } catch (cause: unknown) {
            // 自动刷新不能清掉本批失败提示；后续由用户主动重载。
            refreshPending.current = false
            saveFailed.current = true
            const cancelled = pending.current.splice(0)
            publish(confirmed.current ?? current)
            if (alive.current) setError(describeError(cause))
            for (const operation of cancelled) operation.done(false)
          } finally {
            running.current = false
            if (alive.current) {
              setBusy(false)
              if (refreshPending.current) {
                refreshPending.current = false
                setNonce((n) => n + 1)
              }
            }
          }
        })()
      }
      return completion
    },
    [save, mergeSaved, publish],
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

