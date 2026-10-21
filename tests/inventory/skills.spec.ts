import { describe, expect, it } from 'vitest'
import {
  UNGROUPED_KEY,
  groupKeyOf,
  groupLabelOf,
  readAgentSkills,
  readGlobalSkills,
  sourceLabelOf,
  type SkillInventory,
  type SkillRow,
  type SkillsServiceLike,
} from '../../src/inventory/skills.ts'

/** 造一行只有分组/来源关心的字段的 skill。 */
function row(overrides: Partial<SkillRow> & { name: string }): SkillRow {
  // 缺省 provider 用 `filesystem`（磁盘 skill 的常态）：来源标签于是落到 path 那一支。
  // 这里**不能**沿用旧缺省 `source: 'filesystem'` —— 那个值不在宿主的 `SkillSource`
  // 联合里，会让「源字符串」与「provider 名」两种事实在夹具里混同。
  return { description: '', source: 'custom', provider: 'filesystem', modelInvocable: true, ...overrides }
}

/**
 * 假服务：记录每次 `snapshot` 的实参，并按需返回预设的清单/complete。
 * 记录实参是这些用例的核心——「传了空对象」与「传了活 agent」只能从实参上区分。
 */
function fakeSkills(options: {
  complete?: boolean
  rows?: Array<{
    name: string
    description?: string
    source?: string
    provider?: string
    path?: string
    invocation?: { modelInvocable?: boolean }
  }>
}): SkillsServiceLike & { calls: Array<{ cwd?: string; scope?: unknown }> } {
  const calls: Array<{ cwd?: string; scope?: unknown }> = []
  return {
    calls,
    async snapshot(args) {
      calls.push(args)
      return { skills: options.rows ?? [], complete: options.complete ?? true }
    },
  }
}

describe('readGlobalSkills', () => {
  it('reads the global layer with an empty options object', async () => {
    const fake = fakeSkills({ rows: [{ name: 'a' }] })
    await readGlobalSkills(fake, { showOfficialSkills: false })
    // 必须是空对象：带 cwd 会把全局读变成工作区读，带 scope 会误取某一 agent 的层。
    expect(fake.calls).toEqual([{}])
  })
})

describe('readAgentSkills', () => {
  it('passes cwd and the live agent as scope', async () => {
    const agent = { id: 's1' }
    const fake = fakeSkills({ rows: [] })
    await readAgentSkills(fake, agent, '/home/user/proj/demo', { showOfficialSkills: false })
    // scope 必须是活 agent 对象本身（不是 id 字符串、不是副本），dsh-skill 只认显式传入的 scope。
    expect(fake.calls).toEqual([{ cwd: '/home/user/proj/demo', scope: agent }])
  })
})

