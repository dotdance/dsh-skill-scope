import { describe, expect, it } from 'vitest'
import type { LayerPolicy } from '../../src/policy/schema.ts'
import {
  EMPTY_WORKSPACE_POLICY,
  filterAgainstGlobal,
  parseWorkspacePolicy,
  serializeWorkspacePolicy,
  validateWorkspaceInput,
} from '../../src/policy/workspace-schema.ts'

const globalPolicy = (skills: string[], mcps: string[] = []): LayerPolicy => ({ mode: 'blacklist', skills, mcps })

describe('parseWorkspacePolicy（新格式）', () => {
  it('空文本按空策略处理，且不带 warning', () => {
    expect(parseWorkspacePolicy(undefined)).toEqual({ policy: EMPTY_WORKSPACE_POLICY })
    expect(parseWorkspacePolicy('   ')).toEqual({ policy: EMPTY_WORKSPACE_POLICY })
  })

  it('坏 JSON 不抛错，返回空策略 + warning', () => {
    const r = parseWorkspacePolicy('{ not json')
    expect(r.policy).toEqual(EMPTY_WORKSPACE_POLICY)
    expect(r.warning).toContain('不是合法 JSON')
  })

  it('顶层不是对象时回退空策略', () => {
    expect(parseWorkspacePolicy('[1,2]').policy).toEqual(EMPTY_WORKSPACE_POLICY)
    expect(parseWorkspacePolicy('"x"').warning).toBeTruthy()
  })

  it('读出 workspace 行里的两个域', () => {
    const r = parseWorkspacePolicy('{"workspace":{"skills":{"a":true,"b":false},"mcps":{"m":true}}}')
    expect(r.policy).toEqual({ skills: { a: true, b: false }, mcps: { m: true } })
    expect(r.warning).toBeUndefined()
  })

  it('缺 skills 或 mcps 时该域为空，不算错误', () => {
    expect(parseWorkspacePolicy('{"workspace":{"skills":{"a":true}}}').policy).toEqual({
      skills: { a: true },
      mcps: {},
    })
  })

  it('值不是布尔：只回退那一项，其余项照常生效，并记 warning', () => {
    const r = parseWorkspacePolicy('{"workspace":{"skills":{"a":true,"b":"yes"}}}')
    expect(r.policy.skills).toEqual({ a: true })
    expect(r.warning).toContain('workspace.skills.b')
  })

  it('某个域不是对象：该域回退，另一域照常', () => {
    const r = parseWorkspacePolicy('{"workspace":{"skills":["a"],"mcps":{"m":false}}}')
    expect(r.policy).toEqual({ skills: {}, mcps: { m: false } })
    expect(r.warning).toContain('workspace.skills 不是对象')
  })

  it('workspace 本身不是对象时整体回退', () => {
    const r = parseWorkspacePolicy('{"workspace":[]}')
    expect(r.policy).toEqual(EMPTY_WORKSPACE_POLICY)
    expect(r.warning).toContain('不是对象')
  })

  it('不校验名字形状：清单里没有的名字照样保留', () => {
    // 名字可能属于还没装的技能。删掉它就是删掉用户的决定。
    const r = parseWorkspacePolicy('{"workspace":{"skills":{"Not-A-Skill":true}}}')
    expect(r.policy.skills).toEqual({ 'Not-A-Skill': true })
  })
})

describe('parseWorkspacePolicy（旧格式兼容）', () => {
  it('default 行里的数组全部读成 false（旧数组一律表示「关」）', () => {
    const r = parseWorkspacePolicy('{"default":{"mode":"blacklist","skills":["md-word-count"],"mcps":[]}}')
    expect(r.policy).toEqual({ skills: { 'md-word-count': false }, mcps: {} })
    expect(r.warning).toBeUndefined()
  })

  it('旧文件的 mode 不携带信息：default 与 blacklist 结果相同', () => {
    const a = parseWorkspacePolicy('{"default":{"mode":"default","skills":["a"]}}')
    const b = parseWorkspacePolicy('{"default":{"mode":"blacklist","skills":["a"]}}')
    expect(a.policy).toEqual(b.policy)
  })

  it('数组里有非字符串元素时跳过并记 warning', () => {
    const r = parseWorkspacePolicy('{"default":{"skills":["a",3]}}')
    expect(r.policy.skills).toEqual({ a: false })
    expect(r.warning).toContain('非字符串')
  })

  it('两个键并存时以 workspace 为准，并记一条 warning', () => {
    const r = parseWorkspacePolicy('{"workspace":{"skills":{"a":true}},"default":{"skills":["b"]}}')
    expect(r.policy.skills).toEqual({ a: true })
    expect(r.warning).toContain('同时存在')
  })
})

