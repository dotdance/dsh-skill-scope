import type { SkillsServiceLike } from '../inventory/skills.ts'

/**
 * 阴影（shadow）用到的 skill 服务面：在清单面之上补一个 `get`。
 * `get` 按名字取**完整定义**（含 `content`），用来做「原样复制、只改可见性」的注册。
 */
export interface ShadowSkillsFace extends SkillsServiceLike {
  get(name: string, options: { scope: unknown; cwd: string }): Promise<Record<string, unknown> | undefined>
}

/**
 * 注册面：向**该 Agent 的作用域层**注入一条运行时 skill，返回释放函数。
 *
 * `agent` 是**必需的第二个实参**，不是便利参数：`dsh-skill` 的 `register()` 用
 * `scopeOf(this.ctx)` 决定落到哪一层（`dsh-skill/lib/index.js:195`），
 * 因此「注册到哪个作用域」完全由**被调用的那个服务实例**的 ctx 决定。
 * 只有从 `agent.ctx.get('skills')` 取到的实例才是该 Agent 的作用域层。
 * 真实装配传入的 `scoped` 因此是**按 agent 惰性解析**的代理（见 `src/assembly.ts`）。
 *
 * 替身可以忽略这个参数（现有单测就是这样），但真实实现**必须**用它解析作用域。
 */
export interface ScopedSkillsFace {
  register(skill: Record<string, unknown>, agent?: unknown): () => void
}

/** `applySkillShadow` 的入参。 */
export interface ApplySkillShadowInput {
  skills: ShadowSkillsFace
  scoped: ScopedSkillsFace
  cwd: string
  agent: unknown
  hidden: readonly string[]
  serial: <T>(operation: () => Promise<T>) => Promise<T>
  logger: { warn(message: string): void }
  /** 上一轮的释放函数；新一轮先释放它，才能让「同名换定义」真的替换。 */
  previous?: () => void
  /** 测试便利：给出定义表时，替身 `skills.get` 从这里取。 */
  definitions?: Record<string, Record<string, unknown>>
  /** 打开后做「全新读一次清单」的复验；发现仍有未关上的项只 `logger.warn`，不回滚、不抛错。 */
  verifyStillVisible?: boolean
  /**
   * 复验时传给 `snapshot({ scope })` 的**宿主原始 agent 对象本体**。
   *
   * 只有它能在 `dsh-scope` 的 WeakMap / Map 里命中 agent 层；`agent`（替身）不行。
   * 见下方复验段的长注释。省略时退回 `agent`（测试替身场景）。
   */
  scopeOf?: unknown
}

/** 应用结果：本轮实际注册的名字，以及释放函数。 */
export interface ApplySkillShadowResult {
  release: () => void
  applied: string[]
}

/**
 * 把一批 skill 关成「只对用户可见」（设计 5.2）。
 *
 * 产品决定：**关闭 = 只对模型不可见，用户手动 `/name` 调用一律保留**。
 * 所以注册的是原定义的完整副本，只把 `invocation.modelInvocable` 置 false，
 * 并把 `userInvocable` 兜成 `true`——绝不能顺手删掉 `content`、`path` 等字段，
 * 否则用户的 `/name` 会拿到一个空壳。
 *
 * 顺序（全部在 `serial` 内，避免与同 Agent 的其他装配步骤交错）：
 * 1. 先释放上一轮 → 2. 逐个取定义 → 3. 注册 → 4. 可选复验。
 *
 * 取不到定义只记 warning 并跳过，不抛错：清单里出现的名字未必还留在注册表里
 * （provider 掉线、文件被删），这不是代码缺陷，不该让整轮装配失败。
 * 复验发现漏网同样只记 warning：详见下方复验段的注释（抛错会导致**全部遮蔽失效**）。
 *
 * 调用方只在「目标隐藏集变化」时调用本函数——同层重名注册在 `dsh-skill` 里
 * 是 warning + no-op disposer，每个回合无条件重注册只会刷告警。
 * 但每次调用仍先释放上一轮：同名不同定义的替换必须靠「先撤后注册」才生效。
 */