describe('official infrastructure skills are hidden by default', () => {
  /** 官方 preset skill 的真实路径（见 `tests/inventory/official.spec.ts` 的说明）。 */
  const OFFICIAL = '/home/user/node_modules/@deepseek-ai/dsh-agent-preset/skills/agent-experience/SKILL.md'
  const OWN = '/home/user/proj/sand/skills/academic-verify/SKILL.md'

  it('drops official preset skills from the global inventory', async () => {
    const fake = fakeSkills({
      rows: [
        { name: 'agent-experience', path: OFFICIAL },
        { name: 'academic-verify', path: OWN },
      ],
    })
    const inventory = await readGlobalSkills(fake, { showOfficialSkills: false })
    expect(inventory.rows.map((r) => r.name)).toEqual(['academic-verify'])
  })

  it('drops official preset skills from the agent inventory too, keeping one口径', async () => {
    // 两个读函数必须同口径，否则会出现「全局视图藏了、工作区视图还在」。
    const fake = fakeSkills({
      rows: [
        { name: 'agent-experience', path: OFFICIAL },
        { name: 'academic-verify', path: OWN },
      ],
    })
    const inventory = await readAgentSkills(fake, { id: 's1' }, '/w', { showOfficialSkills: false })
    expect(inventory.rows.map((r) => r.name)).toEqual(['academic-verify'])
  })

  it('keeps local skills whose `filesystem` provider is shared with the official preset ones', async () => {
    /*
     * **回归守卫**：官方 skill 的 provider 是 `filesystem`、source 是 `custom`，
     * 与本机 88 条自建 skill 完全相同。若有人日后改成「按 provider 白名单外的
     * 非 filesystem 即官方」这种粗口径，这条用例会失败——它钉住同 provider 的本地 skill 必须保留。
     */
    const fake = fakeSkills({
      rows: [
        { name: 'agent-experience', source: 'custom', provider: 'filesystem', path: OFFICIAL },
        { name: 'academic-verify', source: 'custom', provider: 'filesystem', path: OWN },
      ],
    })
    const inventory = await readGlobalSkills(fake, { showOfficialSkills: false })
    expect(inventory.rows.map((r) => r.name)).toEqual(['academic-verify'])
    expect(inventory.rows[0]?.provider).toBe('filesystem')
  })

  it('drops a path-less official provider row (`dsh-office`) at the inventory level', async () => {
    /*
     * 实测行（2026-10-21）：7 条 `office-*` 全部 `provider:'dsh-office'`、
     * `source:'bundled'`、**无 `path`**。路径规则对它们无能为力，只有 provider
     * 白名单能盖住。这条钉住「过滤调用点确实走了 `isOfficialSkill` 而不是只比路径」——
     * 若有人把 `toRows` 改回 `isOfficialSkillPath(entry.path)`，它就会失败。
     */
    const fake = fakeSkills({
      rows: [
        { name: 'office-export-pdf', source: 'bundled', provider: 'dsh-office' },
        { name: 'academic-verify', source: 'custom', provider: 'filesystem', path: OWN },
        { name: 'browser-skill', source: 'runtime', provider: 'runtime' },
      ],
    })
    const inventory = await readGlobalSkills(fake, { showOfficialSkills: false })
    // runtime 行必须保留：它是「用户要能单独关掉」的对象，不在官方白名单里。
    expect(inventory.rows.map((r) => r.name)).toEqual(['academic-verify', 'browser-skill'])
  })

  it('leaves completeness untouched when hiding rows', async () => {
    const fake = fakeSkills({ complete: false, rows: [{ name: 'agent-experience', path: OFFICIAL }] })
    const inventory = await readGlobalSkills(fake, { showOfficialSkills: false })
    expect(inventory).toEqual({ rows: [], complete: false })
  })
})

describe('official infrastructure skills when the display switch is on', () => {
  const OFFICIAL = '/home/user/node_modules/@deepseek-ai/dsh-agent-preset/skills/agent-experience/SKILL.md'
  /*
   * 开关打开时**只改「列不列」，不改任何名字的开/关**：这些行原样回到清单，
   * 后续的关闭动作由策略层决定（路由/求值不动这里）。
   */
  it('keeps official preset skills in the global inventory', async () => {
    const fake = fakeSkills({
      rows: [
        { name: 'agent-experience', path: OFFICIAL },
        { name: 'academic-verify', path: '/home/user/proj/sand/skills/academic-verify/SKILL.md' },
      ],
    })
    const inventory = await readGlobalSkills(fake, { showOfficialSkills: true })
    expect(inventory.rows.map((r) => r.name)).toEqual(['agent-experience', 'academic-verify'])
  })

  it('keeps the path-less official provider rows too (`dsh-office`)', async () => {
    const fake = fakeSkills({
      rows: [{ name: 'office-export-pdf', source: 'bundled', provider: 'dsh-office' }],
    })
    const inventory = await readAgentSkills(fake, { id: 's1' }, '/w', { showOfficialSkills: true })
    expect(inventory.rows.map((r) => r.name)).toEqual(['office-export-pdf'])
  })
})

describe('inventory completeness', () => {
  it('surfaces complete === false instead of pretending the inventory is empty', async () => {
    const fake = fakeSkills({ complete: false, rows: [{ name: 'a' }] })
    const inventory = await readGlobalSkills(fake, { showOfficialSkills: false })
    expect(inventory.complete).toBe(false)
  })

  it('passes complete === true through unchanged', async () => {
    const fake = fakeSkills({ complete: true, rows: [] })
    const inventory: SkillInventory = await readAgentSkills(fake, { id: 's1' }, '/tmp/w', { showOfficialSkills: false })
    expect(inventory).toEqual({ rows: [], complete: true })
  })
})

