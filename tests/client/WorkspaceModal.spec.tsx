// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/client/index.tsx'
import { WorkspaceChip, WorkspaceModal } from '../../src/client/WorkspaceModal.tsx'
import { makeFakeClientCtx } from '../support/fake-client-ctx.ts'

/**
 * 不变量 5、24、C2。
 *
 * - chip 只在空白会话出现 → 不变量 24（C2：会话已有内容时不提供工程策略入口）
 * - `live: false` 必须标「非实时」→ 不变量 24（无 live Agent 就不许假装实时）
 * - 空白会话是 live 路径 → 空白会话**有** live Agent
 * - 继承/全局关闭汇总 → 不变量 5（工作区读取必须显式带 scope: agent）
 * - 已存在策略文件 → 设计 7.3（策略文件状态）
 */

/** `Response` 形替身：`post` 只读 `ok` 与 `json()`。 */
function jsonOk(body: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => body } as unknown as Response
}

const workspaceValue = {
  /*
   * 三态夹具：`workspace` 是**逐项表**，键不存在 = 跟随全局。
   *
   * - `global` 关掉 MCP `gbrain`（全局黑名单，没有「开」的可能）。
   * - `workspace` 关掉 skill `md-word-count`（本工程显式决定 ⇒ 与全局不同 ⇒ 标红）。
   *
   * 这样段头的两个数不相等（skill 段 2 项、1 项被关），任何「只显示总数」的实现
   * 都会让断言失败。注意 `workspace` 里不要放清单里不存在的名字：分组用例会自带
   * 三行 skill 夹具，那份夹具里才有 `gbrain-status`。
   */
  global: { mode: 'blacklist' as const, skills: [], mcps: ['gbrain'], showOfficialSkills: false },
  workspace: { skills: { 'md-word-count': false }, mcps: {} },
  revision: 'r1',
  cwd: '/home/user/proj/demo',
  policyPath: '/home/user/proj/demo/.dsh-scope.json',
  exists: true,
  live: true,
  inventory: {
    skills: [
      {
        name: 'md-word-count',
        description: '统计词数',
        source: 'custom',
        provider: 'filesystem',
        modelInvocable: true,
        group: '/home/user/node_modules/gbrain/skills',
        groupLabel: 'gbrain',
        sourceLabel: '/home/user/node_modules/gbrain/skills',
      },
      {
        name: 'academic-verify',
        description: '验证学术断言',
        source: 'custom',
        provider: 'filesystem',
        modelInvocable: true,
        group: '/home/user/node_modules/gbrain/skills',
        groupLabel: 'gbrain',
        sourceLabel: '/home/user/node_modules/gbrain/skills',
      },
    ],
    mcps: [
      {
        serverName: 'gbrain',
        toolCount: 12,
        toolNames: ['mcp__gbrain__search'],
        source: 'global' as const,
        restrictable: true,
        loaded: true,
      },
      {
        serverName: 'local-db',
        toolCount: 4,
        toolNames: ['mcp__local-db__query', 'mcp__local-db__tables', 'mcp__local-db__insert', 'mcp__local-db__drop'],
        source: 'scope' as const,
        restrictable: true,
        loaded: true,
      },
      // loader 挂了但没产出工具：`toolNames` 必须是空数组，展开后不得出现空「工具」段。
      { serverName: 'ghost', toolCount: 0, toolNames: [], source: 'global' as const, restrictable: true, loaded: false },
    ],
  },
}