describe('filterAgainstGlobal（只保留真实差异）', () => {
  it('与全局同向的条目被剔除，异向的保留', () => {
    // 全局关 a、开 b。工作区写 a:false（与全局同向，无差异）、b:false（异向）。
    const filtered = filterAgainstGlobal(
      { skills: { a: false, b: false }, mcps: {} },
      globalPolicy(['a']),
    )
    expect(filtered.skills).toEqual({ b: false })
  })

  it('与全局异向的「开」同样保留', () => {
    const filtered = filterAgainstGlobal({ skills: { a: true }, mcps: {} }, globalPolicy(['a']))
    expect(filtered.skills).toEqual({ a: true })
  })

  it('全局状态未知的名字按「开」处理：false 是差异，true 不是', () => {
    const filtered = filterAgainstGlobal({ skills: { ghost: false, ghost2: true }, mcps: {} }, globalPolicy([]))
    expect(filtered.skills).toEqual({ ghost: false })
  })
})

describe('serializeWorkspacePolicy', () => {
  it('保留其他工具写入的未知顶层键', () => {
    const out = JSON.parse(
      serializeWorkspacePolicy(
        { skills: {}, mcps: {} },
        '{"note":"keep me","default":{"mode":"default","skills":[]}}',
        globalPolicy([]),
      ),
    )
    expect(out.note).toBe('keep me')
  })

  it('删掉旧格式的 default 行', () => {
    const out = JSON.parse(
      serializeWorkspacePolicy(
        { skills: { a: true }, mcps: {} },
        '{"default":{"mode":"blacklist","skills":["a"]}}',
        globalPolicy(['a']),
      ),
    )
    expect(out.default).toBeUndefined()
  })

  it('写盘时剔除同向条目（全局关的项没被改过 → 不写）', () => {
    const out = JSON.parse(
      serializeWorkspacePolicy({ skills: { a: false, b: false }, mcps: {} }, undefined, globalPolicy(['a'])),
    )
    expect(out.workspace.skills).toEqual({ b: false })
  })

  it('两个域都为空时写成空 workspace 对象（作为已迁移的标记）', () => {
    const out = JSON.parse(serializeWorkspacePolicy({ skills: {}, mcps: {} }, undefined, globalPolicy([])))
    expect(out).toEqual({ workspace: {} })
  })

  it('键排序 + 固定缩进 + 结尾换行：同一策略的文本恒定', () => {
    // 用 false 值：全局全开时 false 才算差异，true 会被同向过滤掉。
    const a = serializeWorkspacePolicy({ skills: { zz: false, aa: false }, mcps: {} }, undefined, globalPolicy([]))
    const b = serializeWorkspacePolicy({ skills: { aa: false, zz: false }, mcps: {} }, undefined, globalPolicy([]))
    expect(a).toBe(b)
    expect(a.endsWith('\n')).toBe(true)
    expect(a.indexOf('"aa"')).toBeLessThan(a.indexOf('"zz"'))
  })

  it('旧文坏掉时仍能写新内容（不能因为解析失败就不让用户保存）', () => {
    const out = JSON.parse(
      serializeWorkspacePolicy({ skills: { a: true }, mcps: {} }, '{ broken', globalPolicy(['a'])),
    )
    expect(out.workspace.skills).toEqual({ a: true })
  })
})

describe('validateWorkspaceInput（严格入站）', () => {
  it('缺 workspace 字段直接拒绝', () => {
    expect(validateWorkspaceInput(undefined).ok).toBe(false)
    expect(validateWorkspaceInput(null).ok).toBe(false)
  })

  it('接受空对象', () => {
    expect(validateWorkspaceInput({})).toEqual({ ok: true, policy: { skills: {}, mcps: {} } })
  })

  it('接受两个域', () => {
    expect(validateWorkspaceInput({ skills: { a: true }, mcps: { m: false } })).toEqual({
      ok: true,
      policy: { skills: { a: true }, mcps: { m: false } },
    })
  })

  it('值不是布尔时拒绝，并在 message 里点名', () => {
    const r = validateWorkspaceInput({ skills: { a: 'true' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('workspace.skills.a')
  })

  it('未知字段拒绝（严格 = 拒绝坏数据）', () => {
    const r = validateWorkspaceInput({ skills: {}, mode: 'blacklist' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('未知字段')
  })

  it('超过 512 项拒绝', () => {
    const many: Record<string, boolean> = {}
    for (let i = 0; i < 513; i += 1) many[`s${i}`] = true
    expect(validateWorkspaceInput({ skills: many }).ok).toBe(false)
  })
})
