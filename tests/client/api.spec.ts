import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, post, ROUTES } from '../../src/client/api.ts'

/**
 * Review Focus 6 的钉子。
 *
 * 三条用例分别钉住设计 6.2 的三件事：根绝对路径 + 信封解包、错误码透传、超时中止。
 * 第三条是 Review Focus 6 的核心：GUI 可能部署在 `<base href="./">` 的子路径下，
 * root-absolute 的 `/api/...` 可能永远打不到路由。此时的正确表现是**可重试的错误态**，
 * 而不是永不 settle 的挂起（那会让面板白屏）。
 */

/** 造一个 `Response` 形替身：只实现 `post` 真正读的两件事（`json()` 与 `ok`）。 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('client api', () => {
  it('posts JSON to the root-absolute route and unwraps value', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, value: { revision: null } }))

    const out = await post<{ revision: string | null }>(ROUTES.global, {})

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/skill-scope/global',
      expect.objectContaining({ method: 'POST', cache: 'no-store' }),
    )
    expect(out).toEqual({ revision: null })
  })

  it('throws ApiError carrying the server error code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: { code: 'stale-revision', message: 'stale' } }, 409),
    )

    await expect(post(ROUTES.globalSave, {})).rejects.toMatchObject({ code: 'stale-revision' })
  })

  it('aborts with a timeout signal instead of hanging', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )

    await expect(post(ROUTES.global, {}, 10)).rejects.toMatchObject({ code: 'network' })
    const firstCall = fetchMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    const init = firstCall?.[1] as RequestInit | undefined
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('surfaces ApiError as an Error subclass with the pinned name', () => {
    const error = new ApiError('network', 'boom')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ApiError')
    expect(error.code).toBe('network')
    expect(error.message).toBe('boom')
  })
})