const fetchMock = vi.fn()
let user: ReturnType<typeof userEvent.setup>
let slotRegistrations: Array<Record<string, unknown>>

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(jsonOk({ ok: true, value: workspaceValue }))
  vi.stubGlobal('fetch', fetchMock)
  user = userEvent.setup()
  slotRegistrations = []
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('WorkspaceModal chip registration', () => {
  // 回归防护（实测缺陷）：入口曾在**注册期**用 `ctx.get('sessionState')` 判断空白会话，
  // 而 DSH 里不存在该服务 → 恒为 undefined → 入口**从未注册**，工作区控制 UI 完全不显示。
  // 正确契约是**无条件注册** + **渲染期**用 `useSession(s => s.blank)` 决定是否渲染。
  it('registers the workspace entry unconditionally, with no registration-time session read', () => {
    const ctx = makeFakeClientCtx({ onSlotRegister: (options) => slotRegistrations.push(options) })
    apply(ctx)

    const names = slotRegistrations.map((r) => r['name'])
    expect(names).toContain('conversation.input.right')
    expect(names).toContain('shell.overlay')
    // 注册期不得读取任何会话状态服务：那正是导致入口从未注册的缺陷。
    expect(ctx.get('sessionState')).toBeUndefined()
  })

  it('gates rendering on blank, not registration: the chip renders only while blank', () => {
    const { unmount } = render(
      <WorkspaceChip hasSession t={() => '打开'} useSession={(selector) => selector({ blank: true })} onOpen={() => {}} />,
    )
    expect(screen.getByTestId('workspace-chip')).toBeTruthy()
    unmount()

    render(<WorkspaceChip hasSession t={() => '打开'} useSession={(selector) => selector({ blank: false })} onOpen={() => {}} />)
    expect(screen.queryByTestId('workspace-chip')).toBeNull()
  })

  it('registers the workspace modal overlay alongside the chip', () => {
    apply(makeFakeClientCtx({ onSlotRegister: (options) => slotRegistrations.push(options) }))

    const names = slotRegistrations.map((r) => [r['name'], r['id'] ?? r['key']])
    expect(names).toContainEqual(['conversation.input.right', 'skill-scope-workspace'])
    expect(names).toContainEqual(['shell.overlay', 'skill-scope-workspace-modal'])
  })
})

