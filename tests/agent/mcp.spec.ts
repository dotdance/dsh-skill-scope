import { describe, expect, it, vi } from 'vitest'
import { applyMcpRestriction, denyFor, type RestrictionState, type ScopedToolsFace } from '../../src/agent/mcp.ts'

/**
 * 搭一套替身：`tools.restrict` 记下每次入参，返回一个计入 `releases` 的 disposer。
 */
function makeDeps() {
  const restrictCalls: Array<{ deny: string[] }> = []
  const releases: string[] = []
  /**
   * 每次 `restrict` 交出的句柄。用 spy 包一层：`applyMcpRestriction` 允许把它转手、
   * 甚至再包一层转发，所以断言只能是「调了它就真解开」而不是对象身份。
   */
  const handles = [] as ReturnType<typeof vi.fn>[]
  const tools: ScopedToolsFace = {
    restrict(filter) {
      restrictCalls.push(filter)
      const handle = vi.fn(() => {
        releases.push('release')
      })
      handles.push(handle)
      return handle
    },
  }
  return { tools, restrictCalls, releases, handles }
}

describe('denyFor', () => {
  it('uses the longest configured prefix without widening the deny list', () => {
    const short = 'mcp__foo__lookup'
    const long = 'mcp__foo__bar__lookup'
    const own = 'mcp__foo__bar__own'
    const names = [short, long, own]
    const restrictable = new Set([short, long])
    const known = new Set(['foo', 'foo__bar'])
    expect(denyFor(names, restrictable, ['foo__bar'], known)).toEqual([long])
    expect(denyFor(names, restrictable, ['foo'], known)).toEqual([short])
  })

  it('expands server names into tool names and keeps only restrictable ones', () => {
    expect(
      denyFor(['mcp__gbrain__search', 'mcp__codegraph__x'], new Set(['mcp__gbrain__search']), ['gbrain', 'codegraph']),
    ).toEqual(['mcp__gbrain__search'])
  })

  it('never emits a name that is not in restrictableNames', () => {
    expect(denyFor(['mcp__ghost__x'], new Set(), ['ghost'])).toEqual([])
  })
})

