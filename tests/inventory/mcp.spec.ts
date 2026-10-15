import { describe, expect, it } from 'vitest'
import { classifyMcp, serverNameOf } from '../../src/inventory/mcp.ts'

describe('serverNameOf', () => {
  it('takes the server name after the mcp__ prefix, not the text before the first __', () => {
    expect(serverNameOf('mcp__gbrain__search')).toBe('gbrain')
    // 工具名本身含 `__`，所以 must 取「紧跟 mcp__ 之后的那一段」，而非第一个 `__` 之前。
    expect(serverNameOf('mcp__codegraph__codegraph_explore')).toBe('codegraph')
  })

  it('returns null when the prefix is absent', () => {
    expect(serverNameOf('read_file')).toBeNull()
    expect(serverNameOf('mcp_gbrain__search')).toBeNull()
  })

  it('rejects a server segment longer than 32 characters', () => {
    expect(serverNameOf(`mcp__${'a'.repeat(33)}__tool`)).toBeNull()
  })

  /**
   * 已知 server 名集合存在时走**最长前缀匹配**（设计 4.3）。
   *
   * 这条路径的意义在于 server 名允许下划线：非贪婪启发式遇到
   * `mcp__server_na__me__tool` 会切出 `server_na`，而真正的 server 名是
   * `server_na__me`。有权威集合时不该猜。
   */
  it('uses longest-prefix matching against a known server set', () => {
    const known = new Set(['server_na__me', 'server_na'])
    // 两个候选都是前缀；取更长的那个。
    expect(serverNameOf('mcp__server_na__me__tool', known)).toBe('server_na__me')
    // 只有短的那个匹配得上时，用短的。
    expect(serverNameOf('mcp__server_na__other', known)).toBe('server_na')
  })

  it('recognizes an undefined, not a partial, prefix match', () => {
    // `foo` 是 `foobar` 的前缀，但工具名是 `foobar__x`，所以 `foo` 不该命中。
    const known = new Set(['foo'])
    expect(serverNameOf('mcp__foobar__x', known)).toBe('foobar')
  })

  it('falls back to the heuristic when the known set misses', () => {
    const known = new Set(['unrelated'])
    expect(serverNameOf('mcp__codegraph__codegraph_explore', known)).toBe('codegraph')
  })
})

describe('classifyMcp', () => {
  it('marks a server restrictable only when one of its tools is inherited', () => {
    const rows = classifyMcp({
      scopeToolNames: ['mcp__gbrain__search', 'mcp__codegraph__x'],
      restrictableNames: new Set(['mcp__gbrain__search']),
      loaderServers: [],
    })
    expect(rows).toEqual([
      {
        serverName: 'codegraph',
        toolCount: 1,
        toolNames: ['mcp__codegraph__x'],
        source: 'scope',
        restrictable: false,
        loaded: true,
      },
      {
        serverName: 'gbrain',
        toolCount: 1,
        toolNames: ['mcp__gbrain__search'],
        source: 'scope',
        restrictable: true,
        loaded: true,
      },
    ])
  })

  it('lists a loader server with no tools as read-only and not loaded', () => {
    const rows = classifyMcp({
      scopeToolNames: [],
      restrictableNames: new Set(),
      loaderServers: ['ghost'],
    })
    expect(rows).toEqual([
      {
        serverName: 'ghost',
        toolCount: 0,
        // loader-only server 没有工具 ⇒ 空数组（不是 `undefined`：「没有」是确定事实）。
        toolNames: [],
        source: 'global',
        restrictable: false,
        loaded: false,
      },
    ])
  })

  it('never marks a tool owned only by the agent layer as restrictable', () => {
    const rows = classifyMcp({
      scopeToolNames: [],
      restrictableNames: new Set(),
      loaderServers: [],
      ownToolNames: ['mcp__local__x'],
    })
    expect(rows).toEqual([
      {
        serverName: 'local',
        toolCount: 1,
        toolNames: ['mcp__local__x'],
        source: 'scope',
        restrictable: false,
        loaded: true,
      },
    ])
  })

  it('counts a tool once when it appears in both the scope and own lists', () => {
    const rows = classifyMcp({
      scopeToolNames: ['mcp__gbrain__search'],
      restrictableNames: new Set(['mcp__gbrain__search']),
      loaderServers: ['gbrain'],
      ownToolNames: ['mcp__gbrain__search'],
    })
    expect(rows).toEqual([
      {
        serverName: 'gbrain',
        toolCount: 1,
        // `toolNames` 与 `toolCount` 必须来自**同一批去重后的名字**，
        // 否则展开区列出 2 条而摘要写着 1，用户会以为清单被漏掉了。
        toolNames: ['mcp__gbrain__search'],
        source: 'scope',
        restrictable: true,
        loaded: true,
      },
    ])
  })

  it('ignores tool names without a usable server segment', () => {
    const rows = classifyMcp({
      scopeToolNames: ['read_file', 'mcp__ghost__'],
      restrictableNames: new Set(),
      loaderServers: ['solo'],
    })
    expect(rows).toEqual([
      {
        serverName: 'solo',
        toolCount: 0,
        toolNames: [],
        source: 'global',
        restrictable: false,
        loaded: false,
      },
    ])
  })

  it('sorts each server’s tool names ascending, keeping the full mcp__ form', () => {
    // 展开区按这个名字逐条列；次序必须由服务端固定（前端不再排一次）。
    // 同时钉住「不剥前缀」：用户要拿这串字符去对照日志与源码。
    const rows = classifyMcp({
      scopeToolNames: ['mcp__gbrain__search', 'mcp__gbrain__capture', 'mcp__gbrain__put_page'],
      restrictableNames: new Set(),
      loaderServers: [],
    })
    expect(rows).toEqual([
      {
        serverName: 'gbrain',
        toolCount: 3,
        toolNames: ['mcp__gbrain__capture', 'mcp__gbrain__put_page', 'mcp__gbrain__search'],
        source: 'scope',
        restrictable: false,
        loaded: true,
      },
    ])
  })

  it('sorts a mixed result by server name ascending', () => {
    const rows = classifyMcp({
      scopeToolNames: ['mcp__zeta__a', 'mcp__alpha__b'],
      restrictableNames: new Set(['mcp__alpha__b']),
      loaderServers: ['mid'],
    })
    expect(rows.map((row) => row.serverName)).toEqual(['alpha', 'mid', 'zeta'])
  })
})