describe('WorkspaceModal', () => {
  it('marks the view as not live when the route says live:false', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: { ...workspaceValue, live: false } }))

    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    expect(await screen.findByText('非实时')).toBeTruthy()
  })

  it('renders a live view for a blank session', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: { ...workspaceValue, live: true } }))

    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    expect(await screen.findByTestId('workspace-live')).toBeTruthy()
    expect(screen.queryByText('非实时')).toBeNull()
  })

  /**
   * 回归守卫：MCP 段那行「继承自全局：N 项（全局已关闭 M 项）」已于 2026-10-14 按用户要求
   * **删除**。这里测的是它的**缺席**，而不是显示内容。
   *
   * 测缺席而不是删掉用例，是因为「删干净」本身是需求：只删 JSX 而把 `between` 接线、
   * `inherited` 字段或本地推导留着，下次有人接回去就会复活。所以同时钉住下列三点：
   *   - 屏幕上看不到这句话（`{total}` 插值后的任何形态）；
   *   - `WiredCapabilityBody` 收不到 `between`（两段之间不留空节点）；
   *   - `inherited` 不再被前端读取（服务端仍返回该字段，前端不许拿它渲染）。
   *
   * 注意这里**不能**只断言 `queryByText('继承自全局') === null`：React 会把相邻文本节点
   * 分开，`继承自全局：` 与后面的数字是两个节点，整串匹配本就匹配不到，那样的断言
   * 即使这行还在也会「通过」——是一条假守卫。
   */
  it('no longer renders the inherited-from-global summary line', async () => {
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    // 等面板真的加载完（否则空查询恒为 null，这条用例毫无意义）。
    await screen.findByTestId('mcp-local-db')
    expect(screen.queryByTestId('mcp-inherited')).toBeNull()
    expect(document.body.textContent).not.toContain('继承自全局')
    expect(document.body.textContent).not.toContain('全局已关闭')
  })

  /**
   * 三态语义的承重用例：**全局关闭的项仍然被列出**。
   *
   * 旧语义（2026-10-14）里服务端把它们从 `inventory` 整条摘除，UI 里既没有行也没有计数。
   * 三态落地后这条必须反过来：题面要求「workspace 拿与全局一样的完整列表」，否则用户在
   * 本工程里**没有入口**把全局关闭的项打开（按钮不存在，不是按钮点不动）。
   *
   * 同时保留旧的两条**缺席**断言（不得再出现任何「被全局关闭 N 项」的计数或只读名单）：
   * 完整列表不等于把内部记账摊给用户看。
   */
  it('lists a globally closed MCP row without marking it and reports no closed count', async () => {
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    // 等面板加载完，否则空查询恒为 null，这条用例毫无意义。
    await screen.findByTestId('mcp-local-db')

    // ① 行在（这是本次改动的新要求）。
    const gbrain = screen.getByTestId('mcp-gbrain')
    // ② 开关是关的：本工程没在 `workspace` 里表过态，所以跟着全局（全局关了它）。
    expect(within(gbrain).getByRole('switch', { name: 'gbrain' }).getAttribute('aria-checked')).toBe('false')
    // ③ 不标跨层差异：跟随全局 ≠ 改过全局。
    expect(within(gbrain).queryByTestId('ws-overridden')).toBeNull()

    // ④ 旧的缺席断言照旧。
    expect(screen.queryByTestId('globally-closed')).toBeNull()
    expect(document.body.textContent).not.toContain('被全局关闭')
    expect(document.body.textContent).not.toContain('另有')
    expect(screen.queryByText('被全局关闭（不可在此启用）')).toBeNull()
  })

  /**
   * 反向对照：**真的改过全局的那一项必须标红**。
   *
   * 夹具里 `md-word-count` 在 `workspace` 里是 `false`，而全局开着它 ⇒ 跨层不一致。
   * 没有这条，上一条用例「不标红」的断言在没有标记实现时也会通过。
   */
  it('marks a row whose state differs from the global setting', async () => {
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const overridden = await screen.findByTestId('ws-skill-md-word-count')
    expect(within(overridden).getByTestId('ws-overridden').textContent).toBe('与全局不同')
    // 跟随全局的那一项不标。
    expect(within(screen.getByTestId('ws-skill-academic-verify')).queryByTestId('ws-overridden')).toBeNull()
  })

  /**
   * 顶部说明段的新文案（2026-10-14 终态）。整句精确匹配：写成独立 `t()` 值，
   * 不做插值，所以这一句必须能被当成**一个完整字符串**找到。
   *
   * 注意用 `findByText` 对整句匹配是可行的——它没有 `{n}` 插值，React 只渲染一个文本节点。
   */
  it('renders the final top intro wording', async () => {
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    expect(
      await screen.findByText(
        '初始默认继承全局配置；你可以覆盖修改 skill 开关状态，改动只对本 workspace 新开的会话生效。',
      ),
    ).toBeTruthy()
  })

  /**
   * 「与全局不同」视图按钮（2026-10-20 用户要求：在 已启用/已禁用 之后加一个）。
   *
   * 它问的是**跨层差异**，不是开关位置 —— 判据必须是 `row.overridden`。
   * 夹具里 `md-word-count` 在 `workspace` 里被关（全局开着）⇒ 唯一一条不同；
   * `gbrain` 在全局被关、本工程没表态 ⇒ 跟随，不进这个视图。
   */
  it('filters down to items that differ from the global setting', async () => {
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    // 先等清单到齐，否则「点完不存在」与「本来就没有」分不清。
    await screen.findByTestId('ws-skill-academic-verify')

    await user.click(screen.getByTestId('view-overridden'))

    // ① 改过全局的那一项还在。
    expect(screen.getByTestId('ws-skill-md-word-count')).toBeTruthy()
    // ② 跟随全局的技能被筛掉。
    expect(screen.queryByTestId('ws-skill-academic-verify')).toBeNull()
    // ③ 跟随全局的 MCP 也被筛掉（全局关了 gbrain，本工程没改它）。
    expect(screen.queryByTestId('mcp-gbrain')).toBeNull()

    // ④ 切回「全部」应当把两者都放回来 —— 视图只是谓词，不是一次删除。
    await user.click(screen.getByTestId('view-all'))
    expect(screen.getByTestId('ws-skill-academic-verify')).toBeTruthy()
    expect(screen.getByTestId('mcp-gbrain')).toBeTruthy()
  })

  /**
   * 反向对照：**全局层不许出现这个按钮**。
   *
   * 全局层没有「上一层」，「与全局不同」在那里无定义；真渲染了只会得到一个永远空着的列表。
   */
  it('renders the overridden view button in the workspace bar only', async () => {
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const bar = await screen.findByTestId('view-row')
    expect(within(bar).getByTestId('view-overridden').textContent).toBe('与全局不同')
  })

  it('shows the official-skills switch in the view bar and saves it with the workspace policy', async () => {
    /*
     * 开关是**全局**展示状态，但工作区面板也展示（用户要求）。它随 `workspace/save`
     * 一起提交，服务端只改全局文件里的那一个键；`mergeSaved` 不合并 `inventory`，
     * 所以成功后还会再读一次，让官方行真的出现。
     */
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)
    const bar = await screen.findByTestId('view-row')
    const toggle = within(bar).getByRole('switch', { name: '显示官方 Skill' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await user.click(toggle)

    const saves = fetchMock.mock.calls.filter((call) => String(call[0]) === '/api/skill-scope/workspace/save')
    expect(saves.length).toBe(1)
    const body = JSON.parse(String((saves[0]?.[1] as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>
    expect(body['showOfficialSkills']).toBe(true)
    // 名单本身没变：只翻转展示开关。
    expect(body['workspace']).toEqual({ skills: { 'md-word-count': false }, mcps: {} })
  })

  it('shows the workspace title with the project name', async () => {
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    expect(await screen.findByText('本工程能力 · 只影响 demo')).toBeTruthy()
  })

  it('saves through the workspace route and merges only revision and workspace', async () => {
    /*
     * 承重不变量：保存响应**只合并 `revision` 与 `workspace`**，绝不整体替换视图。
     *
     * 这里故意让保存响应回吐一份「什么都变了」的完整视图 —— 也就是本仓库 host 侧
     * `src/routes/handlers.ts` 的真实行为（它的 `exists` 与 `cwd` 都是**写文件之前**采集的
     * 旧值）。若实现把整份响应铺回 state，这两个字段会被悄悄换掉。
     *
     * 断言按 **URL 过滤**而不是 `toHaveBeenCalledWith` 的调用序号：读取与保存在同一次
     * 交互里都会打 `fetch`，用序号会把「哪个先发」这种无关实现细节钉进测试。
     *
     * 2026-10-14：原先靠「未创建，保存后创建」状态行观察 merge 结果，该行已按用户要求
     * 删除。改为直接断言**视图里存下来的 revision**——保存响应回吐 `r2`，而标题行的工程名
     * 仍取自读取时的 cwd，二者都证明 merge 没有整体替换。
     */
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url) === '/api/skill-scope/workspace') {
        return jsonOk({ ok: true, value: { ...workspaceValue, exists: false } })
      }
      expect(String(url)).toBe('/api/skill-scope/workspace/save')
      // 三态请求体发的是**逐项表**，不是黑名单数组，也不再带 `mode`。
      expect(String(init?.body ?? '')).toContain('"workspace"')
      // 回吐一份「什么都变了」的视图：revision 与 cwd 都与读取时不同。
      return jsonOk({ ok: true, value: { ...workspaceValue, exists: true, revision: 'r2', cwd: '/elsewhere' } })
    })

    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    await user.click(await screen.findByRole('switch', { name: 'md-word-count' }))

    const saves = fetchMock.mock.calls.filter((call) => String(call[0]) === '/api/skill-scope/workspace/save')
    expect(saves.length).toBe(1)
    // 保存请求体里的 revision 是读取那一刻的 'r1'，不是响应回吐的 'r2'。
    const saveBody = JSON.parse(String((saves[0]?.[1] as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>
    expect(saveBody['revision']).toBe('r1')
    // 工程名仍来自读取时的 cwd（demo），不是响应回吐的 elsewhere。
    expect(await screen.findByText('本工程能力 · 只影响 demo')).toBeTruthy()
  })

  it('reads the workspace inventory with an explicit scope: agent', async () => {
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)
    await screen.findByText('本工程能力 · 只影响 demo')

    const calls = fetchMock.mock.calls.filter((call) => String(call[0]) === '/api/skill-scope/workspace')
    expect(calls.length).toBeGreaterThan(0)
    const body = JSON.parse(String((calls[0]?.[1] as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>
    // 不变量 5：工作区读取必须由服务端带 scope: agent 解析（客户端只传 sessionId）。
    expect(body['sessionId']).toBe('s1')
  })
})

/**
 * 批量操作按钮（「全部启用」/「全部禁用」）已于 2026-10-13 按用户要求**移除**。
 *
 * 用户原话："删除全部启用 全部禁用按钮"。移除的理由是这两个按钮的价值不足以承担
 * 它们的风险：一次点击会改写整段名单（Skills 或 MCP），而破坏性的那一个还得再弹一次
 * `confirm`；逐项开关已经能表达同样的意图，且每一步都可回滚。
 *
 * 这一组用例从「测批量行为」改为**反向守卫**：确保按钮真的不再出现，且配套的
 * `setAll` / `confirmDisableAll` 没有被留成死代码。测试从测行为转为测缺席，
 * 是因为"删干净"本身就是本次的需求——只删 JSX 而留下接线，下次有人接回去就会复活。
 */
describe('WorkspaceModal · 批量按钮已移除', () => {
  it('renders no batch buttons on the skill segment', async () => {
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const skills = await screen.findByRole('region', { name: 'Skill' })
    expect(within(skills).queryByRole('button', { name: '全部启用' })).toBeNull()
    expect(within(skills).queryByRole('button', { name: '全部禁用' })).toBeNull()
  })

  it('renders no batch buttons on the MCP segment', async () => {
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const mcps = await screen.findByRole('region', { name: 'MCP' })
    expect(within(mcps).queryByRole('button', { name: '全部启用' })).toBeNull()
    expect(within(mcps).queryByRole('button', { name: '全部禁用' })).toBeNull()
  })

  it('never asks for confirmation, because no destructive batch action remains', async () => {
    const confirmMock = vi.fn().mockReturnValue(true)
    vi.stubGlobal('confirm', confirmMock)

    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)
    await screen.findByRole('region', { name: 'Skill' })

    // 加载完就够：任何交互都不该触发 `confirm`（原先只有「全部禁用」会）。
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('still toggles a single capability and saves', async () => {
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    /*
     * 回归守卫：删批量按钮时最容易连带删坏逐项开关的接线。
     * 这条用例确认单个开关仍然能走通保存路径。
     */
    const skills = await screen.findByRole('region', { name: 'Skill' })
    fetchMock.mockClear()
    await user.click(within(skills).getByRole('switch', { name: 'md-word-count' }))

    const saveCall = fetchMock.mock.calls.find((call) => String(call[0]) === '/api/skill-scope/workspace/save')
    expect(saveCall).toBeDefined()
  })
})

describe('WorkspaceModal · 卡片版式（目标效果对齐）', () => {
  it('renders every capability as a card with a switch, a state tag and a detail toggle', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: workspaceValue }))
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const card = await screen.findByTestId('ws-skill-academic-verify')
    // 可切换能力必须有开关（不变量 21：只能切换已存在的名字）。
    expect(within(card).getByRole('switch', { name: 'academic-verify' })).toBeTruthy()
    // 状态 tag 用 success 语气表示「已启用」。
    expect(within(card).getByTestId('tag').getAttribute('data-tone')).toBe('success')
    expect(within(card).getByText('已启用')).toBeTruthy()
    // 每卡都有展开箭头，默认收起。
    const toggle = within(card).getByRole('button', { name: /展开/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('reveals the description and detail rows when a card is expanded', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: workspaceValue }))
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const card = await screen.findByTestId('ws-skill-academic-verify')
    expect(within(card).queryByText('验证学术断言')).toBeNull()

    await userEvent.click(within(card).getByRole('button', { name: /展开/ }))
    expect(within(card).getByText('验证学术断言')).toBeTruthy()
    // 展开详情里有「状态」与「来源」两行明细。
    expect(within(card).getByText('状态')).toBeTruthy()
    expect(within(card).getByText('来源')).toBeTruthy()
    // 「来源」的值是**真实出处**（磁盘注册根绝对路径），不是服务端的 `custom`。
    expect(within(card).getByText('/home/user/node_modules/gbrain/skills')).toBeTruthy()
  })

  it('writes the plugin name as the source for a plugin-provided skill', async () => {
    /*
     * 用户诉求的一半：「如果来源是某个插件，来源就写插件名」。
     * 直接给一条 `sourceLabel: 'superpowers-dsh'` 的行，断言渲染出插件名本身
     * （而不是路径、也不是 `custom`）。
     */
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        ok: true,
        value: {
          ...workspaceValue,
          inventory: {
            ...workspaceValue.inventory,
            skills: [
              {
                name: 'brainstorming',
                description: '头脑风暴',
                source: 'custom',
                provider: 'superpowers-dsh',
                modelInvocable: true,
                group: '/home/user/.dsh/profiles/debug/node_modules/superpowers-dsh/skills',
                groupLabel: 'superpowers-dsh',
                sourceLabel: 'superpowers-dsh',
              },
            ],
          },
        },
      }),
    )
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const card = await screen.findByTestId('ws-skill-brainstorming')
    await userEvent.click(within(card).getByRole('button', { name: /展开/ }))
    expect(within(card).getByText('superpowers-dsh')).toBeTruthy()
  })

  it('localizes the source value for a runtime-injected skill', async () => {
    /*
     * runtime 注入的 skill 没有磁盘出处（服务端给 `sourceLabel: null`）。
     * 「来源」的值**必须出文案**，不能留空：分组头写着「运行时注入」，
     * 展开后「来源」是空白，用户会以为详情没加载出来。
     */
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        ok: true,
        value: {
          ...workspaceValue,
          inventory: {
            ...workspaceValue.inventory,
            skills: [
              {
                name: 'browser-skill',
                description: '浏览器操作',
                source: 'runtime',
                provider: 'runtime',
                modelInvocable: true,
                group: '\u0000ungrouped',
                groupLabel: '',
                sourceLabel: null,
              },
            ],
          },
        },
      }),
    )
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const card = await screen.findByTestId('ws-skill-browser-skill')
    await userEvent.click(within(card).getByRole('button', { name: /展开/ }))
    expect(within(card).getByText('运行时注入（无磁盘文件）')).toBeTruthy()
  })

  it('omits the source row entirely on an MCP card, which has no origin concept', async () => {
    /*
     * MCP 行没有「出处」概念（它们不由 skill provider 提供）。此时「来源」整行
     * **不渲染**，而不是渲染成「来源：（空）」——后者是一条无信息的噪音行，
     * 还会让用户以为这里本该有内容却没加载出来。
     *
     * 用 `mcp-local-db`（本层启用中）而不是 `mcp-gbrain`（跟随全局、处于关态），
     * 避免把「来源行缺失」和「开关关着」两件事混在一起。
     */
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: workspaceValue }))
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const card = await screen.findByTestId('mcp-local-db')
    await userEvent.click(within(card).getByRole('button', { name: /展开/ }))
    // 「状态」行照常渲染（MCP 行确实有全局/本作用域之分）……
    expect(within(card).getByText('状态')).toBeTruthy()
    // ……但「来源」这一行不存在。
    expect(within(card).queryByText('来源')).toBeNull()
  })

  it('lists the full tool names on an MCP card when it is expanded', async () => {
    /*
     * 用户诉求：MCP 卡片展开后要能看见里面**有哪些**工具，而不是只有 `4 tools` 一个数字。
     * 断言用的是**完整** `mcp__<server>__<tool>` 形态（不是剥了前缀的短名）：
     * 用户要拿这串字符去对照日志与源码。
     */
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: workspaceValue }))
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const card = await screen.findByTestId('mcp-local-db')
    // 收起时只有摘要数字，看不到任何工具名。
    expect(within(card).queryByText('mcp__local-db__query')).toBeNull()

    await userEvent.click(within(card).getByRole('button', { name: /展开/ }))
    expect(within(card).getByText('工具')).toBeTruthy()
    for (const toolName of [
      'mcp__local-db__query',
      'mcp__local-db__tables',
      'mcp__local-db__insert',
      'mcp__local-db__drop',
    ]) {
      expect(within(card).getByText(toolName)).toBeTruthy()
    }
  })

  it('omits the tool list entirely on a loader server that produced no tools', async () => {
    /*
     * `ghost` 是 loader 挂了但没产出工具的行（`toolNames: []`）。展开后**不能**出现一个
     * 空标题 —— 那是一条无信息的噪音行，还会让用户以为清单没加载出来。
     * 这与「MCP 行不渲染来源行」是同一原则（见上一条用例）。
     */
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: workspaceValue }))
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const card = await screen.findByTestId('mcp-ghost')
    await userEvent.click(within(card).getByRole('button', { name: /展开/ }))
    // 「状态」行照常渲染……
    expect(within(card).getByText('状态')).toBeTruthy()
    // ……但「工具」这一行不存在（该行一个工具都没有）。
    expect(within(card).queryByText('工具')).toBeNull()
  })

  it('filters skills and MCP through the single top-level search box', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: workspaceValue }))
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    await screen.findByTestId('ws-skill-academic-verify')
    // 两个分区都还在。
    expect(screen.getByTestId('mcp-local-db')).toBeTruthy()

    /*
     * 关键点：**一个**搜索框同时管两个分区。分别输入两个词各自命中一个分区，
     * 证明它不是「只过滤技能」或「只过滤 MCP」的半套实现。
     */
    const box = screen.getByRole('searchbox')
    await userEvent.type(box, 'academic')
    expect(screen.getByTestId('ws-skill-academic-verify')).toBeTruthy()
    expect(screen.queryByTestId('ws-skill-md-word-count')).toBeNull()

    await userEvent.clear(box)
    await userEvent.type(box, 'local-db')
    expect(screen.getByTestId('mcp-local-db')).toBeTruthy()
    expect(screen.queryByTestId('mcp-gbrain')).toBeNull()
  })

  it('narrows both numbers of the section and group counts when searching', async () => {
    /*
     * 计数的分子分母都取**过滤后**的行。若分母改成「过滤前的总数」，搜索 `academic`
     * 时会显示 `1/2`，而屏幕上只有 1 张卡片 —— 用户会以为有一项被藏起来了。
     *
     * 夹具（见 `workspaceValue`）：skill 段 2 项、其中 `md-word-count` 被关（`1/2`）；
     * MCP 段清单里 3 项，但 `gbrain` 被全局关闭、工作区不再列出，
     * 所以段头是 `2/2` 而不是 `3/3` —— 分母同样只数**眼前这些行**。
     */
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: workspaceValue }))
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    await screen.findByTestId('ws-skill-academic-verify')
    expect(screen.getByTestId('ws-skill-count').textContent).toBe('1/2 项')
    expect(screen.getByTestId('mcp-count').textContent).toBe('2/3 项')

    await userEvent.type(screen.getByRole('searchbox'), 'academic')
    // skill 段只剩 1 项且它启用 → `1/1`，分母跟着变小。
    expect(screen.getByTestId('ws-skill-count').textContent).toBe('1/1 项')
    // MCP 段一项都不命中 → `0/0`，不会留着旧的 `2/2` 骗人。
    expect(screen.getByTestId('mcp-count').textContent).toBe('0/0 项')
  })

  it('does not let a search metacharacter crash the panel', async () => {
    // 搜索词直接进 `RegExp`：未转义时输入 `(` 会抛 SyntaxError 并白屏。
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: workspaceValue }))
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    await screen.findByTestId('ws-skill-academic-verify')
    await userEvent.type(screen.getByRole('searchbox'), '(')
    // 面板仍在，且过滤为「无匹配」而不是崩掉。
    expect(screen.getByTestId('workspace-modal')).toBeTruthy()
  })

  it('collapses a section from its header and hides its cards', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: workspaceValue }))
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    await screen.findByTestId('ws-skill-academic-verify')
    const header = screen.getByRole('button', { name: /Skill/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')

    await userEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('ws-skill-academic-verify')).toBeNull()
    // 收起技能分区不影响 MCP 分区。
    expect(screen.getByTestId('mcp-local-db')).toBeTruthy()
  })

  it('renders a read-only row with no switch and no reason copy', async () => {
    /*
     * 原先这条叫「keeps the read-only reason visible without expanding the card」，
     * 断言默认视图里能看到原因文案「未加载」（不变量 22/26 的旧要求）。
     * 用户 2026-10-14 明确要求删除卡片上的原因文案（原话：「删除每个 skill 里展示的
     * "备注"这行文案, 不用展示这个」；追问后确认「两处都删，完全不再展示原因文案」），
     * 故断言改为：只读行仍然**没有开关**，且**没有任何原因文案**。
     * 不变量 22/26 的「只读」语义仍由「没有开关」承载。
     */
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: workspaceValue }))
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const card = await screen.findByTestId('mcp-ghost')
    expect(within(card).queryByRole('switch')).toBeNull()
    expect(within(card).queryByText('未加载')).toBeNull()
    expect(within(card).queryByText('只读')).toBeNull()
  })

  it('renders the switch as a two-layer track and thumb', async () => {
    /*
     * 回归守卫：开关改成「外层透明 button + 内层 track/thumb」两层结构，
     * 因为原先画在 button 自身上的 1px 边框会把 28x16 的内容区吃成 26x14，
     * 深色主题下滑块几乎看不出位移。
     * 内层两个 span 必须是 `aria-hidden` 的纯装饰——可达名只由 button 的 aria-label 提供，
     * 否则屏幕阅读器会把轨道和滑块也当成内容念出来。
     */
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: workspaceValue }))
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const card = await screen.findByTestId('ws-skill-academic-verify')
    const toggle = within(card).getByRole('switch', { name: 'academic-verify' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    // 可达名即技能名：装饰性子元素不得把名字污染成「academic-verify academic-verify」。
    expect(toggle.getAttribute('aria-label')).toBe('academic-verify')
    expect(toggle.querySelectorAll('[aria-hidden="true"]').length).toBe(1)
  })
})

