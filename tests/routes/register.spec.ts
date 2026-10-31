import { describe, expect, it, vi } from 'vitest'
import { registerRoutes, ROUTES, type FetchRegisterFace } from '../../src/routes/register.ts'
import type { RouteDeps } from '../../src/routes/handlers.ts'
import type { PluginContextLike } from '../../src/routes/session.ts'

function deps(): RouteDeps {
  return {
    store: {} as RouteDeps['store'],
    states: {} as RouteDeps['states'],
    skills: { snapshot: async () => ({ skills: [], complete: true }) },
    tools: { schemas: () => [], view: () => ({ restrictableNames: new Set<string>() }) },
    loaderServers: async () => [],
    logger: { warn: () => {} },
    ctx: { get: () => undefined, logger: { warn: () => {} } },
    reapplyAfterSave: async () => {},
  }
}

function context() {
  const warnings: string[] = []
  const ctx: PluginContextLike = { get: () => undefined, logger: { warn: (message) => warnings.push(message) } }
  return { ctx, warnings }
}

type Deferred = { promise: Promise<void>; resolve: () => void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('registerRoutes cleanup', () => {
  it('waits for every async route disposer', async () => {
    const pending = Array.from({ length: 4 }, deferred)
    const dispose = vi.fn((index: number) => pending[index]?.promise ?? Promise.resolve())
    const paths: string[] = []
    const fetchRegister: FetchRegisterFace = { register: (spec) => { paths.push(spec.path); return () => dispose(paths.length - 1) } }
    const { ctx } = context()
    const cleanup = registerRoutes(ctx, deps(), fetchRegister)
    const done = cleanup()
    let settled = false
    void done.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    for (const item of pending) item.resolve()
    await expect(done).resolves.toBeUndefined()
    expect(paths.sort()).toEqual(Object.values(ROUTES).sort())
    expect(dispose).toHaveBeenCalledTimes(4)
  })

  it('isolates disposer rejection and logs it', async () => {
    const second = deferred()
    const failure = new Error('route close failed')
    let index = 0
    const { ctx, warnings } = context()
    const cleanup = registerRoutes(ctx, deps(), {
      register: () => {
        const current = index++
        return current === 1 ? () => Promise.reject(failure) : () => second.promise
      },
    })
    const done = cleanup()
    second.resolve()
    await expect(done).resolves.toBeUndefined()
    expect(warnings.some((message) => message.includes('route close failed'))).toBe(true)
  })

  it('is idempotent and invokes each disposer once', async () => {
    const dispose = vi.fn(async () => {})
    const { ctx } = context()
    const cleanup = registerRoutes(ctx, deps(), { register: () => dispose })
    await Promise.all([cleanup(), cleanup()])
    expect(dispose).toHaveBeenCalledTimes(4)
  })

  it('logs registration failure and still cleans registered routes', async () => {
    const dispose = vi.fn(async () => {})
    let index = 0
    const { ctx, warnings } = context()
    const cleanup = registerRoutes(ctx, deps(), {
      register: (spec) => {
        if (index++ === 2) throw new Error(`cannot register ${spec.path}`)
        return dispose
      },
    })
    await cleanup()
    expect(dispose).toHaveBeenCalledTimes(3)
    expect(warnings.some((message) => message.includes('注册路由失败'))).toBe(true)
  })
})
