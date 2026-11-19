import type { Context } from '@deepseek-ai/cordis'

/** 一次监听器注册的记录。 */
export interface RegisteredListener {
  event: string
  listener: (...args: unknown[]) => unknown
}

/** 测试用的最小 Context 替身。 */
export interface FakeContext {
  /** 可被 `get(name)` 取到的服务表。默认空表，因此没有 `connection`。 */
  services: Record<string, unknown>
  listeners: Map<string, RegisteredListener[]>
  effects: Array<() => unknown>
  /** `inject` 回调**返回**的 disposer：cordis 在服务 churn / 卸载时会调它们。 */
  injectDisposers: Array<() => unknown>
  /** 已登记但**依赖不齐**、尚未执行的 inject 回调（真实 cordis 会等依赖在册）。 */
  pendingInjects: Array<{ names: readonly string[]; run: () => void }>
  /** 所有 inject 登记（含已执行的），`churn()` 靠它重跑。 */
  injectRegistrations: Array<{ names: readonly string[]; run: () => void }>
  /** 回调抛错：真实 cordis 走 `logger.error` + fiber state 3，替身记在这里（不是 `warnings`）。 */
  errors: string[]
  warnings: string[]
  get(serviceName: string): unknown
  on(event: string, listener: (...args: never[]) => unknown): () => void
  effect(callback: () => unknown): () => void
  inject(names: readonly string[], callback: () => void | (() => unknown)): void
  /** 模拟宿主在装配之后才提供某个服务：依赖齐了的回调会被执行。 */
  provide(serviceName: string, value: unknown): void
  /** 模拟服务 churn：先调已收集的 disposer，再重跑声明了这些服务的 inject 回调。 */
  churn(names: readonly string[]): void
  logger: { warn(message: string): void; info(message: string): void; error(message: string): void }
}

/** 触发某个事件的所有监听器，返回每个监听器的返回值。 */
export function emit(ctx: FakeContext, event: string, ...args: unknown[]): unknown[] {
  return (ctx.listeners.get(event) ?? []).map((entry) => entry.listener(...args))
}

/** 替身的行为开关。 */
export interface FakeContextOptions {
  /**
   * 模仿 cordis：`inject` 回调**不在同步栈里执行**，而是排进微任务
   * （`Fiber._reload()` 在 `await Promise.resolve()` 之后才 `_execute`）。
   *
   * **默认 `false`（同步执行）**，因为大多数单测只想拿接线的结果。但凡是「装配返回后
   * 立刻调 disposer」的用例必须打开它：同步执行恰好抹掉了真实时序，测不出
   * 「交出去的是值快照而不是转发函数」这类缺陷（`src/assembly.ts` 的 `disposeRoutes`）。
   *
   * **本替身不模仿的 cordis 行为**（读源 + 真 cordis 4.0.6-alpha.1 探针实测；清单**不穷举**，
   * 至少包含下面四条，别当成已覆盖）：
   * ① 依赖不在册时回调**永不执行**；服务被移除后又提供时回调会**再执行一次**，
   *    并先调用上一次回调**返回的** disposer（`tests/assembly.spec.ts` 的 churn 用例靠
   *    `injectDisposers` 手工模拟）。
   * ② 卸载发生在微任务之前时，cordis 用 epoch 检查**取消**这次执行（`lib/index.js:1373-1382`：
   *    `await Promise.resolve(); if (this._runner.epoch === oldEpoch) …`）；本替身照跑，
   *    所以「卸载先于注册」的泄漏在这个替身下不可观测。
   * ③ 真 `inject` 是 `plugin({ inject, apply })` 的糖（`lib/index.js:1626-1632`）：回调实参是
   *    `(ctx, config)`、返回 `Fiber`；本替身是 `callback()` 无实参、返回值被当作 disposer。
   * ④ 回调抛错时 cordis 走 `ctx.logger.error` 并把 `_error` / `state` 置为失败
   *    （`lib/index.js:1383-1387`）；本替身只 `warnings.push`（warn 级），所以「装配期异常等级」
   *    在单测里不可观测。
   */
  deferInject?: boolean
}

/**
 * 造一个只含 `inject` 所列服务的最小 Context 替身。
 * 返回类型带上 `Context` 以便直接传给 `apply`；测试可从返回值上读 `services` / `listeners`。
 */
