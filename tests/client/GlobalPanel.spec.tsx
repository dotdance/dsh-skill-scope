// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/client/index.tsx'
import { GlobalPanel } from '../../src/client/GlobalPanel.tsx'
import { makeFakeClientCtx } from '../support/fake-client-ctx.ts'

/**
 * 不变量 4、6、20、21、22。
 *
 * 每条用例对应一条不变量：
 * - 注册形状 → 设计 7.1（侧栏可达 + main 面板）+ 7.4 两段式 `slots.inject`
 * - 只列清单里已有的名字 → 不变量 5 / 21（**没有**按名字自由添加的输入框）
 * - loader-only MCP 只读 → 不变量 22 / 26
 * - 保存失败回滚 → 不变量 6（只写两个策略文件；失败必须可见且可重试）
 * - 全部禁用前确认 → 设计 7.3（破坏性批量操作要确认）
 * - 只列 `snapshot({})` 的行 → 不变量 4（绝不出现工程 skill）
 */

/** `Response` 形替身：`post` 只读 `ok` 与 `json()`。 */
function jsonOk(body: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => body } as unknown as Response
}

const globalValue = {
  policy: { mode: 'blacklist' as const, skills: [], mcps: [], showOfficialSkills: false },
  revision: 'r1',
  inventory: {
    skills: [
      { name: 'academic-verify', description: '验证学术断言', source: 'global', modelInvocable: true },
      { name: 'md-word-count', description: '统计词数', source: 'global', modelInvocable: true },
    ],
    mcps: [
      {
        serverName: 'gbrain',
        toolCount: 12,
        toolNames: ['mcp__gbrain__search', 'mcp__gbrain__put_page'],
        source: 'global' as const,
        restrictable: true,
        loaded: true,
      },
      // loader 里挂了但没产出任何 tool：不变量 22 要求只读且显示「未加载」。
      { serverName: 'ghost', toolCount: 0, toolNames: [], source: 'global' as const, restrictable: true, loaded: false },
      {
        serverName: 'builtin',
        toolCount: 3,
        toolNames: ['mcp__builtin__a', 'mcp__builtin__b', 'mcp__builtin__c'],
        source: 'scope' as const,
        restrictable: false,
        loaded: true,
      },
    ],
  },
}

const fetchMock = vi.fn()
const confirmMock = vi.fn()
let user: ReturnType<typeof userEvent.setup>
/** `apply` 期间收到的槽位注册（形状取自官方两段式 `slots.register`）。 */
let slotRegistrations: Array<Record<string, unknown>>
let selectPanelCalls: string[]

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(jsonOk({ ok: true, value: globalValue }))
  vi.stubGlobal('fetch', fetchMock)
  confirmMock.mockReset()
  confirmMock.mockReturnValue(true)
  vi.stubGlobal('confirm', confirmMock)
  user = userEvent.setup()
  slotRegistrations = []
  selectPanelCalls = []
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('GlobalPanel slot registration', () => {
  it('registers the panel into sidebar.panellist and main with the panel id', () => {
    apply(
      makeFakeClientCtx({
        onSlotRegister: (options) => slotRegistrations.push(options),
        onSelectPanel: (panelId) => selectPanelCalls.push(panelId),
      }),
    )

    /*
     * **为什么不用 `toEqual` 钉死整个列表（务必读这一段再改）**
     *
     * `apply` 除这两条外还会注册工作区 chip 与弹层。用 `toEqual` 会顺带把
     * 「不许有任何其他槽位」也钉死，那不是设计 7.1 的要求。
     *
     * 这里钉住的是 7.1 真正的不变量：
     *   ① 这两条都在，且 ② 侧栏那条在前（顺序即侧栏图标位与 main 面板的先后），
     *   ③ 两处用**同一个** id（少注册 `main` 会让侧栏按钮指向不存在的面板）。
     */
    expect(slotRegistrations.map((r) => [r['name'], r['id'] ?? r['key']])).toEqual(
      expect.arrayContaining([
        ['sidebar.panellist', 'skill-scope'],
        ['main', 'skill-scope'],
      ]),
    )
    expect(slotRegistrations[0]?.['name']).toBe('sidebar.panellist')
  })
})

