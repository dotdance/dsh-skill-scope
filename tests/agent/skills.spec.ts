import { describe, expect, it } from 'vitest'
import { applySkillShadow, type ScopedSkillsFace, type ShadowSkillsFace } from '../../src/agent/skills.ts'

/** 一个可被模型调用的完整定义，用作「复制且只改 modelInvocable」的基准。 */
const definition = {
  name: 'demo',
  description: 'd',
  content: 'BODY',
  path: '/x/demo/SKILL.md',
  whenToUse: 'w',
  resourceBase: '/x/demo',
  invocation: { modelInvocable: true, userInvocable: true },
}

/**
 * 搭一套替身：`skills.get` / `skills.snapshot` 从 `definitions` 读，
 * `scoped.register` 记进 `registered`，返回的 disposer 记进 `released`。
 */
function makeDeps(definitions: Record<string, Record<string, unknown>>, options: { hostScope?: unknown } = {}) {
  const registered: Array<Record<string, unknown>> = []
  const released: string[] = []
  const warnings: string[] = []
  /**
   * 已被成功遮蔽的名字。真实机制：遮蔽 = 注册一份**同名副本**并把 `modelInvocable`
   * 置 false，`snapshot()` **仍会列出这个名字**（`dsh-skill` 的 `collect()` 只按名字去重），
   * 只是 `invocation.modelInvocable` 变成 false。
   *
   * 替身必须复现「名字还在、标记变了」这一点 —— 若替身让名字**消失**，就会放过
   * 「用名字存在性当判据」这类错误（本插件历史上一度如此，导致复验恒判泄漏）。
   */
  const shadowed = new Set<string>()
  /** 被「别的插件」抢先注册、导致我们的注册被同层先到先得静默丢弃的名字。 */
  const rejected = new Set<string>()
  /**
   * 宿主原始 agent 对象本体。只有 `snapshot({ scope })` 传的**就是它**，才返回 Agent 层
   * 的真实读数；传别的对象（哪怕是字段相同的替身）只返回全局层，遮蔽一律读成未生效。
   *
   * 为什么替身必须复现这件事：`dsh-scope` 的层索引**全按对象身份**
   * （`peek(scope)` 用 `this.scoped.get(scope)`；`scopeChainOf(key)` 用 `scopeParents`
   * WeakMap，`dsh-scope/lib/index.js:151-152`、`:239`、`:276-280`）。替身若忽略 `scope`
   * 参数而恒返回同一结果，**这个真根因在单测里就完全不可观测**——事实上它正是这样
   * 躲过了 208 条全绿用例。缺省 `undefined` 时退化为「永远读 Agent 层」，兼容旧用例。
   */
  const hostScope = options.hostScope

  const skills: ShadowSkillsFace = {
    // ShadowSkillsFace 继承 SkillsServiceLike，所以 snapshot 也必须存在（复验路径用）。
    async snapshot(call: { cwd?: string; scope?: unknown } = {}) {
      const readingAgentLayer = hostScope === undefined ? true : call.scope === hostScope
      return {
        skills: Object.values(definitions).map((row) => {
          const name = String(row['name'])
          return {
            name,
            // 读了「非 Agent 层」时，遮蔽看不见 ⇒ 一律可调用。
            invocation: { modelInvocable: !(readingAgentLayer && shadowed.has(name)) },
          }
        }),
        complete: true,
      }
    },
    async get(name: string) {
      return definitions[name]
    },
  }

  const scoped: ScopedSkillsFace = {
    register(skill) {
      const name = String(skill['name'])
      // 同层先到先得：该名字已在同一 Agent 层 ⇒ 静默丢弃，返回 no-op disposer。
      if (rejected.has(name)) return () => {}
      registered.push(skill)
      shadowed.add(name)
      return () => {
        released.push(name)
        shadowed.delete(name)
      }
    },
  }

  return {
    skills,
    scoped,
    registered,
    released,
    warnings,
    /** 与上面 `warnings` 同源：测试断言直接读 `warnings` 数组。 */
    logger: { warn: (m: string) => warnings.push(m) },
    /** 让 `name` 表现为「已被别的插件抢先占用同一层」。 */
    reject: (name: string) => rejected.add(name),
    /** 宿主对象本体；用例把它当 `scopeOf` 传入，替身据此判定是否读到 Agent 层。 */
    hostScope,
  }
}
describe('applySkillShadow', () => {
  it('registers a full copy of the definition, changing only modelInvocable', async () => {
    const { skills, scoped, registered, logger } = makeDeps({ demo: definition })
    const handle = await applySkillShadow({
      skills,
      scoped,
      cwd: '/x',
      agent: { id: 's1' },
      hidden: ['demo'],
      serial: (op) => op(),
      logger,
    })
    expect(handle.applied).toEqual(['demo'])
    expect(registered[0]).toEqual({ ...definition, invocation: { modelInvocable: false, userInvocable: true } })
    expect(registered[0]?.['content']).toBe('BODY')
  })

  it('releases the previous shadow before registering again', async () => {
    const { skills, scoped, registered, released, logger } = makeDeps({ demo: definition })
    const deps = { skills, scoped, cwd: '/x', agent: { id: 's1' }, serial: <T>(op: () => Promise<T>) => op(), logger }
    const first = await applySkillShadow({ ...deps, hidden: ['demo'] })
    const second = await applySkillShadow({ ...deps, hidden: [], previous: first.release })
    expect(released).toEqual(['demo'])
    expect(second.applied).toEqual([])
    expect(registered).toHaveLength(1)
  })

  it('warns but keeps the other shadows when one skill cannot be hidden', async () => {
    // 「少关一个」是常态（同层先到先得被别的插件抢占），不是异常。
    // 此时**不能**回滚全部遮蔽：抛错会冒到 `agent/created` 的 catch 而 fail-open
    // ⇒ 一个 skill 都关不上，比少关一个严重得多。故降级为 warning + 保留其余项。
    const { skills, scoped, released, warnings, logger, reject } = makeDeps({
      demo: definition,
      other: { ...definition, name: 'other' },
    })
    // 让 `demo` 表现为「已被同层的别的插件抢占」⇒ 我们的注册被静默丢弃、遮蔽不生效。
    reject('demo')
    const handle = await applySkillShadow({
      skills,
      scoped,
      cwd: '/x',
      agent: { id: 's1' },
      hidden: ['demo', 'other'],
      serial: (op) => op(),
      logger,
      verifyStillVisible: true,
    })
    // 未抛错，且 `other` 的遮蔽保留了下来（`applied` 记录的是尝试注册的名字，
    // 被同层顶掉的 `demo` 也在其中 —— 生效与否要看快照，见下）。
    expect(handle.applied).toEqual(['demo', 'other'])
    const snap = await skills.snapshot({})
    expect(snap.skills.find((r) => r.name === 'other')?.invocation).toEqual({ modelInvocable: false })
    expect(snap.skills.find((r) => r.name === 'demo')?.invocation).toEqual({ modelInvocable: true })
    expect(released).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('demo')
    expect(warnings[0]).toContain('遮蔽未生效')
  })

  it('does not warn when every shadow landed', async () => {
    const { skills, scoped, warnings, logger } = makeDeps({ demo: definition })
    await applySkillShadow({
      skills,
      scoped,
      cwd: '/x',
      agent: { id: 's1' },
      hidden: ['demo'],
      serial: (op) => op(),
      logger,
      verifyStillVisible: true,
    })
    expect(warnings).toEqual([])
  })

  it('passes the host object as the scope, not a freshly built stand-in', async () => {
    // 承重用例（真实缺陷复现）：`dsh-scope` 的层索引**全按对象身份**——
    // `peek(scope)` 走 `this.scoped.get(scope)`，`scopeChainOf(key)` 走
    // `scopeParents`（WeakMap）。传一个字段相同但 `!==` 本体的替身，查不到 agent 层，
    // 退化成只读全局层 ⇒ **每一个**被遮蔽的名字都读回 `modelInvocable: true`。
    //
    // 实测（probe1 / 3131-3133，chat 工作区，hidden=137）：
    //   scope = 替身（ctor=Object）         → exposed=69（68 个误报）
    //   scope = 本体（ctor=ReactLoopAgent） → exposed=1（只有真漏的 browser-skill）
    //   `agentAsScope_isSameAsScopeKey=false` 是同一回事的直接证据。
    //
    // 替身的 `snapshot` 只在 `scope === hostScope` 时读 Agent 层，因此本用例
    // **真的会观察到后果**（传错对象 ⇒ 整批被误报为漏网 ⇒ 出现 warning），
    // 而不是只断言「那个参数被传进去了」。
    const hostAgent = { id: 's1', hostMark: 'ReactLoopAgent' }
    const standIn = { id: 's1' }
    const { skills, scoped, warnings, logger } = makeDeps({ demo: definition }, { hostScope: hostAgent })
    const seen: Array<Record<string, unknown>> = []
    const recording = {
      get: skills.get.bind(skills),
      snapshot: async (options: Record<string, unknown>) => {
        seen.push(options)
        return skills.snapshot(options as never)
      },
    }
    await applySkillShadow({
      skills: recording as never,
      scoped,
      cwd: '/x',
      agent: standIn,
      scopeOf: hostAgent,
      hidden: ['demo'],
      serial: (op) => op(),
      logger,
      verifyStillVisible: true,
    })
    // ① 复验那一次必须带**本体**，不能带替身。
    const verifyCall = seen[seen.length - 1]
    expect(verifyCall?.['scope']).toBe(hostAgent)
    expect(verifyCall?.['scope']).not.toBe(standIn)
    // ② 传对了对象 ⇒ 遮蔽读得到 ⇒ 不得有任何「遮蔽未生效」警告。
    expect(warnings).toEqual([])
  })

  it('reports the whole batch as leaked when the scope is a stand-in instead of the host object', async () => {
    // 反面对照，证明上面的替身确实**有检测力**：去掉 `scopeOf` 之后，复验拿替身当
    // scope，替身读不到 Agent 层 ⇒ 遮蔽「看不见」⇒ 整批误报。
    // 这正是实机上 `exposed=69`（而非 1）的成因，锁住它可防止回归。
    const hostAgent = { id: 's1', hostMark: 'ReactLoopAgent' }
    const { skills, scoped, warnings, logger } = makeDeps({ demo: definition }, { hostScope: hostAgent })
    await applySkillShadow({
      skills,
      scoped,
      cwd: '/x',
      // 故意不给 `scopeOf`：复验退回用这个替身当 scope。
      agent: { id: 's1' },
      hidden: ['demo'],
      serial: (op) => op(),
      logger,
      verifyStillVisible: true,
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('demo')
    expect(warnings[0]).toContain('遮蔽未生效')
  })

  it('passes verification when the shadow landed, even though the name stays listed', async () => {
    // 承重用例：遮蔽成功后**名字仍在 snapshot 里**，只是 `modelInvocable` 变 false。
    // 若判据退回「名字在不在」，本用例会误判为泄漏并抛错 ⇒ 用它锁死正确判据。
    const { skills, scoped, logger } = makeDeps({ demo: definition })
    const handle = await applySkillShadow({
      skills,
      scoped,
      cwd: '/x',
      agent: { id: 's1' },
      hidden: ['demo'],
      serial: (op) => op(),
      logger,
      verifyStillVisible: true,
    })
    expect(handle.applied).toEqual(['demo'])
    // 名字确实还在清单里（这正是错误判据会踩的坑）。
    const snap = await skills.snapshot({})
    expect(snap.skills.map((row) => row.name)).toEqual(['demo'])
  })

  it('skips registration for a name the registry does not know', async () => {
    const { skills, scoped, registered, warnings, logger } = makeDeps({})
    const handle = await applySkillShadow({
      skills,
      scoped,
      cwd: '/x',
      agent: { id: 's1' },
      hidden: ['ghost'],
      serial: (op) => op(),
      logger,
    })
    expect(handle.applied).toEqual([])
    expect(registered).toEqual([])
    expect(warnings).toHaveLength(1)
  })
})