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

  /*
   * 元素级丢弃：`z.array(...).catch([])` 的 `.catch` 挂在**数组**上，一个坏名字会让
   * 整份名单归零（实测 `{"skills":["good-one","Bad Name"]}` → `skills: []`），512 条
   * 有效关闭项一起被放开，而面板与日志都看不见。下面几条钉住逐元素过滤。
   */
  it('drops only the malformed name instead of voiding the whole list', () => {
    const r = normalizePolicy({ mode: 'blacklist', skills: ['good-one', 'Bad Name'], mcps: [] }, 'blacklist')
    expect(r.policy.skills).toEqual(['good-one'])
    expect(r.warning).toContain('Bad Name')
  })

  it('keeps valid names when a non-string element appears', () => {
    const r = normalizePolicy({ mode: 'blacklist', skills: ['keep', 1, null], mcps: [] }, 'blacklist')
    expect(r.policy.skills).toEqual(['keep'])
    expect(r.warning).toContain('不合法 skill')
  })

  it('never throws on an element JSON cannot describe, and previews its type', () => {
    // `JSON.stringify(1n)` 抛 TypeError；`normalizePolicy` 的契约是永不抛错。
    const r = normalizePolicy({ mode: 'blacklist', skills: ['ok-name', 1n], mcps: [] }, 'blacklist')
    expect(r.policy.skills).toEqual(['ok-name'])
    expect(r.warning).toContain('[bigint]')
  })

  it('names each list separately and truncates a huge offending value', () => {
    const mixed = normalizePolicy({ mode: 'blacklist', skills: ['Bad Name'], mcps: ['x y'] }, 'blacklist')
    expect(mixed.warning).toContain('不合法 skill')
    expect(mixed.warning).toContain('不合法 mcp')

    const huge = normalizePolicy({ mode: 'blacklist', skills: ['A'.repeat(60000)], mcps: [] }, 'blacklist')
    expect((huge.warning ?? '').length).toBeLessThan(200)
    expect(huge.warning).toContain('…')
  })

  /*
   * 数量上限本身也是同一条缺陷的边界形态：`.max(MAX_NAMES)` 曾挂在 zod 上，
   * 在元素过滤**之前**跑，「512 条合法 + 1 条 junk = 513」会先被判超限、由整份
   * `.catch()` 清空 ⇒ 512 条有效关闭项照旧全失效。下面两条钉住「按过滤后的有效名字判」。
   */
  it('keeps 512 valid names when the 513th element is junk', () => {
    const many = Array.from({ length: 512 }, (_, i) => `s${i}`)
    const r = normalizePolicy({ mode: 'blacklist', skills: [...many, 'Bad Name'], mcps: [] }, 'blacklist')
    expect(r.policy.skills).toHaveLength(512)
    expect(r.warning).toContain('Bad Name')
    expect(r.warning).not.toContain('超过上限')
  })

  it('voids a list only when its valid names exceed the cap, and says so', () => {
    const many = Array.from({ length: 513 }, (_, i) => `s${i}`)
    const r = normalizePolicy({ mode: 'blacklist', skills: many, mcps: [] }, 'blacklist')
    expect(r.policy.skills).toEqual([])
    expect(r.warning).toContain('超过上限')
    expect(r.warning).toContain('513')
  })

  it('does not let duplicates eat the budget', () => {
    const many = Array.from({ length: 600 }, (_, i) => `s${i % 512}`)
    const r = normalizePolicy({ mode: 'blacklist', skills: many, mcps: [] }, 'blacklist')
    expect(r.policy.skills).toHaveLength(512)
    expect(r.warning).toBeUndefined()
  })

  it('reports a whole-field drop when the value is not an array at all', () => {
    const r = normalizePolicy({ mode: 'blacklist', skills: 'good-one', mcps: [] }, 'blacklist')
    expect(r.policy.skills).toEqual([])
    expect(r.warning).toContain('已忽略字段：skills')
  })

  it('stays silent when the only anomaly is a duplicate name', () => {
    // 曾把「只有重复项」误报成「已忽略字段：skills」，用户会以为整份名单失效。
    const r = normalizePolicy({ mode: 'blacklist', skills: ['a', 'a'], mcps: [] }, 'blacklist')
    expect(r.policy.skills).toEqual(['a'])
    expect(r.warning).toBeUndefined()
  })

  it('renders non-finite numbers literally instead of null', () => {
    // `JSON.stringify(NaN)` 与 `JSON.stringify(Infinity)` 都是 `"null"`，两条不同的
    // 坏值会渲染成同一条，日志里分不清用户写了什么。
    const r = normalizePolicy({ mode: 'blacklist', skills: [Number.NaN, Number.POSITIVE_INFINITY], mcps: [] }, 'blacklist')
    expect(r.warning).toContain('NaN')
    expect(r.warning).toContain('Infinity')
    expect(r.warning).not.toContain('null')
  })

  it('never splits a surrogate pair when truncating', () => {
    const r = normalizePolicy({ mode: 'blacklist', skills: ['😀'.repeat(30)], mcps: [] }, 'blacklist')
    const warning = r.warning ?? ''
    // 孤立代理（U+D800–U+DFFF 单独出现）会在日志里显示成方块：截断必须按码点。
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(warning)).toBe(false)
    expect(warning).toContain('…')
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