describe('GlobalPanel', () => {
  it('lists only the names the inventory contains, with no add-by-name input', async () => {
    render(<GlobalPanel />)

    expect(await screen.findByText('academic-verify')).toBeTruthy()
    expect(screen.queryByPlaceholderText(/添加|add/i)).toBeNull()
  })

  it('shows a read-only row with no switch for a loader-only MCP server', async () => {
    /*
     * 只读语义由「没有开关」承载，不由原因文案承载（见 `src/client/parts.tsx` 的
     * `readonly` 字段注释）。因此这里断言文案为 null，守卫它不会作为「解释」被加回来。
     */
    render(<GlobalPanel />)

    const row = await screen.findByTestId('mcp-ghost')
    expect(within(row).queryByText('未加载')).toBeNull()
    expect(within(row).queryByRole('switch')).toBeNull()
  })

  /**
   * 右上角的 revision 字符串与「本会话首个回合生效」提示都**不存在**，且不应回来。
   *
   * 两者都是**低信息密度**的装饰：40 位 revision 哈希对用户没有可操作性，
   * 而「本会话首个回合生效」在没有对比对象时也只是噪声。策略仍然按回合生效——
   * 那是服务端行为，不依赖界面上有没有这句话。
   */
  it('renders neither the revision string nor the turn-boundary notice', async () => {
    render(<GlobalPanel />)

    await screen.findByRole('region', { name: 'Skill' })
    expect(screen.queryByText(/^rev /)).toBeNull()
    expect(screen.queryByText('本会话首个回合生效')).toBeNull()
    expect(screen.queryByText('当前回合不受影响，下一回合生效')).toBeNull()
    expect(screen.queryByTestId('lock-notice')).toBeNull()
  })

  it('rolls the local state back and shows a retryable error when a save fails', async () => {
    render(<GlobalPanel />)
    await user.click(await screen.findByRole('switch', { name: 'academic-verify' }))

    // 保存先成功一次（拿到新 revision），第二次失败——失败后必须回滚到「已启用」。
    fetchMock.mockRejectedValueOnce(new Error('boom'))
    await user.click(screen.getByRole('switch', { name: 'academic-verify' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    await waitFor(() => {
      /*
       * 这里必须是 `getAttribute(...)` + `toBe`，**不能用** `toHaveProperty`。
       *
       * 1) `toHaveProperty('aria-checked', 'true')` 不行——实测（jsdom + vitest 5）：
       *    `<button role="switch" aria-checked="true">` 上 `el.getAttribute('aria-checked')`
       *    返回 `"true"`，而 `el['aria-checked']` 是 `undefined`。`aria-checked` 只是特性
       *    （attribute），不是 DOM 对象上的 JS 属性，所以那条断言**永远失败**——
       *    即使组件行为完全正确（反过来写成 `not.toHaveProperty` 就是假绿）。
       *    不能写成 `toHaveProperty` —— `aria-checked` 的值是字符串，不是布尔。
       * 2) jest-dom 的 `toHaveAttribute` 现在**已经可用**了（`tests/support/setup-dom.ts`
       *    通过 vitest `setupFiles` 注册，2026-10-12 由 lead 补上）。这里仍然用
       *    `getAttribute` + `toBe`：先**取到真实值再比较**，失败信息里会直接印出
       *    `"false"` / `null`，比匹配器的「expected element to have attribute」更能指出问题；
       *    且不依赖任何全局 setup，单独跑这一个文件也成立。
       */
      expect(screen.getByRole('switch', { name: 'academic-verify' }).getAttribute('aria-checked')).toBe('true')
    })
  })

  /**
   * 批量按钮（「全部启用」/「全部禁用」）已于 2026-10-13 按用户要求**移除**。
   * 原先这条用例测的是「全部禁用前弹确认」，现在改为**反向守卫**：
   * 两个分段都不该再有批量按钮，且加载完不触发任何 `confirm`。
   */
  it('renders no batch buttons in any segment', async () => {
    render(<GlobalPanel />)

    const skillsSection = await screen.findByRole('region', { name: 'Skill' })
    const mcpsSection = await screen.findByRole('region', { name: 'MCP' })

    expect(within(skillsSection).queryByRole('button', { name: '全部启用' })).toBeNull()
    expect(within(skillsSection).queryByRole('button', { name: '全部禁用' })).toBeNull()
    expect(within(mcpsSection).queryByRole('button', { name: '全部启用' })).toBeNull()
    expect(within(mcpsSection).queryByRole('button', { name: '全部禁用' })).toBeNull()
    // 批量动作一并消失后，不再有任何操作需要二次确认。
    expect(confirmMock).not.toHaveBeenCalled()
  })

  /**
   * 视图过滤器（全部 / 已启用 / 已禁用）—— 2026-10-13 用它取代了「模式选择器」。
   *
   * 这一组用例钉住的核心区别：**切换视图不得调用任何保存接口**。
   * 旧模式选择器下切一次模式会重写名单（同一数组在不同模式下含义相反），
   * 是有真实后果的策略写入；视图只是 `setView`，一次 `fetch` 都不该多发。
   */
  describe('名单视图', () => {
    it('renders the three view buttons and defaults to 全部', async () => {
      render(<GlobalPanel />)
      const row = await screen.findByTestId('view-row')
      expect(within(row).getByTestId('view-all').getAttribute('aria-pressed')).toBe('true')
      expect(within(row).getByTestId('view-enabled').getAttribute('aria-pressed')).toBe('false')
      expect(within(row).getByTestId('view-disabled').getAttribute('aria-pressed')).toBe('false')
      // 全局层没有「上一层」，「与全局不同」在这里无定义 ⇒ 不渲染这个按钮。
      expect(within(row).queryByTestId('view-overridden')).toBeNull()
    })

    it('filters the list without sending a save request', async () => {
      // 夹具：academic-verify 被全局关闭（在 blacklist 名单里），md-word-count 启用。
      fetchMock.mockResolvedValue(
        jsonOk({
          ok: true,
          value: { ...globalValue, policy: { mode: 'blacklist', skills: ['academic-verify'], mcps: [] } },
        }),
      )
      render(<GlobalPanel />)
      await screen.findByText('md-word-count')
      const savesBefore = fetchMock.mock.calls.filter((call) => String(call[0]).includes('save')).length

      await user.click(screen.getByTestId('view-disabled'))
      expect(screen.getByText('academic-verify')).toBeTruthy()
      expect(screen.queryByText('md-word-count')).toBeNull()

      await user.click(screen.getByTestId('view-enabled'))
      expect(screen.getByText('md-word-count')).toBeTruthy()
      expect(screen.queryByText('academic-verify')).toBeNull()

      await user.click(screen.getByTestId('view-all'))
      expect(screen.getByText('md-word-count')).toBeTruthy()
      expect(screen.getByText('academic-verify')).toBeTruthy()

      // 关键断言：三次切换视图，保存请求数一次也没变。
      const savesAfter = fetchMock.mock.calls.filter((call) => String(call[0]).includes('save')).length
      expect(savesAfter).toBe(savesBefore)
    })

    /**
     * 官方 skill 展示开关：它是**全局面板独有**的入口（存在全局策略里，工作区面板
     * 只读同一个值），所以这条用例同时钉住「开关在」「提交带上了它」。
     */
    it('renders the official-skills switch in the view bar and submits it with the policy', async () => {
      render(<GlobalPanel />)
      // **同一行**：开关挂在视图条右端（`trailing`），不是单独一行。
      const bar = await screen.findByTestId('view-row')
      const toggle = within(bar).getByRole('switch', { name: '显示官方 Skill' })
      // 用属性读法而不是 `toHaveProperty`（理由见本文件 160 行那段说明）。
      expect(toggle.getAttribute('aria-checked')).toBe('false')

      await user.click(toggle)

      const saves = fetchMock.mock.calls.filter((call) => String(call[0]).includes('save'))
      expect(saves.length).toBeGreaterThan(0)
      const body = JSON.parse(String((saves.at(-1)?.[1] as RequestInit | undefined)?.body ?? '{}')) as {
        showOfficialSkills?: boolean
        skills: string[]
      }
      // 只改展示开关，不动名单：打开它不会关闭任何官方 skill。
      expect(body.showOfficialSkills).toBe(true)
      expect(body.skills).toEqual([])
    })

    it('writes the name into the list when disabling, and removes it when enabling', async () => {
      render(<GlobalPanel />)
      await user.click(await screen.findByRole('switch', { name: 'academic-verify' }))

      const saves = fetchMock.mock.calls.filter((call) => String(call[0]).includes('save'))
      expect(saves.length).toBeGreaterThan(0)
      const body = JSON.parse(String((saves.at(-1)?.[1] as RequestInit | undefined)?.body ?? '{}')) as {
        mode: string
        skills: string[]
      }
      // 单一语义：名单里就是在被关掉的（旧白名单下这里会是「启用的集合」）。
      expect(body.mode).toBe('blacklist')
      expect(body.skills).toEqual(['academic-verify'])
    })
  })

  it('never renders a project skill, because the global read passes no cwd', async () => {
    render(<GlobalPanel />)

    await screen.findByText('academic-verify')
    const calls = fetchMock.mock.calls.filter((call) => String(call[0]) === '/api/skill-scope/global')
    expect(calls.length).toBeGreaterThan(0)
    // 请求体里不得出现 cwd / scope（不变量 4：全局清单只来自 snapshot({})）。
    const body = JSON.parse(String((calls[0]?.[1] as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>
    expect(body).not.toHaveProperty('cwd')
    expect(body).not.toHaveProperty('scope')
  })

  it('shows each section count as enabled/total, so disabled items stay visible in the number', async () => {
    /*
     * 夹具：2 个 skill，`academic-verify` 被关掉；3 个 MCP server 全部启用。
     * 断言的是**两个数不相等的那个组成的字符串**，而不是 `'1'` 或 `'2'` 这种单个数字 ——
     * 只显示总数的写法同样会渲染出 `'2'`，那样这条用例就没有区分力。
     *
     * 这条用例同时守住「skill 段与 MCP 段口径一致」：两段用的是同一个 `countText`。
     */
    fetchMock.mockResolvedValue(
      jsonOk({
        ok: true,
        value: { ...globalValue, policy: { mode: 'blacklist', skills: ['academic-verify'], mcps: [] } },
      }),
    )
    render(<GlobalPanel />)
    await screen.findByText('academic-verify')

    expect(screen.getByTestId('skill-count').textContent).toBe('1/2 项')
    expect(screen.getByTestId('mcp-count').textContent).toBe('3/3 项')
  })

  it('counts MCP servers disabled by policy in the MCP section, not just skills', async () => {
    // 关掉 `gbrain` 后 MCP 段必须变成 `2/3`：证明 MCP 段真的读了策略，
    // 而不是把某个与策略无关的常量渲染出来。
    fetchMock.mockResolvedValue(
      jsonOk({
        ok: true,
        value: { ...globalValue, policy: { mode: 'blacklist', skills: [], mcps: ['gbrain'] } },
      }),
    )
    render(<GlobalPanel />)
    await screen.findByText('gbrain')

    expect(screen.getByTestId('mcp-count').textContent).toBe('2/3 项')
    // skill 段不受 MCP 策略影响，仍是全开。
    expect(screen.getByTestId('skill-count').textContent).toBe('2/2 项')
  })
})