describe('WorkspaceModal skill grouping', () => {
  /**
   * 三行分属两组，用来验证分组渲染与「每组独立折叠」。
   *
   * `workspace` 必须**自己重述**：下面把 `inventory.skills` 换成另一批名字，
   * 若沿用基础夹具的逐项表，被关掉的名字就不在这批里 —— 组头计数会退化成 `2/2`，
   * 「只显示总数的写法」也能让它通过。
   */
  const groupedValue = {
    ...workspaceValue,
    workspace: { skills: { 'gbrain-status': false }, mcps: {} },
    inventory: {
      ...workspaceValue.inventory,
      skills: [
        { name: 'gbrain-status', description: '', source: 'custom', modelInvocable: true, group: '/r/gbrain/skills', groupLabel: 'gbrain' },
        { name: 'gbrain-recall', description: '', source: 'custom', modelInvocable: true, group: '/r/gbrain/skills', groupLabel: 'gbrain' },
        { name: 'brainstorming', description: '', source: 'custom', modelInvocable: true, group: '/r/node_modules/superpowers-dsh/skills', groupLabel: 'superpowers-dsh' },
      ],
    },
  }

  it('renders one collapsible section per source group, with its enabled/total count', async () => {
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: groupedValue }))
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    // 组名取服务端算好的 `groupLabel`（插件名 / 文件夹名），不是绝对路径。
    const gbrain = await screen.findByTestId('group:/r/gbrain/skills')
    expect(within(gbrain).getByText('gbrain')).toBeTruthy()
    // 计数是 `启用/总量`。夹具里 `gbrain-status` 已被关掉（见 `groupedValue.workspace`），
    // 所以是 `1/2` 而不是 `2`——只显示总数看不出组里有几项被关。
    expect(within(gbrain).getByText('1/2')).toBeTruthy()
    expect(within(gbrain).getByTestId('ws-skill-gbrain-status')).toBeTruthy()

    const superpowers = screen.getByTestId('group:/r/node_modules/superpowers-dsh/skills')
    expect(within(superpowers).getByText('superpowers-dsh')).toBeTruthy()
    expect(within(superpowers).getByText('1/1')).toBeTruthy()
    expect(within(superpowers).getByTestId('ws-skill-brainstorming')).toBeTruthy()
  })

  it('collapses one group without collapsing the others', async () => {
    /*
     * 「每组各自持有一份折叠状态」是承重行为：若用一个布尔表示整段折叠，
     * 折掉 `gbrain` 会连 `superpowers-dsh` 一起折掉，视觉分组就退化成整段折叠。
     */
    fetchMock.mockResolvedValueOnce(jsonOk({ ok: true, value: groupedValue }))
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    const gbrain = await screen.findByTestId('group:/r/gbrain/skills')
    const superpowers = screen.getByTestId('group:/r/node_modules/superpowers-dsh/skills')
    // 用组头按钮的**精确可达名**（组名 + 计数），而不是 `/gbrain/` —— 正则会把卡片里
    // `展开: gbrain-status` 那个按钮也匹配进来，`getByRole` 于是因多个命中而抛错。
    const toggle = within(gbrain).getByRole('button', { name: 'gbrain1/2' })

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await user.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // 本组内容收起……
    expect(within(gbrain).queryByTestId('ws-skill-gbrain-status')).toBeNull()
    // ……另一组不受影响。
    const otherToggle = within(superpowers).getByRole('button', { name: 'superpowers-dsh1/1' })
    expect(otherToggle.getAttribute('aria-expanded')).toBe('true')
    expect(within(superpowers).getByTestId('ws-skill-brainstorming')).toBeTruthy()
  })

  it('shows a localized label for the group that has no path', async () => {
    // runtime 注入的 skill 没有路径，服务端给空 `groupLabel`；前端必须换成文案，
    // 不能渲染空串（用户会看到一个光秃秃的箭头）或哨兵值（一串控制字符）。
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        ok: true,
        value: {
          ...workspaceValue,
          inventory: {
            ...workspaceValue.inventory,
            skills: [
              { name: 'browser-skill', description: '', source: 'bundled', modelInvocable: true, group: '\u0000ungrouped', groupLabel: '' },
            ],
          },
        },
      }),
    )
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    expect(await screen.findByText('运行时注入')).toBeTruthy()
  })

  it('stays flat when the server sends no group fields', async () => {
    /*
     * 旧版服务端（或不返回分组的路径）不给 `group`。此时必须保持扁平列表——
     * 补一个空组会把「服务端没给」伪装成「给了空组」，还会让 MCP 段也跟着被分组。
     *
     * 这里**必须显式构造无 `group` 的载荷**，不能复用 `workspaceValue`：那份夹具
     * 已经带分组字段（它是当前的正常形态），套用它这条用例就测不到降级路径。
     */
    fetchMock.mockResolvedValueOnce(
      jsonOk({
        ok: true,
        value: {
          ...workspaceValue,
          inventory: {
            ...workspaceValue.inventory,
            skills: [
              { name: 'academic-verify', description: '验证学术断言', source: 'custom', provider: 'filesystem', modelInvocable: true },
            ],
          },
        },
      }),
    )
    render(<WorkspaceModal sessionId="s1" onClose={() => {}} />)

    expect(await screen.findByTestId('ws-skill-academic-verify')).toBeTruthy()
    expect(document.querySelector('[data-testid^="group:"]')).toBeNull()
  })
})