describe('row mapping', () => {
  it('maps absent optional fields to stable defaults', async () => {
    const fake = fakeSkills({ rows: [{ name: 'a' }] })
    const inventory = await readGlobalSkills(fake, { showOfficialSkills: false })
    // `provider` 缺失 → `'unknown'`，**不能**退成 `'filesystem'`：见 `sourceLabelOf` 的
    // 兜底分支，若在此处冒充成 filesystem，一个判定失败的 skill 会拿到磁盘路径标签。
    expect(inventory.rows).toEqual([
      { name: 'a', description: '', source: 'unknown', provider: 'unknown', modelInvocable: true },
    ])
  })

  it('keeps present optional fields and an explicit modelInvocable: false', async () => {
    const fake = fakeSkills({
      rows: [
        {
          name: 'b',
          description: 'B',
          source: 'custom',
          provider: 'superpowers-dsh',
          invocation: { modelInvocable: false },
        },
      ],
    })
    const inventory = await readGlobalSkills(fake, { showOfficialSkills: false })
    expect(inventory.rows).toEqual([
      {
        name: 'b',
        description: 'B',
        source: 'custom',
        provider: 'superpowers-dsh',
        modelInvocable: false,
      },
    ])
  })

  it('carries path through when present and omits the key entirely when absent', async () => {
    const fake = fakeSkills({
      rows: [
        { name: 'with-path', path: '/home/user/.agents/skills/with-path' },
        { name: 'no-path' },
      ],
    })
    const inventory = await readGlobalSkills(fake, { showOfficialSkills: false })
    expect(inventory.rows[0]?.path).toBe('/home/user/.agents/skills/with-path')
    // **不能补 `''`**：`''` 与「没有 path」是两种不同事实，补空串会让分组无法区分
    // 「runtime 注入」与「路径恰好为空」。
    expect(Object.hasOwn(inventory.rows[1] ?? {}, 'path')).toBe(false)
  })
})

describe('groupKeyOf', () => {
  it('walks up to the nearest `skills` directory (the registration root)', () => {
    // 实测数据里的真实形态：path 的粒度是技能目录本身，直接按它分组会得到 138 组每组 1 个。
    expect(groupKeyOf(row({ name: 'gbrain-status', path: '/home/user/node_modules/gbrain/skills/gbrain-status' }))).toBe(
      '/home/user/node_modules/gbrain/skills',
    )
    expect(groupKeyOf(row({ name: 'why', path: '/home/user/.agents/skills/why' }))).toBe('/home/user/.agents/skills')
  })

  it('picks the innermost `skills` when the path contains more than one', () => {
    // 形如 `.../skills/skills/x` 时，最近的那个才是注册根。
    expect(groupKeyOf(row({ name: 'x', path: '/a/skills/b/skills/x' }))).toBe('/a/skills/b/skills')
  })

  it('falls back to the parent directory when no `skills` segment exists', () => {
    // 自定义目录名：兜底到技能目录的父目录，绝不退化成「每个技能一组」。
    expect(groupKeyOf(row({ name: 'x', path: '/opt/myskills/x' }))).toBe('/opt/myskills')
  })

  it('returns the sentinel for a row without a path', () => {
    expect(groupKeyOf(row({ name: 'browser-skill' }))).toBe(UNGROUPED_KEY)
  })

  it('groups a path-less row by its plugin provider, not as runtime-injected', async () => {
    /*
     * 实测（2026-10-21）：`@deepseek-ai/dsh-skill-office` 注册的 7 条 `office-*`
     * 只给 `locator`/`resourceBase`，**不给 `path`**（`dsh-skill-office/lib/index.js:61-101`），
     * 而宿主 `toSummary` 只透出 `path`。旧规则把它们归进「运行时注入」组，
     * 与它们自己那一行「来源：dsh-office」矛盾。provider 是注册表的强制约束，
     * 所以这类行按 provider 成组，组名即 provider 名。
     */
    expect(groupKeyOf(row({ name: 'office-docx', provider: 'dsh-office' }))).toBe('provider:dsh-office')
    // 不同插件各有各的组，不会并到一组。
    expect(groupKeyOf(row({ name: 'x', provider: 'superpowers-dsh' }))).toBe('provider:superpowers-dsh')
  })

  it('keeps built-in providers in the ungrouped sentinel', () => {
    // `runtime` 由注册表直接注入、真没有出处；`filesystem` 无 path 属于异常形态，
    // 两者都不能冒充某个插件的分组。
    expect(groupKeyOf(row({ name: 'browser-skill', provider: 'runtime' }))).toBe(UNGROUPED_KEY)
    expect(groupKeyOf(row({ name: 'x', provider: 'filesystem' }))).toBe(UNGROUPED_KEY)
    expect(groupKeyOf(row({ name: 'y', provider: 'unknown' }))).toBe(UNGROUPED_KEY)
  })

  it('does not collide the sentinel with a real path', () => {
    // 哨兵含 NUL，真实路径不可能等于它——若用 `''` 就会在某天「路径为空」时静默并组。
    expect(UNGROUPED_KEY).not.toBe('')
    expect(groupKeyOf(row({ name: 'x', path: '/x' }))).not.toBe(UNGROUPED_KEY)
  })
})

