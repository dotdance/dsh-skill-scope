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

/** 一个记录 `path` 的 connection.fetch 替身；`dispose` 由调用方决定。 */
function recordingConnection(registered: string[], dispose: () => Promise<void> = async () => {}): Record<string, unknown> {
  return {
    fetch: {
      register: (spec: { path: string }) => {
        registered.push(spec.path)
        return dispose
      },
    },
  }
}

/**
 * **每条路由一个独立句柄**的 connection 替身：每次被调用都把 path 记进 `handled`。
 *
 * 为什么需要它：`recordingConnection` 让 4 条路由共用同一个 `dispose`，
 * `toHaveBeenCalledTimes(4)` 于是无法区分「4 条各自释放一次」与「同一条释放 4 次」，
 * 也发现不了解放错对象。要断言「每条路由各自被释放」，句柄必须一一对应。
 *
 * **故意不幂等**：宿主真实的 disposer 是幂等的，但替身若也去重，「重复 dispose 不重复
 * 释放」这条断言就变成替身自己的性质、而不是 `src/assembly.ts` 里 `released` 守卫的性质
 * （实测：替身自带去重时，删掉 `released` 守卫用例仍然全绿）。去重是**被测方**的责任。
 */
function perRouteConnection(registered: string[], handled: string[]): Record<string, unknown> {
  return {
    fetch: {
      register: (spec: { path: string }) => {
        registered.push(spec.path)
        return async () => {
          handled.push(spec.path)
        }
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

  it('releases every route through disposeRoutes', async () => {
    const registered: string[] = []
    const handled: string[] = []
    const ctx = makeFakeCtx(hostServices({ connection: perRouteConnection(registered, handled) }))

    const assembly = assemble(ctx as unknown as AssemblyContext)
    await expect(assembly.disposeRoutes()).resolves.toBeUndefined()

    // 逐条释放，且每条恰好一次（用共用句柄只能数次数，见 `perRouteConnection` 的注释）。
    expect([...handled].sort()).toEqual([...registered].sort())
    expect(handled).toHaveLength(4)

    // 幂等：再调两次不得再碰宿主句柄（替身**不**替我们做去重）。
    //
    // 这条守的是**不变量**，两层各自实现：`src/assembly.ts:310-315` 的 `released` 与
    // `src/routes/register.ts:132-135` 的 `cleanup`。所以单删任一层仍然绿（实测），
    // 两层一起去掉才红 —— 断言不再是替身自带的性质，但也不是单层的信号。
    await assembly.disposeRoutes()
    await assembly.disposeRoutes()
    expect(handled).toHaveLength(4)

    // 注入回调与注册链路都没抛：cordis 会把它吞进 `_error`，单测里只有替身这条通道
    // 能看见（否则「注册抛错」会表现成「路由少了」而不是失败）。
    expect(ctx.errors).toEqual([])
  })

  /*
   * 真实时序下的释放：`ctx.inject` 的回调在微任务里才跑（cordis `Fiber._reload()` 首句
   * `await Promise.resolve()`），所以 `assemble()` 同步返回时路由**还没注册**。
   *
   * 交出去的必须是**转发函数**而不是那个 `let` 的值。交值就等于永久交出初始的 no-op：
   * 卸载不释放路由 → 重载时同 path 二次注册被宿主拒绝 → 新实例一条路由都没有，
   * 面板整片 404 到重启。上面那条用例走的是同步 `inject` 替身，恰好照不出这个缺陷，
   * 所以这里必须显式打开 `deferInject`。
   */
  it('releases routes that only register on a later microtask', async () => {
    const registered: string[] = []
    const handled: string[] = []
    const ctx = makeFakeCtx(hostServices({ connection: perRouteConnection(registered, handled) }), {
      deferInject: true,
    })

    const assembly = assemble(ctx as unknown as AssemblyContext)
    // 同步返回点：inject 回调还没跑，一条路由都没注册。
    expect(registered).toEqual([])

    await Promise.resolve()
    expect(registered).toHaveLength(4)

    await assembly.disposeRoutes()
    expect(handled).toHaveLength(4)
  })

  /*
   * 服务 churn：cordis 在 `connection` 被移除又提供时会**重跑** `inject` 回调，并先调用
   * 上一次回调**返回的** disposer（`Fiber._reload()`，真 cordis 探针实测：
   * `RERUN_LOG = [callback, ---remove---, dispose, ---reprovide---, callback]`）。
   *
   * 回调不 return disposer 的话，本插件没有任何机会在 churn 时收手：同 path 二次注册，
   * 宿主 webserver 直接抛 `webserver: duplicate exact route`（`dsh-host-webserver/lib/index.js:375`）。
   * 这里直接调替身收下的句柄模拟 cordis 的自动释放，并顺带钉住幂等。
   */
  it('hands cordis a disposer so service churn cannot double-register', async () => {
    const registered: string[] = []
    const handled: string[] = []
    const ctx = makeFakeCtx(hostServices({ connection: perRouteConnection(registered, handled) }), {
      deferInject: true,
    })

    const assembly = assemble(ctx as unknown as AssemblyContext)
    await Promise.resolve()
    expect(registered).toHaveLength(4)
    expect(ctx.injectDisposers).toHaveLength(1)

    // 模拟 cordis：churn 时先调回调返回的 disposer。
    await ctx.injectDisposers[0]?.()
    expect(handled).toHaveLength(4)
    // 幂等：cordis 的自动调用与 `disposeRoutes` 可能撞在同一次卸载上。
    await ctx.injectDisposers[0]?.()
    await assembly.disposeRoutes()
    expect(handled).toHaveLength(4)
  })

  /*
   * churn 之后 `disposeRoutes` 必须指向**新闭包**。
   *
   * 这条守的是 `src/assembly.ts` 里 `let released = false` 的**作用域**：它必须留在回调
   * 体内（每次重跑一个新闭包）。一旦有人把它提到 `assemble` 作用域或模块作用域，
   * 语义立刻变成「第一次释放后永久 no-op」——churn 后新注册的 4 条路由永远释放不掉，
   * 宿主重复路由抛错、面板 404。实测把 `released` 外提后，本文件其它用例仍全绿，
   * 只有这一条会红。
   */
  it('survives a connection churn and still releases the routes the new callback registered', async () => {
    const registered: string[] = []
    const handled: string[] = []
    const ctx = makeFakeCtx(hostServices({ connection: perRouteConnection(registered, handled) }))

    const assembly = assemble(ctx as unknown as AssemblyContext)
    expect(registered).toHaveLength(4)
    expect(handled).toEqual([])

    // churn：宿主先调旧 disposer，再重跑回调（`_unload` → `_reload`）。
    ctx.churn(['connection'])
    expect(handled).toHaveLength(4)
    expect(registered).toHaveLength(8)

    // 释放的必须是**新一轮**注册的那 4 条。
    await assembly.disposeRoutes()
    expect(handled).toHaveLength(8)
    expect(handled.slice(4).sort()).toEqual([...registered.slice(4)].sort())
  })

  /*
   * `inject` 的第一条契约：**依赖不齐就不执行**。
   *
   * 生产上把 `ctx.inject(['connection'], …)` 的服务名写错一个字母，回调永不执行、4 条路由
   * 静默缺失（面板打开看到的是宿主的 404 body），日志一行没有。替身原来无视 `names`
   * 无条件执行，这个缺陷在单测里永远照不出来。
   */
  it('keeps the routes pending until the declared service shows up', async () => {
    const registered: string[] = []
    const ctx = makeFakeCtx(hostServices())

    const assembly = assemble(ctx as unknown as AssemblyContext)
    expect(registered).toEqual([])
    expect(ctx.pendingInjects).toHaveLength(1)

    // 宿主在装配之后才提供 connection：依赖齐了，回调才跑。
    ctx.provide('connection', perRouteConnection(registered, []))
    expect(registered).toHaveLength(4)
    expect(ctx.pendingInjects).toEqual([])

    await assembly.disposeRoutes()
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