export async function applySkillShadow(input: ApplySkillShadowInput): Promise<ApplySkillShadowResult> {
  return await input.serial(async () => {
    input.previous?.()

    const applied: string[] = []
    const disposers: Array<() => void> = []

    // ── 先一次性把所有定义取出来，再统一注册 ──
    //
    // 早先的写法是「取一个 → 注册一个」，而 `register()` 会无条件调用
    // `invalidateCache()`（`dsh-skill/lib/index.js:377`）：`revision += 1`
    // 且 `collectCache.clear()`。`get()` 的收集缓存正是按 revision 做键的
    // （同文件 `:266-296`），于是**每注册一个就让下一个 `get()` 必然缓存未命中**，
    // 触发一次完整的 `collectFresh()` 全量枚举。
    //
    // 实测（probe1 / 3092，127 个隐藏项）：逐个 `get()` 各约 22-25ms，合计
    // **3495ms / 2913ms**；而把取定义与注册分成两段后，注册阶段的 254 次
    // `register` 合计仅 **15ms**（均 0.06ms/次）。
    const definitions: Array<{ name: string; definition: Record<string, unknown> }> = []
    for (const name of input.hidden) {
      const definition = await input.skills.get(name, { scope: input.agent, cwd: input.cwd })
      if (definition === undefined) {
        // 注册表不认识这个名字：跳过而非抛错，见函数注释。
        input.logger.warn(`dsh-skill-scope: 无法遮蔽 skill「${name}」：注册表中找不到它的定义`)
        continue
      }
      definitions.push({ name, definition })
    }
    // 预留一轮注册后 revision 会变，故上面这一批必须全部取完再往下注册。
    for (const { name, definition } of definitions) {
      const invocation = readInvocation(definition)
      disposers.push(
        input.scoped.register(
          {
            ...definition,
            invocation: {
              ...invocation,
              modelInvocable: false,
              // 只在用户显式写了 `false` 时才关掉用户入口；字段缺失按「保留」处理。
              userInvocable: invocation?.['userInvocable'] !== false,
            },
          },
          // 作用域由这个 agent 决定；替身可忽略，真实代理靠它取 `agent.ctx.get('skills')`。
          input.agent,
        ),
      )
      applied.push(name)
    }

    // ── 落地后回读复验 ──
    //
    // 判据**必须**看读回来的 `invocation.modelInvocable`，**不能**看「名字在不在清单里」：
    // 遮蔽的做法是注册一份同名副本并把 `modelInvocable` 置 false，`dsh-skill` 的
    // `snapshot()` 仍会列出这个名字（同文件 `collect()` 只按名字去重）。
    // 拿名字存在性当判据，结果恒等于 `input.hidden` 全集，区分不出真泄漏。
    //
    // 判据是读回项的 `invocation.modelInvocable !== false`：
    //   `verified.skills.find((s) => denied.has(s.name) && s.invocation?.modelInvocable !== false)`
    // 实测（probe1 / 3101，chat 工作区）：只按名字判会得到 `leaked=137 = hidden 全集`；
    // 按 `modelInvocable !== false` 判才能定位到真正漏掉的那一个（`browser-skill`）。
    //
    // ── 为什么失败只警告、不回滚不抛错 ──
    //
    // 另一条路是 `dispose()` 全部回滚后 `throw`。本插件**不采用**：
    // 本插件的调用点全在 `agent/created` / `skills/change` 的监听器里，抛错会一路冒到
    // `src/agent/hooks.ts` 的 catch，而那两个回调**一律 fail-open**（`agent/created` 是 serial
    // 派发，监听器抛错会让会话创建失败，所以必须吞掉）。
    // ⇒ 复验抛错的最终效果是「**一个 Skill 都关不上**」，比「少关一个」严重得多。
    //
    // 而「少关一个」恰恰是常态而非异常：若该名字被**别的插件先注册进同一 Agent 层**，
    // `register()` 会同层先到先得、静默丢弃我们的注册（`dsh-skill/lib/index.js:195-198`）。
    // 实测案例 `browser-skill`（由本机一个第三方插件在 `agent/created`
    // 里同步注册，本插件同事件注册但要先 await 读策略，必然落后）。
    // 这种局面下回滚全部遮蔽，是拿「一大批正常项」去陪葬「一个关不掉的项」。
    //
    // 因此策略是：**如实警告 + 保留其余生效项**。不复验重贴，因为重贴写同一层、同样被丢弃；
    // 也不做每轮先撕后贴，那会清空 `collectCache`（`:376-380`）并与 prompt cache
    // 冲突，且如上所述并未真正解决该案例。
    if (input.verifyStillVisible === true) {
      // **必须传宿主的原始 agent 对象本体，不能用 `asAgentLike` 造的替身。**
      //
      // `dsh-scope` 的层查找按**对象身份**索引：`peek(scope)` 走
      // `this.scoped.get(scope)`，`scopeChainOf(key)` 走 `scopeParents`（WeakMap）。
      // 替身与本体字段相同却 `!==`，查不到 agent 层 ⇒ 只读全局层 ⇒ **每一个**被
      // 遮蔽的名字都读回 `modelInvocable: true`。实测（probe1 / 3131-3133，chat 工作区）：
      //   scope = 替身（ctor=Object）         → exposed=69，md-word-count 读回 true
      //   scope = 本体（ctor=ReactLoopAgent） → 归到真漏项
      // `agentAsScope_isSameAsScopeKey=false` 是同一回事的直接证据。
      const snapshot = await input.skills.snapshot({
        scope: input.scopeOf ?? input.agent,
        cwd: input.cwd,
      })
      const hiddenSet = new Set(input.hidden)
      const exposed = snapshot.skills
        .filter((row) => hiddenSet.has(row.name) && row.invocation?.['modelInvocable'] !== false)
        .map((row) => row.name)
      if (exposed.length > 0) {
        input.logger.warn(
          `dsh-skill-scope: 以下 skill 遮蔽未生效（疑似被同层先到先得顶掉，已保留其余 ${applied.length} 项）：${exposed.join(', ')}`,
        )
      }
    }

    return { release: () => releaseAll(disposers), applied }
  })
}

/** 读出定义里的 `invocation` 对象；形状不对时返回 `undefined`（按缺省语义处理）。 */
function readInvocation(definition: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = definition['invocation']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

/** 逐个释放；重复调用无害（释放函数自身的幂等性由 `dsh-skill` 保证）。 */
function releaseAll(disposers: readonly (() => void)[]): void {
  for (const dispose of disposers) dispose()
}