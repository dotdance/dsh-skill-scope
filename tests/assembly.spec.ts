import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { assemble, readLoaderServers, type AssemblyContext } from '../src/assembly.ts'
import { apply, inject, name } from '../src/index.ts'
import { makeFakeCtx, type FakeContext } from './support/fake-ctx.ts'

/**
 * 装配层单测。
 *
 * **这一层为什么必须单独测**：`src/index.ts` 的 `apply()` 早期是 Task-1 骨架，
 * 只打一行日志、从不调用 `registerRoutes()` / `installAgentHooks()`。
 * 下层（routes/handlers、agent/hooks、policy/store）各自都有单测且全绿，
 * **但没有任何用例断言「它们被接线了没有」**，于是「插件根本不注册路由」这个缺陷
 * 一路漏到运行期——实测症状是工作区控制 UI 打不开（`/api/skill-scope/workspace` 返回
 * 宿主的 404 body `{"error":"Not Found"}`，不是插件的 `bad_request`）。
 * 本文件补的就是这个缺口。
 */

/** 宿主 inject 保证到场的三个服务，用最小替身顶上。 */
function hostServices(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    skills: { snapshot: async () => ({ skills: [], complete: true }) },
    tools: {
      schemas: () => [],
      view: () => ({ restrictableNames: new Set<string>() }),
      restrict: () => () => {},
    },
    agents: { get: () => undefined },
    ...extra,
  }
}

/** 一个记录 `path` 的 connection.fetch 替身。 */
function recordingConnection(registered: string[], dispose: () => void = () => {}): Record<string, unknown> {
  return {
    fetch: {
      register: (spec: { path: string }) => {
        registered.push(spec.path)
        return dispose
      },
    },
  }
}

describe('assemble：路由接线', () => {
  it('registers exactly the four API routes, all with the /api prefix', () => {
    const registered: string[] = []
    const ctx = makeFakeCtx(hostServices({ connection: recordingConnection(registered) }))

    assemble(ctx as unknown as AssemblyContext)

    // 宿主按完整 pathname 匹配：少写 `/api` 前缀是「静默 404」，不会自动补全。
    expect([...registered].sort()).toEqual([
      '/api/skill-scope/global',
      '/api/skill-scope/global/save',
      '/api/skill-scope/workspace',
      '/api/skill-scope/workspace/save',
    ])
  })

  it('releases every route through disposeRoutes', () => {
    const registered: string[] = []
    const dispose = vi.fn()
    const ctx = makeFakeCtx(hostServices({ connection: recordingConnection(registered, dispose) }))

    const assembly = assemble(ctx as unknown as AssemblyContext)
    expect(() => assembly.disposeRoutes()).not.toThrow()

    expect(dispose).toHaveBeenCalledTimes(4)
  })
})

describe('assemble：事件接线', () => {
  it('subscribes the four events the execution layer depends on', () => {
    const ctx = makeFakeCtx(hostServices())
    assemble(ctx as unknown as AssemblyContext)

    // `agent/created` 是串行派发，收窄必须挂在这里才能早于首次装配（设计 5.2）。
    // 后两个事件名是**斜杠**：必须与宿主 emit 逐字一致，写成点号会静默收不到（见 hooks.ts 注册处注释）。
    expect([...ctx.listeners.keys()].sort()).toEqual(['agent/created', 'agent/disposed', 'skills/change', 'tools/change'])
  })

  it('releases every listener through disposeHooks', () => {
    const ctx = makeFakeCtx(hostServices())
    const assembly = assemble(ctx as unknown as AssemblyContext)
    expect([...ctx.listeners.values()].every((entries) => entries.length === 1)).toBe(true)

    expect(() => assembly.disposeHooks()).not.toThrow()

    // 断言每条事件都**退光**，而不是断言 `listeners.size === 0`：
    // 替身的 `on` 用 `listeners.set(event, filtered)`，退订后 Map 里仍留着空数组这个键，
    // 所以 `size` 永远是 4，拿它当断言测的是替身的实现细节而不是行为。
    expect([...ctx.listeners.values()].every((entries) => entries.length === 0)).toBe(true)
  })

  it('keeps the hooks when there is no connection service (design 不变量 12)', () => {
    const ctx = makeFakeCtx(hostServices())
    expect(ctx.get('connection')).toBeUndefined()

    expect(() => assemble(ctx as unknown as AssemblyContext)).not.toThrow()

    // 路由是可选能力，执行层不是。headless profile 下必须照样装监听器。
    expect(ctx.listeners.has('agent/created')).toBe(true)
  })

  it('warns but does not throw when connection exists without fetch.register', () => {
    const ctx = makeFakeCtx(hostServices({ connection: {} }))

    expect(() => assemble(ctx as unknown as AssemblyContext)).not.toThrow()
    expect(ctx.warnings.some((message) => message.includes('fetch'))).toBe(true)
  })
})

describe('readLoaderServers', () => {
  it('keeps only @deepseek-ai/dsh-mcp-client rows and reads their serverName', async () => {
    const ctx = makeFakeCtx(
      hostServices({
        loader: {
          entries: () => [
            { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'gbrain' } } },
            { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'context7' } } },
            { options: { name: '@deepseek-ai/dsh-tool-mcp', config: { serverName: 'not-this-one' } } },
          ],
        },
      }),
    )

    const rows = await readLoaderServers(ctx as unknown as AssemblyContext)()
    expect([...rows].sort()).toEqual(['context7', 'gbrain'])
  })

  it('returns an empty list when the loader is absent', async () => {
    const ctx = makeFakeCtx(hostServices())
    await expect(readLoaderServers(ctx as unknown as AssemblyContext)()).resolves.toEqual([])
  })

  it('returns an empty list when the loader throws, instead of failing the route', async () => {
    const ctx = makeFakeCtx(
      hostServices({
        loader: {
          entries: () => {
            throw new Error('loader exploded')
          },
        },
      }),
    )

    // loader 读不出来只该少几行只读项，不能让整条 `/workspace` 路由 500。
    await expect(readLoaderServers(ctx as unknown as AssemblyContext)()).resolves.toEqual([])
  })
})

describe('plugin entry：apply 接线', () => {
  it('declares its identity and hard dependencies', () => {
    expect(name).toBe('dsh-skill-scope')
    // 不含 `sessionQuery`：headless profile 没有它，写进 inject 会让插件停在 waiting。
    expect(inject).toEqual(['skills', 'tools', 'agents'])
  })

  it('registers routes and hooks from apply(), not just a log line', () => {
    // 回归守卫：把 apply() 退回「只打日志的骨架」会让这条立刻失败。
    const registered: string[] = []
    const ctx = makeFakeCtx(hostServices({ connection: recordingConnection(registered) }))

    apply(ctx as unknown as Context)

    expect(registered.length).toBe(4)
    expect(ctx.listeners.has('agent/created')).toBe(true)
    // 三条 effect：`apply` 自己的两条（disposeHooks / disposeRoutes）
    // 加 `installAgentHooks` 内部那条 `ctx.effect(() => stopAll)`（src/agent/hooks.ts:331）。
    expect(ctx.effects.length).toBe(3)
  })

  it('applies without any optional service present', () => {
    const ctx = makeFakeCtx()

    expect(() => apply(ctx as unknown as Context)).not.toThrow()
    // 硬依赖缺失是宿主 inject 的责任；这里只验证可选缺失不炸。
    expect(ctx.listeners.has('agent/created')).toBe(true)
  })
})