describe('groupLabelOf', () => {
  it('names a plugin group after its package under node_modules', () => {
    // 用户要的「插件名」：从 `<...>/node_modules/<包名>/skills` 取包名，
    // 而不是渲染一整串绝对路径（实测命中 superpowers-dsh）。
    expect(
      groupLabelOf('/home/user/.dsh/profiles/debug/node_modules/superpowers-dsh/skills'),
    ).toBe('superpowers-dsh')
  })

  it('names a folder group after its basename', () => {
    expect(groupLabelOf('/home/user/node_modules/gbrain/skills')).toBe('gbrain')
    expect(groupLabelOf('/home/user/proj/sand/skills')).toBe('sand')
  })

  it('steps up one level when the basename is `skills` itself', () => {
    // **回归守卫**：实测 6 组里有 3 组的 basename 都是 `skills`。不退这一级就会得到
    // 三个一模一样的组名（都叫 `skills`），用户完全无法区分——与分组目标直接相反。
    expect(groupLabelOf('/home/user/.agents/skills')).toBe('.agents')
    expect(groupLabelOf('/home/user/Library/Application Support/Tabbit/LocalAgent/skills')).toBe('LocalAgent')
  })

  it('distinguishes the folder groups that share the `skills` basename', () => {
    // 三条真实路径必须给出三个**互不相同**的标签。
    const labels = [
      '/home/user/.agents/skills',
      '/home/user/proj/sand/skills',
      '/home/user/Library/Application Support/Tabbit/LocalAgent/skills',
    ].map((key) => groupLabelOf(key))
    expect(new Set(labels).size).toBe(3)
  })

  it('returns an empty label for the ungrouped sentinel', () => {
    // 空串是给前端的信号：换成本地化文案（`group.ungrouped`），而不是渲染哨兵值。
    expect(groupLabelOf(UNGROUPED_KEY)).toBe('')
  })

  it('names a provider group after the provider itself', () => {
    // 与行详情里的「来源」逐字一致：用户看到的就是注册它的那个 provider。
    expect(groupLabelOf('provider:dsh-office')).toBe('dsh-office')
  })

  it('is independent of the host path prefix', () => {
    // 同一个插件在别人的机器上也得到同样的显示名。
    expect(groupLabelOf('/home/other/.dsh/profiles/web/node_modules/superpowers-dsh/skills')).toBe('superpowers-dsh')
  })
})