export function makeFakeCtx(
  services: Record<string, unknown> = {},
  options: FakeContextOptions = {},
): Context & FakeContext {
  const listeners = new Map<string, RegisteredListener[]>()
  const effects: Array<() => unknown> = []
  const injectDisposers: Array<() => unknown> = []
  const pendingInjects: Array<{ names: readonly string[]; run: () => void }> = []
  const injectRegistrations: Array<{ names: readonly string[]; run: () => void }> = []
  const errors: string[] = []
  const warnings: string[] = []
  const ctx: FakeContext = {
    services,
    listeners,
    effects,
    injectDisposers,
    pendingInjects,
    injectRegistrations,
    errors,
    warnings,
    get: (serviceName) => services[serviceName],
    on: (event, listener) => {
      const entry: RegisteredListener = { event, listener: listener as (...args: unknown[]) => unknown }
      listeners.set(event, [...(listeners.get(event) ?? []), entry])
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== entry))
      }
    },
    effect: (callback) => {
      effects.push(callback)
      const disposer = callback()
      return typeof disposer === 'function' ? (disposer as () => void) : () => {}
    },
    /*
     * `inject` 的三条真实契约，替身逐条照做：
     *
     * ① **依赖不齐就不执行**。cordis `_refresh()` 让 epoch 停在 INACTIVE
     *    （`lib/index.js:1317-1328`），`_reload()` 比对 epoch 后直接 return（`:1375`）。
     *    替身不看 `names` 就调回调的话，把 `ctx.inject(['connection'], …)` 里的服务名
     *    拼错（`'connetion'`）在生产上等于 4 条路由静默缺失（面板打开是宿主 404 body），
     *    单测里却照样注册、永远绿。
     * ② **返回的 disposer 由宿主收下**，churn / 卸载时宿主先调它再重跑
     *    （`_unload` 的 `_disposables.clear().map(runDisposable)`，`:1397`）。替身收进
     *    `injectDisposers`，`churn()` 模拟「先释放、后重跑」。
     * ③ **回调抛错不是 warn**：cordis 走 `logger.error` 并把 fiber 置 `state 3` / `_error`
     *    （`:1383-1393`），且不重试。替身记进 `errors`，别混进 `warnings`
     *    （`warnings` 是 `ctx.logger.warn` 的落点，两者级别不同，混用会让「装配半死」
     *    看起来只是一条软告警）。
     */
    inject: (names, callback) => {
      const run = (): void => {
        let disposer: unknown
        try {
          disposer = callback()
        } catch (error) {
          // 不冒成 uncaught：否则一个用例的失败会污染同文件其它用例
          // （实测曾表现为整文件的 `Errors 1 error`）。
          errors.push(String(error))
          return
        }
        if (typeof disposer === 'function') injectDisposers.push(disposer as () => unknown)
      }
      injectRegistrations.push({ names, run })
      if (names.some((serviceName) => services[serviceName] === undefined)) {
        pendingInjects.push({ names, run })
        return
      }
      if (options.deferInject !== true) {
        run()
        return
      }
      queueMicrotask(run)
    },
    provide: (serviceName, value) => {
      services[serviceName] = value
      for (const entry of [...pendingInjects]) {
        if (entry.names.some((name) => services[name] === undefined)) continue
        pendingInjects.splice(pendingInjects.indexOf(entry), 1)
        entry.run()
      }
    },
    churn: (names) => {
      for (const dispose of injectDisposers.splice(0)) {
        try {
          dispose()
        } catch (error) {
          errors.push(String(error))
        }
      }
      // 重跑：真实 cordis 由 `_setEpoch` → `_unload` 释放后，再由 `_reload` 重新 `_execute`。
      // 这里同步重跑**全部**声明了这些服务的回调（含已经跑过的那些），够用来验证
      // 「新闭包必须接管 `disposeRoutes`」这条不变量。
      for (const entry of injectRegistrations) {
        if (!entry.names.every((name) => names.includes(name))) continue
        for (const pending of [...pendingInjects]) {
          if (pending.run === entry.run) pendingInjects.splice(pendingInjects.indexOf(pending), 1)
        }
        entry.run()
      }
    },
    logger: {
      warn: (message) => {
        warnings.push(message)
      },
      info: () => {},
      error: (message) => {
        errors.push(message)
      },
    },
  }
  return ctx as unknown as Context & FakeContext
}
