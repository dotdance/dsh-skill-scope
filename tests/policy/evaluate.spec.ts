import { describe, expect, it } from 'vitest'
import { allowedNames, hiddenNames, type EffectivePolicy } from '../../src/policy/evaluate.ts'

/**
 * 夹具只构造 `LayerPolicy` 的两种**合法**取值。
 *
 * `whitelist` 在 2026-10-13 已被删除，不再出现在这里：留着它会让测试继续描述
 * 一套不存在的语义，而类型检查也不再允许它（`PolicyMode` 里没有 `whitelist`）。
 * `default` 保留，因为磁盘上仍有写着它的历史文件，读取时会归一到 `blacklist`。
 */
const policy = (mode: 'default' | 'blacklist', skills: string[], mcps: string[] = []) => ({ mode, skills, mcps })

describe('allowedNames', () => {
  it('removes the listed names and treats a default mode identically', () => {
    // `default` 与 `blacklist` 的差别在「名单是否非空」，不在求值分支上：
    // 两者都走差集，`default` 只是名单为空时的同义写法。
    expect(allowedNames(['a', 'b'], policy('default', []))).toEqual(['a', 'b'])
    expect(allowedNames(['a', 'b'], policy('blacklist', ['a']))).toEqual(['b'])
    expect(allowedNames(['a', 'b'], policy('default', ['a']))).toEqual(['b'])
  })

  it('keeps inventory order and drops names the inventory does not contain', () => {
    expect(allowedNames(['b', 'a'], policy('blacklist', []))).toEqual(['b', 'a'])
    expect(allowedNames(['b', 'a'], policy('blacklist', ['zz']))).toEqual(['b', 'a'])
  })
})

describe('hiddenNames', () => {
  it('never re-enables a globally closed name from the workspace layer', () => {
    // 工作区层**空名单**（即「本层不收窄」）也不能把全局关掉的 'a' 拿回来。
    const { skills } = hiddenNames(
      { skills: ['a', 'b'], mcps: [] },
      { global: policy('blacklist', ['a']), workspace: policy('blacklist', []) },
    )
    expect(skills).toEqual(['a'])
  })

  it('unions the two layers and keys the result canonically', () => {
    const one = hiddenNames(
      { skills: ['a', 'b', 'c'], mcps: ['m1'] },
      { global: policy('blacklist', ['b']), workspace: policy('blacklist', ['c']) },
    )
    expect(one).toMatchObject({ skills: ['b', 'c'], mcps: [] })
    expect(one.key).toBe('skills=b,c|mcps=')
    expect(one.key).toBe(
      hiddenNames(
        { skills: ['c', 'b', 'a'], mcps: ['m1'] },
        { global: policy('blacklist', ['b']), workspace: policy('blacklist', ['c']) },
      ).key,
    )
  })

  it('treats a missing workspace layer as "no further narrowing"', () => {
    expect(hiddenNames({ skills: ['a'], mcps: [] }, { global: policy('default', []), workspace: null }).skills).toEqual([])
  })

  it('returns an empty hidden set when both layers are default', () => {
    const out = hiddenNames({ skills: ['a'], mcps: ['m'] }, { global: policy('default', []), workspace: null })
    expect(out).toEqual({ skills: [], mcps: [], key: 'skills=|mcps=' })
  })
})

/**
 * 对抗性用例（Lead 追加）：直接压不变量 1/2/3/19 —— 「全局是硬上限」。
 * 这些用例的价值在于工作区层**主动试图**复活全局关掉的名字，而不仅仅是叠一层 default。
 *
 * 白名单删除后，工作区层唯一能表达「想启用某名字」的方式是**不把它列进名单**。
 * 因此这里把旧白名单用例改写成等价形式：工作区层只关掉 'c'，'a' 与 'b' 都不在
 * 工作区名单里——即工作区「想要」a、b 都开着。若求值顺序写反（先工作区后全局），
 * 'a' 就会被复活，本用例会立刻失败。
 */
describe('hiddenNames 硬上限（对抗性）', () => {
  const inv = { skills: ['a', 'b', 'c'], mcps: ['m1', 'm2'] }

  it('workspace layer cannot re-enable a globally blacklisted skill', () => {
    const r = hiddenNames(inv, {
      global: { mode: 'blacklist', skills: ['a'], mcps: [] },
      workspace: { mode: 'blacklist', skills: ['c'], mcps: [] },
    })
    // 'a' 全局关闭 ⇒ 隐藏；'c' 工作区关闭 ⇒ 隐藏；'b' 两层都没关 ⇒ 可见。
    expect(r.skills).toEqual(['a', 'c'])
    expect(r.skills).toContain('a')
  })

  it('workspace layer cannot re-enable a globally blacklisted mcp', () => {
    const r = hiddenNames(inv, {
      global: { mode: 'blacklist', skills: [], mcps: ['m1'] },
      workspace: { mode: 'blacklist', skills: [], mcps: [] },
    })
    // 工作区名单为空 = 本层不收窄 = 它「想要」m1、m2 都开着；但全局关了 m1，
    // 硬上限生效 ⇒ m1 仍在隐藏集里。
    expect(r.mcps).toEqual(['m1'])
  })

  it('a workspace default layer adds no narrowing', () => {
    const r = hiddenNames(inv, {
      global: { mode: 'default', skills: [], mcps: [] },
      workspace: { mode: 'default', skills: [], mcps: [] },
    })
    expect(r.skills).toEqual([])
    expect(r.mcps).toEqual([])
  })

  it('a skill name never leaks into the mcp hidden set (domain isolation)', () => {
    // 全局名单只列 skill 'a'；mcp 域必须完全不受影响，且不得把 skill 名当成 mcp 名。
    const r = hiddenNames(inv, {
      global: { mode: 'blacklist', skills: ['a'], mcps: [] },
      workspace: null,
    })
    expect(r.skills).toEqual(['a'])
    expect(r.mcps).toEqual([])
  })

  it('an mcp name never leaks into the skill hidden set (domain isolation)', () => {
    // 反方向守卫：`pick()` 若忘了清空另一域，'m1' 会被算成「被关掉的 skill」。
    const r = hiddenNames(inv, {
      global: { mode: 'blacklist', skills: [], mcps: ['m1'] },
      workspace: null,
    })
    expect(r.skills).toEqual([])
    expect(r.mcps).toEqual(['m1'])
  })
})
