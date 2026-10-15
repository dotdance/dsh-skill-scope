import type { RouteDeps, Envelope } from './handlers.ts'
import { handleGlobal, handleGlobalSave, handleWorkspace, handleWorkspaceSave } from './handlers.ts'
import type { PluginContextLike } from './session.ts'
import { asRecord } from '../shared/unknown.ts'

/**
 * 乐观的精确路由注册面。
 *
 * **关于形状（实测结论）**：0.2.1-alpha.2 的
 * `HostConnectionFetch.register` 是 **Fetch 形**的：
 * `register({ path, methods: readonly ('GET'|'HEAD'|'POST')[], requestBody, fetch: (request: Request) => Promise<Response> }): () => Promise<void>`
 * （`dsh-client-connection/lib/types/rpc.d.ts`）。「`handler` 收 `{ method, body, session }`
 * 并返回信封」那种签名**喂不进真实宿主**：宿主只认 `fetch`。
 *
 * 本接口因此声明真实契约的一个**最小结构面**，`register.ts` 不在编译期依赖具体包：
 * - `path` 必须是**含 `/api` 前缀的完整 URL 路径**。类型注释写的「absolute path below `/api`」
 *   措辞有误导性：真实匹配是 `createSharedFetchHandler` 里的
 *   `this.fetchRoutes.get(url.pathname)`（`dsh-client-connection/lib/index.js`），
 *   而 `new URL('http://h/api/x').pathname === '/api/x'` —— 键就是完整 pathname。
 *   少写 `/api` 前缀会导致路由**永远匹配不上**（静默落到 404），而不是「自动补前缀」。
 * - `methods` 用数组（宿主内部会转成 `Set`）；
 * - 返回的 disposer 是异步的（真实实现返回 `() => Promise<void>`）。
 */
export interface FetchRouteSpec {
  path: string
  methods: readonly string[]
  requestBody: 'buffered' | 'streaming'
  fetch(request: Request): Promise<Response>
}

export interface FetchRegisterFace {
  register(spec: FetchRouteSpec): () => unknown
}

/** 我们自己拥有的四条路由（设计 6.2）。**含 `/api` 前缀**（见 FetchRouteSpec 的 path 说明）。
 * **只有 POST**：非 POST 由宿主落到 404，不实现 405。 */
export const ROUTES = {
  global: '/api/skill-scope/global',
  globalSave: '/api/skill-scope/global/save',
  workspace: '/api/skill-scope/workspace',
  workspaceSave: '/api/skill-scope/workspace/save',
} as const

/**
 * 信封 → HTTP 响应。
 *
 * **HTTP 状态码一律 200**，`ok:false` 的错误只体现在信封里。这是**有意的**，不是疏忽：
 * 客户端 `createWebConnectionRpc` 的 `call()` 在 `!response.ok` 时**直接抛错并丢弃响应体**
 * （`dsh-client-connection/lib/client.js:1223` 附近的 `if (!response.ok) throw new Error(...)`），
 * 于是 400/409 会让 `{ code:'stale-revision' }` 这个前端**唯一能用来提示「请刷新重载」的信号**丢失。
 * 把错误码放进 `value/error` 信封、HTTP 保持 200，才能让面板区分 `bad-request` 与 `stale-revision`。
 *
 * **`cache-control: no-store`**：设计 6.1 要求所有响应带它。真实 `fetch` 形注册面拿到的是
 * `Request`、返回的是 `Response`，所以这个头由**我们在这里真实设置**，不能只写注释、指望宿主代劳
 * ——这些响应是实时的会话/策略状态，任何缓存都会让面板显示过期数据。
 */
function toResponse(envelope: Envelope<unknown>): Response {
  return Response.json(envelope, { headers: { 'cache-control': 'no-store' } })
}

/**
 * 处理函数 → Fetch 处理器的适配器。
 *
 * 三件事：
 * 1. 解析请求体（`buffered` 模式下宿主已缓冲，交给 `request.json()`）；
 * 2. **兜底 try/catch**：任何逃逸的异常都折成 `internal` 信封，绝不让宿主收到未处理拒绝
 *    （宿主对抛错的处理器只回 `500 handler failure: ...`，那个响应体不是我们的信封，前端无法解析）；
 * 3. 统一加 `no-store`。
 */
function wrap(handler: (body: unknown) => Promise<Envelope<unknown>>): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      // 空体是合法的：`/global` 与 `/workspace` 的 body 都可选/自带默认。
      body = {}
    }
    try {
      return toResponse(await handler(body))
    } catch (error) {
      return toResponse({ ok: false, error: { code: 'internal', message: `路由处理失败：${String(error)}` } })
    }
  }
}

/**
 * 注册四条精确路由，返回一个**同步** disposer 释放它们全部。
 *
 * 每条路径只声明 `POST`：宿主的匹配是 `route.methods.has(request.method)`，
 * 不匹配时根本不进我们的 `fetch`，而是落到共享通道兜底并返回 `404 not found`
 * （`dsh-client-connection/lib/index.js:663-676`）。所以**不需要** `method-not-allowed` 错误码，
 * 也不该声明一个自己不支持的方法再去拒绝它（设计 6.2）。
 */
export function registerRoutes(ctx: PluginContextLike, deps: RouteDeps, fetchRegister: FetchRegisterFace): () => void {
  if (fetchRegister === undefined || fetchRegister === null) {
    // 未接入 connection（例如 dsh 以纯 host 方式启动）时静默跳过：路由是可选能力，
    // 不能因为拿不到注册面就让整个插件加载失败。
    ctx.logger.warn('dsh-skill-scope: 未提供 fetch 注册面，路由未注册')
    return () => {}
  }

  const disposers: Array<() => unknown> = []
  const specs: Array<{ path: string; handler: (body: unknown, deps: RouteDeps) => Promise<Envelope<unknown>> }> = [
    { path: ROUTES.global, handler: handleGlobal },
    { path: ROUTES.globalSave, handler: handleGlobalSave },
    { path: ROUTES.workspace, handler: handleWorkspace },
    { path: ROUTES.workspaceSave, handler: handleWorkspaceSave },
  ]

  for (const { path, handler } of specs) {
    try {
      disposers.push(
        fetchRegister.register({
          path,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: wrap(async (body) => await handler(body, deps)),
        }),
      )
    } catch (error) {
      ctx.logger.warn(`dsh-skill-scope: 注册路由失败（${path}）：${String(error)}`)
    }
  }

  /** 释放一条路由；失败只 warn（成功路径与抛错路径的文案相同，故合成一处）。 */
  const releaseOne = (dispose: () => unknown): void => {
    const fail = (error: unknown): void => {
      ctx.logger.warn(`dsh-skill-scope: 释放路由失败：${String(error)}`)
    }
    try {
      // 真实 disposer 返回 Promise；这里不 await（disposer 契约是同步的），
      // 但**必须**接住 rejection，否则一条失败的释放会变成 unhandled rejection。
      const result = dispose()
      if (result !== null && typeof result === 'object' && 'catch' in result) {
        ;(result as Promise<unknown>).catch(fail)
      }
    } catch (error) {
      fail(error)
    }
  }

  return () => {
    for (const dispose of disposers) releaseOne(dispose)
  }
}
