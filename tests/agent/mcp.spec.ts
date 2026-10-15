import { describe, expect, it } from 'vitest'
import { applyMcpRestriction, denyFor, type RestrictionState, type ScopedToolsFace } from '../../src/agent/mcp.ts'

/**
 * 搭一套替身：`tools.restrict` 记下每次入参，返回一个计入 `releases` 的 disposer。
 */
function makeDeps() {
  const restrictCalls: Array<{ deny: string[] }> = []
  const releases: string[] = []
  const tools: ScopedToolsFace = {
    restrict(filter) {
      restrictCalls.push(filter)
      return () => {
        releases.push('release')
      }
    },
  }
  return { tools, restrictCalls, releases }
}

describe('denyFor', () => {
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
})