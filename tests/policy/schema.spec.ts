import { describe, expect, it } from 'vitest'
import {
  EMPTY_POLICY,
  normalizePolicy,
  parseGlobalPolicy,
  parseWorkspacePolicy,
  serializeGlobalPolicy,
  serializeWorkspacePolicy,
  validatePolicyInput,
} from '../../src/policy/schema.ts'

describe('normalizePolicy（宽松读）', () => {
  it('falls back to the layer default mode when mode is missing', () => {
    expect(normalizePolicy({}, 'default').policy.mode).toBe('default')
    expect(normalizePolicy({}, 'blacklist').policy.mode).toBe('blacklist')
  })

  it('treats a broken document as an empty policy with a warning and never throws', () => {
    const r = parseGlobalPolicy('{ not json')
    expect(r.policy).toEqual(EMPTY_POLICY)
    expect(r.warning).toBeTruthy()
  })

  it('reads the workspace document from its "default" row', () => {
    expect(
      parseWorkspacePolicy('{"default":{"mode":"blacklist","skills":["md-word-count"],"mcps":[]}}').policy,
    ).toEqual({ mode: 'blacklist', skills: ['md-word-count'], mcps: [] })
  })

  it('deduplicates and sorts on serialize', () => {
    expect(JSON.parse(serializeGlobalPolicy({ mode: 'blacklist', skills: ['b', 'a', 'a'], mcps: [] })).skills).toEqual([
      'a',
      'b',
    ])
  })

  it('keeps unknown top-level keys when rewriting the workspace document', () => {
    const out = JSON.parse(
      serializeWorkspacePolicy(
        { mode: 'blacklist', skills: [], mcps: [] },
        '{"note":"keep me","default":{"mode":"default","skills":[],"mcps":[]}}',
      ),
    )
    expect(out.note).toBe('keep me')
  })

  it('rejects an illegal name with the offending name in the message', () => {
    const r = validatePolicyInput({ mode: 'blacklist', skills: ['Bad Name'], mcps: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('Bad Name')
  })

  it('rejects more than 512 names in one array', () => {
    const many = Array.from({ length: 513 }, (_, i) => `s${i}`)
    expect(validatePolicyInput({ mode: 'blacklist', skills: many, mcps: [] }).ok).toBe(false)
  })
})
