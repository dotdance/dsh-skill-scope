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
  warnings: string[]
  get(serviceName: string): unknown
  on(event: string, listener: (...args: never[]) => unknown): () => void
  effect(callback: () => unknown): () => void
  inject(names: readonly string[], callback: () => void): void
  logger: { warn(message: string): void; info(message: string): void }
}

/** 触发某个事件的所有监听器，返回每个监听器的返回值。 */
export function emit(ctx: FakeContext, event: string, ...args: unknown[]): unknown[] {
  return (ctx.listeners.get(event) ?? []).map((entry) => entry.listener(...args))
}

/**
 * 造一个只含 `inject` 所列服务的最小 Context 替身。
 * 返回类型带上 `Context` 以便直接传给 `apply`；测试可从返回值上读 `services` / `listeners`。
 */
export function makeFakeCtx(services: Record<string, unknown> = {}): Context & FakeContext {
  const listeners = new Map<string, RegisteredListener[]>()
  const effects: Array<() => unknown> = []
  const warnings: string[] = []
  const ctx: FakeContext = {
    services,
    listeners,
    effects,
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
    inject: (_names, callback) => {
      callback()
    },
    logger: {
      warn: (message) => {
        warnings.push(message)
      },
      info: () => {},
    },
  }
  return ctx as unknown as Context & FakeContext
}