describe('applyMcpRestriction', () => {
  it('reuses the previous restriction when the hidden key is unchanged', async () => {
    const { tools, restrictCalls } = makeDeps()
    const release = () => {}
    const out = await applyMcpRestriction({
      tools,
      deny: ['mcp__gbrain__search'],
      key: 'skills=|mcps=gbrain',
      previous: { key: 'skills=|mcps=gbrain', release },
    })
    expect(out?.release).toBe(release)
    expect(restrictCalls).toEqual([])
  })

  it('disposes the old restriction and registers the new one when the key changes', async () => {
    const { tools, restrictCalls } = makeDeps()
    let oldReleaseCalls = 0
    const oldRelease = () => {
      oldReleaseCalls += 1
    }
    const out = await applyMcpRestriction({
      tools,
      deny: ['mcp__gbrain__search'],
      key: 'skills=|mcps=gbrain',
      previous: { key: 'skills=', release: oldRelease },
    })
    expect(oldReleaseCalls).toBe(1)
    expect(restrictCalls).toEqual([{ deny: ['mcp__gbrain__search'] }])
    expect(out?.key).toBe('skills=|mcps=gbrain')
  })

  it('returns to no restriction when the hidden set becomes empty', async () => {
    const { tools, restrictCalls } = makeDeps()
    let oldReleaseCalls = 0
    const oldRelease = () => {
      oldReleaseCalls += 1
    }
    const out = await applyMcpRestriction({
      tools,
      deny: [],
      key: 'skills=|mcps=',
      previous: { key: 'skills=|mcps=gbrain', release: oldRelease },
    })
    expect(out).toBeNull()
    expect(oldReleaseCalls).toBe(1)
    expect(restrictCalls).toEqual([])
  })

  it('never calls restrict with an empty deny array', async () => {
    const { tools, restrictCalls } = makeDeps()
    const previous: RestrictionState = { key: 'other', release: () => {} }
    await applyMcpRestriction({ tools, deny: [], key: 'skills=|mcps=', previous })
    expect(restrictCalls).toEqual([])
  })

  /*
   * 失败路径（顺序承重的那一条）：`restrict()` 对任何未知名字都抛，而且抛在
   * `layers.effect()` 之前 —— 连层都不创建。此时旧限制**必须还在**：先把旧的撤了再
   * 注册，等于一次「被禁工具当场全部重新可见」的泄漏，且 `state` 会留下一个已释放的
   * 死句柄（下一轮 key 相同就永久复用）。
   */
  it('keeps the old restriction alive when restrict throws on an unknown name', async () => {
    let oldReleaseCalls = 0
    const errors: unknown[] = []
    const tools: ScopedToolsFace = {
      restrict() {
        throw new Error('tools.restrict() names unknown global tool "mcp__gone__x"')
      },
    }
    await expect(
      applyMcpRestriction({
        tools,
        deny: ['mcp__gone__x'],
        key: 'skills=|mcps=gone',
        previous: { key: 'skills=', release: () => { oldReleaseCalls += 1 } },
        onReleaseError: (error) => errors.push(error),
      }),
    ).rejects.toThrow('unknown global tool')
    // 旧句柄**一次都没被碰**：这是本用例唯一的判据。
    // 原先这里还有一条 `expect(errors).toEqual([])`，它恒真——`restrict` 抛在
    // `releasePrevious` 之前，代码根本走不到回调，断言发现不了「回调没接线」。
    expect(oldReleaseCalls).toBe(0)
  })

  /*
   * 空 deny 分支是**第二条**释放路径（隐藏集变空 ⇒ 撤掉旧的、不挂新的）。它同样被
   * `releasePrevious` 包着，但上面两条用例都走不到：一条在 `restrict` 抛错处停下，
   * 一条走非空分支。释放失败时仍必须返回 `null`（`mcpRestrictionOf` 靠它丢句柄），
   * 且**不得**调 `restrict({deny: []})`（宿主会抛 `is a no-op`）。
   */
  it('returns null when the list empties and the old disposer throws', async () => {
    const { tools, restrictCalls } = makeDeps()
    const errors: unknown[] = []
    const out = await applyMcpRestriction({
      tools,
      deny: [],
      key: 'skills=|mcps=',
      previous: { key: 'skills=|mcps=gbrain', release: () => { throw new Error('listener boom') } },
      onReleaseError: (error) => errors.push(error),
    })
    expect(out).toBeNull()
    expect(restrictCalls).toEqual([])
    expect(errors).toHaveLength(1)
  })

  /*
   * 释放本身抛错（`release()` 会同步 emit `tools/change`，第三方监听器可能炸）时，
   * 新层已经挂上，必须照常返回新句柄让 `applyRound` 更新 state；抛出去的话 state
   * 会留着旧 key + 已死的旧句柄，等于把刚修好的缺陷从释放这一侧放回来。
   */
  it('still returns the new handle when the old disposer throws', async () => {
    const { tools, handles } = makeDeps()
    const errors: unknown[] = []
    const out = await applyMcpRestriction({
      tools,
      deny: ['mcp__gbrain__search'],
      key: 'skills=|mcps=gbrain',
      previous: { key: 'skills=', release: () => { throw new Error('listener boom') } },
      onReleaseError: (error) => errors.push(error),
    })
    expect(out?.key).toBe('skills=|mcps=gbrain')
    // **行为**断言，不是对象身份：声称守护的缺陷是「返回死句柄」（state 指向已释放层，
    // 下一轮 key 相同就直接复用它）。所以调一次新句柄，看底层是否真被解开 ——
    // 死句柄（`() => {}`）不会留下记录，包一层转发则照常通过（身份断言会误杀后者）。
    expect(out?.release).toBeTypeOf('function')
    out?.release?.()
    expect(handles[0]).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
  })
})
