/**
 * 面板与宿主之间的唯一传输面（设计 6.2）。
 *
 * **根绝对路径**：请求 URL 一律是 `'/' + route`。设计 6.2 明确要求这样拼，
 * 因为面板可能被渲染在任意路由下（`/workspace/xxx`、`/settings`…）——相对路径会拼到
 * 当前路由上，`api/...` 就打到 `/workspace/api/...` 这种不存在的地址。
 *
 * **Review Focus 6 的已知残余风险**：GUI 若部署在子路径下（`<base href="./">`），
 * root-absolute 的 `/api/...` 可能打不到路由。此时本模块的行为是：超时中止并抛
 * `ApiError('network')`，让面板显示**可重试的错误态**——绝不静默挂起。
 * 也就是说，「打不到路由」不会变成白屏，而是变成一条用户可读的失败提示。
 */

import { API_PATH } from '../shared/routes.ts'
import { asRecord } from '../shared/unknown.ts'

/** 与宿主 `ErrorCode` 对齐的前端错误码；`network` 是前端**自己**产生的（网络/中止/非 JSON）。 */
export type ApiErrorCode = 'bad-request' | 'stale-revision' | 'unknown-session' | 'internal' | 'network'

/** 传输层失败。`code` 是承重字段：面板靠它区分「刷新重载」与「输入非法」。 */
export class ApiError extends Error {
  override readonly name = 'ApiError'
  readonly code: ApiErrorCode

  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** 宿主信封（设计 6.2）。与 `src/routes/handlers.ts` 的 `Envelope` 同形。 */
type Envelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** 四条路由：路径段的唯一来源是 `src/shared/routes.ts`，`post` 会补前导斜杠。 */
export const ROUTES = API_PATH

/** 默认超时。面板是交互入口，10 秒足够；超时必须兜底，不能让用户对着转圈等。 */
const DEFAULT_TIMEOUT_MS = 10000

/** 从错误信封里读 `code`，读不到就退回 `internal`（不假装知道是哪种失败）。 */
function errorCodeOf(error: unknown): ApiErrorCode {
  const record = asRecord(error)
  const code = record?.['code']
  if (code === 'bad-request' || code === 'stale-revision' || code === 'unknown-session' || code === 'internal') {
    return code
  }
  return 'internal'
}

/** 从错误信封里读 `message`，读不到就给一句不误导的兜底文案。 */
function errorMessageOf(error: unknown): string {
  const record = asRecord(error)
  const message = record?.['message']
  return typeof message === 'string' && message !== '' ? message : '请求失败'
}

/**
 * POST 一个 JSON 请求体并解包 `{ ok: true, value }`。
 *
 * 失败路径**全部**折成 `ApiError`（绝不让 `TypeError`/`DOMException` 漏给调用方）——
 * 面板只认 `ApiError.code`，漏一种异常就多一条白屏路径。
 *
 * **定时器必须在 `finally` 里清掉**：`setTimeout` 会持有一个活动 handle，
 * 不清就会让 vitest 进程得不到退出许可（表现为用例全绿但运行不结束）。
 * 中止发生在 fetch 已 settle 之后时，`abort()` 本身是幂等的，不产生副作用。
 */
export async function post<T>(route: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    let response: Response
    try {
      response = await fetch(`/${route}`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      // 网络失败、中止（含超时）、DNS/连接错误全在这里。
      throw new ApiError('network', describeNetworkFailure(error, timeoutMs))
    }

    // **先读 body 再看状态码**：宿主的错误码在信封里，而 `register.ts` 有意让 HTTP 保持 200
    // （真实连接的 `call()` 会在 `!response.ok` 时丢弃响应体）。所以这里不能按状态码短路，
    // 否则会丢掉 `stale-revision` 这个前端唯一的「请刷新」信号。
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new ApiError('network', `响应不是合法 JSON：${String(error)}`)
    }

    const record = asRecord(payload)
    if (record === null || typeof record['ok'] !== 'boolean') {
      throw new ApiError('network', '响应信封形状非法')
    }
    if (record['ok'] === false) {
      throw new ApiError(errorCodeOf(record['error']), errorMessageOf(record['error']))
    }
    return record['value'] as T
  } finally {
    clearTimeout(timer)
  }
}

/** 把中止/网络异常翻译成一句用户能自己处理的说明。 */
function describeNetworkFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return `请求超时（${timeoutMs}ms）或已被取消`
  }
  // jsdom 与某些运行时的中止异常不是 DOMException，只能用名字/消息判断。
  const name = asRecord(error)?.['name']
  if (name === 'AbortError') return `请求超时（${timeoutMs}ms）或已被取消`
  return `网络请求失败：${String(error)}`
}
