import { describe, expect, it } from 'vitest'
import { hiddenNames, openResolver, type EffectivePolicy } from '../../src/policy/evaluate.ts'
import type { LayerPolicy } from '../../src/policy/schema.ts'
import type { WorkspacePolicy } from '../../src/policy/workspace-schema.ts'

/**
 * 夹具分两类，**故意不共用一个构造器**：两层形状已经不同了。
 *
 * - 全局层是黑名单（`{mode, skills[], mcps[]}`），`whitelist` 已于 2026-10-13 删除；
 * - 工作区层是逐项绝对状态（`{skills: {名字: 布尔}}`），键不存在 = 跟随全局。
 *
 * 用同一个构造器会让「把工作区当成黑名单传进去」这种错误在编译期消失。
 */
const global = (skills: string[], mcps: string[] = []): LayerPolicy => ({
  mode: 'blacklist',
  skills,
  mcps,
  showOfficialSkills: false,
})

const workspace = (skills: Record<string, boolean> = {}, mcps: Record<string, boolean> = {}): WorkspacePolicy => ({
  skills,
  mcps,
})

const inv = { skills: ['a', 'b', 'c'], mcps: ['m1', 'm2'] }

describe('openResolver（单名字取值）', () => {
  it('跟随全局：全局没关的项开着', () => {
    const effective: EffectivePolicy = { global: global(['a']), workspace: workspace() }
    const open = openResolver(effective, 'skills')
    expect(open('a')).toBe(false)
    expect(open('b')).toBe(true)
  })

  it('工作区可以**打开**全局关着的项（这是本次语义变更的核心）', () => {
    const effective: EffectivePolicy = { global: global(['a']), workspace: workspace({ a: true }) }
    expect(openResolver(effective, 'skills')('a')).toBe(true)
  })

  it('工作区可以关掉全局开着的项', () => {
    const effective: EffectivePolicy = { global: global([]), workspace: workspace({ b: false }) }
    expect(openResolver(effective, 'skills')('b')).toBe(false)
  })

  it('工作区的显式 false 不会被 `||` 吞掉', () => {
    // 回归守卫：写成 `local || 全局` 时，`false` 会回落到全局状态（true），
    // 表现为「明令关」完全不生效。`??` 才是正确写法。
    const effective: EffectivePolicy = { global: global([]), workspace: workspace({ b: false }) }
    expect(openResolver(effective, 'skills')('b')).toBe(false)
  })

  it('两个域的 Set 不能合并：同名项在另一域里不互相影响', () => {
    // skill 'a' 全局关闭，但 mcp 域里也有一个叫 'a' 的名字，它没被关。
    const effective: EffectivePolicy = { global: global(['a'], []), workspace: null }
    expect(openResolver(effective, 'skills')('a')).toBe(false)
    expect(openResolver(effective, 'mcps')('a')).toBe(true)
  })
})

describe('hiddenNames（两层生效集）', () => {
  it('没有工作区层时等价于只看全局', () => {
    const out = hiddenNames(inv, { global: global(['a'], ['m1']), workspace: null })
    expect(out).toMatchObject({ skills: ['a'], mcps: ['m1'] })
  })

  it('工作区空表 = 完全跟随全局（不再是「本层不收窄」的隐式收窄）', () => {
    const out = hiddenNames(inv, { global: global(['a'], ['m1']), workspace: workspace() })
    expect(out).toMatchObject({ skills: ['a'], mcps: ['m1'] })
  })

  it('工作区显式 true 让全局关闭的名字回到生效集', () => {
    const out = hiddenNames(inv, { global: global(['a']), workspace: workspace({ a: true }) })
    expect(out.skills).toEqual([])
  })

  it('工作区显式 false 把全局放行的名字移出生效集', () => {
    const out = hiddenNames(inv, { global: global([]), workspace: workspace({ c: false }) })
    expect(out.skills).toEqual(['c'])
  })

  it('两个方向可以同时存在：全局关的打开、全局开的关掉', () => {
    const out = hiddenNames(inv, { global: global(['a']), workspace: workspace({ a: true, b: false }) })
    expect(out.skills).toEqual(['b'])
  })

  it('key 与清单顺序无关，只看隐藏集合本身', () => {
    const one = hiddenNames(inv, { global: global(['b']), workspace: workspace({ c: false }) })
    expect(one.skills).toEqual(['b', 'c'])
    expect(one.key).toBe('skills=b,c|mcps=')
    const reordered = hiddenNames(
      { skills: ['c', 'b', 'a'], mcps: [] },
      { global: global(['b']), workspace: workspace({ c: false }) },
    )
    expect(reordered.key).toBe(one.key)
  })

  it('空隐藏集产出空 key', () => {
    expect(hiddenNames({ skills: ['a'], mcps: ['m'] }, { global: global([]), workspace: null })).toEqual({
      skills: [],
      mcps: [],
      key: 'skills=|mcps=',
    })
  })

  it('域隔离：skill 名单不会把同名 MCP 一起关掉', () => {
    const out = hiddenNames(inv, { global: global(['a'], []), workspace: null })
    expect(out.skills).toEqual(['a'])
    expect(out.mcps).toEqual([])
  })

  it('域隔离：MCP 名单不会把同名 skill 一起关掉', () => {
    const out = hiddenNames(inv, { global: global([], ['m1']), workspace: null })
    expect(out.skills).toEqual([])
    expect(out.mcps).toEqual(['m1'])
  })

  it('工作区里残留的、清单中没有的名字不影响结果', () => {
    // 名字已卸载（清单里没有它）时，求值必须忽略它，而不是报错或凭空生成一行。
    const out = hiddenNames(inv, { global: global([]), workspace: workspace({ gone: false }) })
    expect(out.skills).toEqual([])
  })
})
