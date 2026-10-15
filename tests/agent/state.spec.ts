import { describe, expect, it } from 'vitest'
import { AgentStates, reground, serial, type AgentLike } from '../../src/agent/state.ts'
import type { EffectivePolicy } from '../../src/policy/evaluate.ts'
import { EMPTY_POLICY, type LayerPolicy } from '../../src/policy/schema.ts'

/** 一个最小的 Agent 替身：只需要 id 与空 ctx/session。 */
const agent = (id: string): AgentLike => ({ id, ctx: { get: () => undefined }, session: { id } })

const defaultPolicy: LayerPolicy = EMPTY_POLICY
const blacklistA: LayerPolicy = { mode: 'blacklist', skills: ['a'], mcps: [] }

const effectiveOf = (global: LayerPolicy): EffectivePolicy => ({ global, workspace: null })

/** 让出一轮事件循环，用来观察串行链的执行顺序。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('AgentStates', () => {
  it('re-grounds to the newest policy on every call', () => {
    const states = new AgentStates()
    const state = states.ensure(agent('s1'))
    reground(state, effectiveOf(blacklistA))
    reground(state, effectiveOf(defaultPolicy))
    expect(state.policy?.global).toEqual(defaultPolicy)
  })

  it('starts with a null policy before the first assembly', () => {
    const states = new AgentStates()
    expect(states.ensure(agent('s1')).policy).toBeNull()
  })
})

describe('serial', () => {
  it('runs operations one at a time in submission order', async () => {
    const run = serial()
    const order: string[] = []
    await Promise.all([
      run(async () => {
        order.push('a1')
        await tick()
        order.push('a2')
      }),
      run(async () => {
        order.push('b1')
      }),
    ])
    expect(order).toEqual(['a1', 'a2', 'b1'])
  })

  it('keeps running after an operation rejects', async () => {
    const run = serial()
    await expect(
      run(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await expect(run(async () => 'ok')).resolves.toBe('ok')
  })
})