// @vitest-environment jsdom
import type { ComponentType } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, type ClientContextLike } from '../../src/client/index.tsx'
import type { UseSessionLike } from '../../src/client/types.ts'
import { makeFakeClientCtx } from '../support/fake-client-ctx.ts'

const workspace = {
  global: { mode: 'blacklist', skills: [], mcps: [], showOfficialSkills: false },
  workspace: { skills: {}, mcps: {} }, revision: 'r1', cwd: '/test/project',
  policyPath: '/test/project/.dsh-scope.json', exists: true, live: true,
  inventory: { skills: [], mcps: [] },
}
const fetchMock = vi.fn()
const blankSession: UseSessionLike = (selector) => selector({ blank: true })
type ChipProps = { sessionId: string; useSession: UseSessionLike }

function setup() {
  const base = makeFakeClientCtx()
  const components = new Map<string, (props: never) => import('react').ReactNode>()
  const ctx: ClientContextLike = {
    ...base,
    slots: {
      ...base.slots,
      register(options, component) {
        components.set(options.name, component)
        return () => { components.delete(options.name) }
      },
    },
  }
  apply(ctx)
  const Chip = components.get('conversation.input.right') as ComponentType<ChipProps>
  const Overlay = components.get('shell.overlay') as ComponentType
  return { Chip, Overlay }
}

function requestedSessions(): string[] {
  return fetchMock.mock.calls
    .filter((call) => call[0] === '/api/skill-scope/workspace')
    .map((call) => (JSON.parse(String((call[1] as RequestInit).body)) as { sessionId: string }).sessionId)
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, value: workspace }) })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('client workspace session binding through registered slots', () => {
  it('uses A when A is clicked after both A and B render', async () => {
    const { Chip, Overlay } = setup()
    render(<><Chip sessionId="session-a" useSession={blankSession} /><Chip sessionId="session-b" useSession={blankSession} /><Overlay /></>)
    await userEvent.setup().click(screen.getAllByTestId('workspace-chip')[0]!)
    await waitFor(() => expect(requestedSessions()).toEqual(['session-a']))
  })

  it('uses B after closing A and switching the same slot to B', async () => {
    const { Chip, Overlay } = setup()
    const view = render(<><Chip sessionId="session-a" useSession={blankSession} /><Overlay /></>)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('workspace-chip'))
    await screen.findByTestId('workspace-live')
    await user.click(screen.getByTestId('workspace-close'))
    view.rerender(<><Chip sessionId="session-b" useSession={blankSession} /><Overlay /></>)
    await user.click(screen.getByTestId('workspace-chip'))
    await waitFor(() => expect(requestedSessions()).toEqual(['session-a', 'session-b']))
  })

  it('uses B after unmounting A and mounting a new B slot', async () => {
    const { Chip, Overlay } = setup()
    const root = render(<Overlay />)
    const first = render(<Chip sessionId="session-a" useSession={blankSession} />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('workspace-chip'))
    await screen.findByTestId('workspace-live')
    await user.click(screen.getByTestId('workspace-close'))
    first.unmount()
    render(<Chip sessionId="session-b" useSession={blankSession} />)
    await user.click(screen.getByTestId('workspace-chip'))
    await waitFor(() => expect(requestedSessions()).toEqual(['session-a', 'session-b']))
    root.unmount()
  })
})
