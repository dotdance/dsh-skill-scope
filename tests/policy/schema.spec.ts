import { describe, expect, it } from 'vitest'
import {
  EMPTY_POLICY,
  normalizePolicy,
  parseGlobalPolicy,
  serializeGlobalPolicy,
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

  it('deduplicates and sorts on serialize', () => {
    expect(JSON.parse(serializeGlobalPolicy({ mode: 'blacklist', skills: ['b', 'a', 'a'], mcps: [], showOfficialSkills: false })).skills).toEqual([
      'a',
      'b',
    ])
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

/**
 * 展示开关 `showOfficialSkills`：一段**与名单无关**的全局状态。
 *
 * 它与名单同文件、同 revision，所以读侧（宽松）必须能容忍缺键与坏值，
 * 写侧（严格）必须能接受它可选。
 */
describe('showOfficialSkills（官方 skill 展示开关）', () => {
  it('defaults to false when the key is absent (old files keep the old behavior)', () => {
    expect(normalizePolicy({ mode: 'blacklist', skills: [], mcps: [] }, 'blacklist').policy.showOfficialSkills).toBe(false)
  })

  it('round-trips true through serialize + parse', () => {
    const text = serializeGlobalPolicy({ mode: 'blacklist', skills: [], mcps: [], showOfficialSkills: true })
    expect(JSON.parse(text).showOfficialSkills).toBe(true)
    expect(parseGlobalPolicy(text).policy.showOfficialSkills).toBe(true)
  })

  it('falls back to false **and names the key** when the stored value is not a boolean', () => {
    // 静默退回会让「官方 skill 又不见了」变成无法解释的现象，所以 warning 必须点名。
    const r = normalizePolicy({ mode: 'blacklist', skills: [], mcps: [], showOfficialSkills: 'yes' }, 'blacklist')
    expect(r.policy.showOfficialSkills).toBe(false)
    expect(r.warning).toContain('showOfficialSkills')
  })

  it('accepts the key as optional on the strict input path, defaulting to false', () => {
    const withoutKey = validatePolicyInput({ mode: 'blacklist', skills: ['a'], mcps: [] })
    expect(withoutKey.ok).toBe(true)
    if (withoutKey.ok) expect(withoutKey.policy.showOfficialSkills).toBe(false)

    const withTrue = validatePolicyInput({ mode: 'blacklist', skills: ['a'], mcps: [], showOfficialSkills: true })
    expect(withTrue.ok).toBe(true)
    if (withTrue.ok) expect(withTrue.policy.showOfficialSkills).toBe(true)
  })

  it('rejects a non-boolean value instead of coercing it', () => {
    expect(validatePolicyInput({ mode: 'blacklist', skills: [], mcps: [], showOfficialSkills: 'true' }).ok).toBe(false)
  })
})
