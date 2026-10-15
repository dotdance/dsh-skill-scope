import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.ts'
import { makeFakeCtx } from './support/fake-ctx.ts'

// 编译期断言：apply 必须接受真实的 cordis Context（fake ctx 只是它的替身）。
const acceptsRealContext: (ctx: Context) => void = apply

describe('plugin entry', () => {
  it('declares its identity and hard dependencies', () => {
    expect(name).toBe('dsh-skill-scope')
    expect(inject).toEqual(['skills', 'tools', 'agents'])
    expect(typeof acceptsRealContext).toBe('function')
  })

  it('applies without a connection service', () => {
    const ctx = makeFakeCtx()
    expect(ctx.get('connection')).toBeUndefined()
    expect(() => apply(ctx)).not.toThrow()
  })
})