describe('sourceLabelOf', () => {
  it('names the plugin when a non-builtin provider owns the skill', () => {
    /*
     * 用户的原始诉求：「如果来源是某个插件，来源就写插件名」。
     *
     * 夹具复刻实测事实：`superpowers-dsh` 这个 provider 由同名 npm 包注册
     * （`superpowers-dsh/lib/index.js:108-109`），而它**故意自报 `source: 'custom'`**
     * （同文件 `const SOURCE = 'custom'`）。因此只有看 `provider` 才认得出插件。
     */
    expect(
      sourceLabelOf(
        row({
          name: 'brainstorming',
          source: 'custom',
          provider: 'superpowers-dsh',
          path: '/home/user/.dsh/profiles/debug/node_modules/superpowers-dsh/skills/brainstorming/SKILL.md',
        }),
      ),
    ).toBe('superpowers-dsh')
  })

  it('writes the registration root path for a filesystem skill, not the per-skill path', () => {
    /*
     * 用户的另一半诉求：「如果是磁盘上的 skill 就写 skill path」。
     *
     * 取**注册根**而不是每条各自的目录：一个根下的几十个 skill 应当显示同一个来源。
     * 若逐条写 `.../skills/academic-verify`，「来源」就退化成「路径列表」。
     */
    expect(
      sourceLabelOf(
        row({ name: 'academic-verify', provider: 'filesystem', path: '/home/user/node_modules/gbrain/skills/academic-verify' }),
      ),
    ).toBe('/home/user/node_modules/gbrain/skills')
  })

  it('gives every skill under one filesystem root the same source label', () => {
    // 同源断言：三个不同 skill 目录必须归到同一个来源字符串，否则「来源」会变成路径清单。
    const labels = [
      '/home/user/node_modules/gbrain/skills/academic-verify',
      '/home/user/node_modules/gbrain/skills/briefing',
      '/home/user/node_modules/gbrain/skills/capture',
    ].map((path) => sourceLabelOf(row({ name: 'x', provider: 'filesystem', path })))
    expect(new Set(labels).size).toBe(1)
    expect(labels[0]).toBe('/home/user/node_modules/gbrain/skills')
  })

  it('returns null for runtime-injected skills so the client can localize', () => {
    // 宿主注册表直接注入的 skill 没有磁盘出处（实测 4 条，provider `runtime`）。
    // 返回 `null` 而不是空串或中文：本模块不持有 locale，文案由前端给。
    expect(sourceLabelOf(row({ name: 'browser-skill', source: 'runtime', provider: 'runtime' }))).toBeNull()
    expect(sourceLabelOf(row({ name: 'bundled-one', source: 'bundled', provider: 'runtime' }))).toBeNull()
  })

  it('falls back to the path when the provider could not be determined', () => {
    /*
     * `provider: 'unknown'`（字段缺失）时**不返回 null**：既然还有 `path`，给出路径
     * 比显示「unknown」或留空有用。这条也守住「缺失 provider 不会被当成 filesystem
     * 之外的东西而漏掉路径」。
     */
    expect(
      sourceLabelOf(row({ name: 'a', provider: 'unknown', path: '/home/user/proj/sand/skills/foo' })),
    ).toBe('/home/user/proj/sand/skills')
  })

  it('returns null when neither a provider identity nor a path is available', () => {
    // 既不是已知 provider、又没有 path → 无出处可写。
    expect(sourceLabelOf(row({ name: 'a', provider: 'unknown' }))).toBeNull()
  })

  it('never returns the raw `source` bucket, which carries no origin information', () => {
    /*
     * **回归守卫**：早先的写法把服务端的 `source`（`custom`）直接渲染给用户，
     * 那正是用户报的「来源都是 custom」。这条用例钉住「返回值不是 `custom`」，
     * 防止将来有人图省事又把 `source` 透出去。
     */
    const labels = [
      sourceLabelOf(row({ name: 'a', source: 'custom', provider: 'filesystem', path: '/r/gbrain/skills/a' })),
      sourceLabelOf(row({ name: 'b', source: 'custom', provider: 'superpowers-dsh' })),
      sourceLabelOf(row({ name: 'c', source: 'user-agents', provider: 'filesystem', path: '/r/.agents/skills/c' })),
    ]
    for (const label of labels) expect(label).not.toBe('custom')
  })
})