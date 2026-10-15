import type { LayerPolicy } from '../policy/schema.ts'
import { validatePolicyInput } from '../policy/schema.ts'
import type { PolicyStore, SaveOutcome } from '../policy/store.ts'
import type { AgentStates } from '../agent/state.ts'
import { classifyMcp, type McpRow, type McpToolFace } from '../inventory/mcp.ts'
import {
  groupKeyOf,
  groupLabelOf,
  readAgentSkills,
  readGlobalSkills,
  sourceLabelOf,
  type SkillInventory,
  type SkillRow,
  type SkillsServiceLike,
} from '../inventory/skills.ts'
import { resolveSession, type PluginContextLike, type SessionView } from './session.ts'
import { asRecord, readString } from '../shared/unknown.ts'

/** 面向前端的错误码。**没有 `method-not-allowed`**：只声明 POST，非 POST 由宿主返回 404（设计 6.2）。 */
export type ErrorCode = 'bad-request' | 'stale-revision' | 'unknown-session' | 'internal'

/** 统一信封（设计 6.2）：成功给 `value`，失败给 `{ code, message }`。 */
export type Envelope<T> = { ok: true; value: T } | { ok: false; error: { code: ErrorCode; message: string } }

/**
 * 路由依赖（结构性注入，便于纯内存测试）。
 * `ctx` 只需最小面：`handleWorkspace` 要用它解析会话。
 */
export interface RouteDeps {
  store: PolicyStore
  states: AgentStates
  skills: SkillsServiceLike
  tools: McpToolFace
  loaderServers: () => Promise<string[]>
  logger: { warn(message: string): void }
  /** 会话解析所需的 ctx（sessionQuery / agents / agentPresets）。 */
  ctx: PluginContextLike
  /**
   * 保存成功后的「立刻重新落地」入口（设计 `docs/design.md` §3.7「保存驱动」那条边）。
   *
   * 策略保存在宿主事件面**不发声**：`Store` 的 `fs.writeFile` 不触碰 Skill/Tool 注册表，
   * 因此不发 `skills/change` / `tools/change`。缺了这条显式调用，同一会话里改策略
   * 只有等新会话才生效（用户实测缺陷）。实现方已内置 try/catch + warn，
   * 调用方**不必**再包一层（重复兜底会掩盖真正的失败原因）。
   */
  reapplyAfterSave: () => Promise<void>
}

/**
 * 一个 skill 行 + 它的**来源分组**（服务端算好）。
 *
 * **为什么分组在服务端算**：分组要靠 `path` 上卷到注册根，还要从
 * `node_modules/<包名>` 提取插件名。这套归一化只该有一份实现；放前端会让
 * 「插件名怎么来的」「没有 skills 这一级怎么兜」这些细节漂移成两份。
 * 前端只拿到 `group`（排序/折叠用的稳定 key）与 `groupLabel`（显示名）。
 */
export type GroupedSkillRow = SkillRow & {
  /** 分组的稳定 key（注册根绝对路径；无路径的 runtime skill 用 `UNGROUPED_KEY`）。 */
  group: string
  /** 分组的显示名（插件名或文件夹 basename）；无路径组为 `''`，由前端换成文案。 */
  groupLabel: string
  /**
   * 真实来源标签：插件 provider 名，或磁盘 skill 的注册根绝对路径。
   * `null` 表示该 skill 没有磁盘出处（runtime 注入），前端换成文案。
   * **它取代原先直接显示的 `source`**——`source` 的 `custom` 对用户没有信息量。
   */
  sourceLabel: string | null
}

/** 把清单里每一行挂上它的分组信息与真实来源标签。 */
function withGroups(rows: readonly SkillRow[]): GroupedSkillRow[] {
  return rows.map((row) => {
    const group = groupKeyOf(row)
    return { ...row, group, groupLabel: groupLabelOf(group), sourceLabel: sourceLabelOf(row) }
  })
}

export type GlobalValue = {
  policy: LayerPolicy
  revision: string | null
  inventory: { skills: GroupedSkillRow[]; mcps: McpRow[] }
}

/**
 * 工作区面板返回体。`live` = 该会话当前是否有 live Agent（有才走实时清单）。
 *
 * `disabledGlobally` 与 `inherited` 是**服务端算好的**全局层事实（设计 `docs/design.md` §6.4）。
 * **2026-10-14 之后两个字段都不再驱动任何文字**：MCP 段顶部那句「继承自全局：N 项
 * （全局已关闭 M 项）」与顶部说明段末尾那句「被全局关闭 N 项」都按用户要求删除了。
 * 保留二者的原因是**不改返回体形状**（客户端仍可能按形状校验），不是为了显示。
 * `disabledGlobally` 在客户端**仍被读取**，但只剩一个用途：`toMcpRows` 的 `excludeNames`。
 * **`disabledGlobally` 里的名字不在 `inventory` 里**（已被 `withoutClosed` 整条摘除），
 * 所以它也不是可渲染的行。它是 skill 名与 MCP server 名的并集；
 * 而 `inherited.disabledGlobally` 是 `policy.mcps` 的长度，只数 MCP ——
 * `inherited` 那侧的 `total` 同样只数 MCP（见 `buildWorkspaceView`）。
 * 二者都是可选的：客户端缺 `disabledGlobally` 时退回 `[]`，宁可让一条本该摘除的 MCP
 * 照常显示（可见的过度授予），也不要凭空摘掉用户自己配的项（静默失效更糟），
 * 所以**服务端仍必须填**。
 */
export type WorkspaceValue = GlobalValue & {
  cwd: string
  policyPath: string
  exists: boolean
  live: boolean
  disabledGlobally?: string[]
  inherited?: { total: number; disabledGlobally: number }
}

/**
 * 读 `revision`：三态，不能压成 `string | null`。
 * - 缺键 / `undefined` → `undefined`（「没说」，等价于「期望还没有文件」）
 * - 显式 `null` → `null`（「我期望文件尚不存在」）
 * - 字符串 → 原值（「我期望文件是这个 revision」）
 * - 其它类型 → `undefined`（当作没说，交给 store 的守卫处理，而不是假装它合法）
 */
function readRevision(source: Record<string, unknown> | null): string | null | undefined {
  if (source === null) return undefined
  const value = source['revision']
  if (value === null) return null
  return typeof value === 'string' ? value : undefined
}

/**
 * 读会话 id：只接受非空字符串。用于 `handleGlobal` / `handleGlobalSave` 的可选 `sessionId`。
 */
function readSessionId(source: Record<string, unknown> | null): string | null {
  const value = readString(source, 'sessionId')
  return value !== null && value !== '' ? value : null
}

/** 把一个异常折成 `internal` 信封。绝不外泄原始异常对象，只带可读消息。 */
function internal(error: unknown): Envelope<never> {
  return { ok: false, error: { code: 'internal', message: `路由处理失败：${String(error)}` } }
}

/**
 * 读 MCP 清单。
 * `loaderServers()` 可能 reject（loader 注册表本身可能读不出来）——那不是致命错误，
 * 记一条 warning 并按空列表继续，否则「读一次面板」会因为一个诊断信息失败而整片失败。
 */
async function readMcpRows(deps: RouteDeps): Promise<McpRow[]> {
  let loaderServers: string[] = []
  try {
    loaderServers = await deps.loaderServers()
  } catch (error) {
    deps.logger.warn(`dsh-skill-scope: 读取 loader server 列表失败（按空列表处理）：${String(error)}`)
  }
  const scopeToolNames = deps.tools.schemas().map((schema) => schema.name)
  return classifyMcp({
    scopeToolNames,
    restrictableNames: deps.tools.view().restrictableNames,
    loaderServers,
  })
}

/** 由 store 的读结果与清单拼出 `GlobalValue`（两个读路由共用）。 */
function toGlobalValue(
  loaded: { policy: LayerPolicy; revision: string | null },
  inventory: { skills: GroupedSkillRow[]; mcps: McpRow[] },
): GlobalValue {
  return {
    policy: loaded.policy,
    revision: loaded.revision,
    inventory,
  }
}

/**
 * 读会话语境的工作区路由入参：解析 `sessionId` → 解析会话。
 *
 * 读取路由与保存路由的这段**逐字符相同**（两个 `unknown-session` 分支也一样），
 * 收成一处后两条路由的拒绝语义不可能分叉。
 * 返回信封而不是抛错：调用方直接把 `error` 回给前端。
 */
async function resolveWorkspaceSession(
  deps: RouteDeps,
  payload: Record<string, unknown> | null,
): Promise<
  | { ok: true; sessionId: string; view: SessionView }
  | { ok: false; error: { code: ErrorCode; message: string } }
> {
  const sessionId = readSessionId(payload)
  if (sessionId === null) {
    return { ok: false, error: { code: 'unknown-session', message: '工作区路由需要 sessionId' } }
  }
  const view = await resolveSession(deps.ctx, sessionId)
  if (view === null) {
    return { ok: false, error: { code: 'unknown-session', message: `未找到会话：${sessionId}` } }
  }
  return { ok: true, sessionId, view }
}

/**
 * 把 store 的写失败折成信封：只有 `stale-revision` 保留原名，其余一律 `internal`。
 * 两个保存路由共用，避免错误码映射漂移。
 */
function saveFailure(
  saved: Extract<SaveOutcome, { ok: false }>,
): { ok: false; error: { code: ErrorCode; message: string } } {
  return {
    ok: false,
    error: { code: saved.code === 'stale-revision' ? 'stale-revision' : 'internal', message: saved.message },
  }
}

/**
 * 读全局策略 + 全局清单，拼出 `GlobalValue`。全局读路由与全局保存路由共用。
 *
 * **每次调用都重读 store.loadGlobal()**。策略是外部同步可读状态，任何跨请求缓存
 * 都会让用户在别处改过的文件在面板上不可见（设计 3.7 的「策略不冻结」）。
 *
 * **全局清单列宿主全部 Skill，不做 `modelInvocable` 过滤**（用户明确要求）。
 * 理由是全局层是**决定开关的地方**：若在此隐藏 `modelInvocable === false` 的能力，
 * 用户就再也找不到入口把它们重新打开。工作区层才做收窄（见 `handleWorkspace`）。
 */
async function readGlobalValue(deps: RouteDeps, payload: Record<string, unknown> | null): Promise<GlobalValue> {
  const loaded = await deps.store.loadGlobal()
  const skills = await readGlobalSkills(deps.skills)
  const mcps = await readMcpRows(deps)
  return toGlobalValue(loaded, {
    skills: withGroups(skills.rows),
    mcps,
  })
}

/**
 * `POST /api/skill-scope/global`：全局策略 + 全局清单。
 */
export async function handleGlobal(body: unknown, deps: RouteDeps): Promise<Envelope<GlobalValue>> {
  try {
    return { ok: true, value: await readGlobalValue(deps, asRecord(body)) }
  } catch (error) {
    return internal(error)
  }
}

/**
 * `POST /api/skill-scope/global/save`：写入全局策略。
 *
 * 入站体走 `validatePolicyInput`（严格），失败即 `bad-request`，且 `message` 里必须带
 * 出问题的字段或名字——用户只能看到这一句，指不到具体条目就没法自助修复。
 */
export async function handleGlobalSave(body: unknown, deps: RouteDeps): Promise<Envelope<GlobalValue>> {
  try {
    const payload = asRecord(body)
    const validated = validatePolicyInput(payload)
    if (!validated.ok) {
      return { ok: false, error: { code: 'bad-request', message: validated.message } }
    }
    const saved = await deps.store.saveGlobal(validated.policy, readRevision(payload))
    if (!saved.ok) return saveFailure(saved)
    // 保存后返回**重新读出来**的视图，而不是回显入参：这样 revision 与规范化后的名单
    // 都是磁盘事实，前端可以直接拿它当下一轮保存的期望值。
    //
    // `reapplyAfterSave` 必须在**回读之前**调用：它会把新策略落到每个存活 Agent 的
    // shadow/restriction 上，而下面的读取仍读磁盘（不读落地结果），顺序对读值无影响；
    // 但放在这里能让「写入 → 落地 → 回读」在同一条 try 里，异常语义一处可见。
    await deps.reapplyAfterSave()
    return { ok: true, value: await readGlobalValue(deps, payload) }
  } catch (error) {
    return internal(error)
  }
}

/**
 * `POST /api/skill-scope/workspace`：某会话的工作区策略 + 该会话的清单。
 *
 * **清单起点是「全局未关闭的项」，不是「Agent 当前可见的项」**。
 *
 * 为什么不能用 Agent 可见清单：关掉一个 skill 的手段**就是**把它遮蔽成不可见
 * （`applySkillShadow` 注册一份 `modelInvocable:false` 的副本）。于是
 * `readAgentSkills` 返回的 rows 里**天然不含已被本工作区关闭的项**——
 * 用「可见集」当清单，等于用「关掉的结果」当「关掉的依据」，自己把自己的记账本撕了。
 * 后果：**只有本工作区关闭、全局放行**的项在面板上完全消失，用户既看不到、也没有入口
 * 把它们打开（实测 chat 工作区：16 项全局放行项里只剩 2 项，漏 13 项）。
 *
 * 现在的组装规则（三条并集，用户逐条确认）：
 * 1. **全局未关闭**（`global.policy.skills` 之外）—— 全局层是硬上限，被它关掉的整条摘除。
 * 2. **Agent 可见**（`readAgentSkills`）—— 即当前未被本工作区关闭的项，标「已启用」。
 * 3. **本工作区已关闭、但全局未关闭**（本路由从磁盘策略补回）—— 标「已禁用」。
 *
 * 第 3 条是本次修复的核心：这些名字**不在**第 2 条里（被遮蔽了），必须显式补回来。
 * 它们只补「全局放行」的（第 1 条的约束）；全局已关闭的仍整条摘除，不进第 3 条。
 *
 * **`modelInvocable === false` 的项不过滤**：
 * 这类 skill 的 frontmatter 写了 `disable-model-invocation: true`（「只给用户手动调用」），
 * 面板照样列出，靠行内状态标注「不可被模型调用」区分。理由是**授权**与**AI 能否调用**
 * 是两件事：前者是用户在本面板的决定，后者是 skill 作者的声明，混在一起会让
 * 「我关了它」和「它本来就不能给 AI 用」看起来一样。
 * （历史：本路由曾用 `invocableOnly` 过滤，那是把「AI 能否调用」当成了「要不要展示」。）
 *
 * **全局层是硬上限**（设计 `docs/design.md` §1.2）：全局已关闭的名字从工作区清单里
 * **整条摘除**（用户明确要求「完全不显示」），而不是折叠展示。同时把名单放进
 * 同时把名单放进 `disabledGlobally` 供客户端摘行（它不再用于任何说明文字）。
 * 少了这层减法，用户在全局面板关掉的能力会在工作区面板里原样出现，
 * 表现为「全局关闭了大部分 skill，工作区还是能看到」。
 *
 * **组装工作全部委托给 `buildWorkspaceView`**：本函数只负责解析会话与拒绝未知会话。
 * 保存路由共用同一个函数，因此两条路由的清单口径不存在分叉的可能。
 */
export async function handleWorkspace(body: unknown, deps: RouteDeps): Promise<Envelope<WorkspaceValue>> {
  try {
    const resolved = await resolveWorkspaceSession(deps, asRecord(body))
    if (!resolved.ok) return { ok: false, error: resolved.error }
    return { ok: true, value: await buildWorkspaceView(deps, resolved.view, resolved.sessionId) }
  } catch (error) {
    return internal(error)
  }
}

/**
 * 工作区面板的 Skill 清单组装（本路由与 `handleWorkspaceSave` 共用，口径不许分叉）。
 *
 * 输入三份事实：
 * - `visible`：Agent 作用域的活清单（未被本工作区关闭的项在这里）。
 * - `workspacePolicy`：本工作区的策略（名单里的项被本工作区关闭）。
 * - `global`：全局清单（提供被关闭项的**行数据**）。
 * - `closedGlobally`：全局策略关闭的名字，**硬上限**。
 *
 * 输出 = **全局未关闭** ∩（**Agent 可见** ∪ **本工作区已关闭**）。
 *
 * 「本工作区已关闭」的名字要从全局清单里**取回行数据**（描述、来源、分组），
 * 因为它们在 `visible` 里根本不存在——被遮蔽了（见 `handleWorkspace` 的注释）。
 * 全局清单里也找不到的名字（skill 已被删除、provider 掉线）就跳过：没有行数据可渲染，
 * 硬塞一个空壳行会让用户看到一个点不动的开关。
 *
 * `complete` 取 `visible` 的：残缺时 UI 要拒绝收窄写入（`SkillInventory.complete` 的契约）。
 * 补回的行不改变完整性——它们是策略里的名字，不是清单发现的结果。
 */
function composeWorkspaceSkills(
  visible: SkillInventory,
  workspacePolicy: LayerPolicy,
  global: SkillInventory,
  closedGlobally: readonly string[],
): SkillInventory {
  const blocked = new Set(closedGlobally)
  const byName = new Map(global.rows.map((row) => [row.name, row]))
  const present = new Set(visible.rows.map((row) => row.name))
  const restored: SkillRow[] = []
  for (const name of workspacePolicy.skills) {
    if (present.has(name)) continue
    if (blocked.has(name)) continue
    const row = byName.get(name)
    if (row === undefined) continue
    restored.push(row)
  }
  return {
    rows: [...visible.rows, ...restored].filter((row) => !blocked.has(row.name)),
    complete: visible.complete,
  }
}

/**
 * 全局策略关掉了哪些名字（设计 3.1 的生效集语义）。
 *
 * 只有一种语义：**名单里的就是被关掉的**。
 * 于是「全局关了 N 项」永远可枚举，工作区层能精确摘除，不再有
 * 「白名单下无法枚举未出现的名字、只能显示空集合」那个保守的缺口。
 *
 * 因此 `LayerPolicy` 的两份名单**本身就是**关闭集，调用方直接读 `policy.skills` /
 * `policy.mcps`，不需要一层再包一次的同形对象。
 */

/** 摘掉名字落在 `closed` 里的行；`closed` 为空时原样返回（避免无谓的数组复制）。 */
function withoutClosed<T>(rows: readonly T[], closed: readonly string[], nameOf: (row: T) => string): T[] {
  if (closed.length === 0) return [...rows]
  const blocked = new Set(closed)
  return rows.filter((row) => !blocked.has(nameOf(row)))
}

/**
 * **工作区视图的唯一组装口径**（读取路由与保存路由共用，调用方不许各自再拼一遍）。
 *
 * 抽出来的理由不只是「少写几行」：这段逻辑原先在 `handleWorkspace` 与
 * `handleWorkspaceSave` 里**逐段复制了两份**（9 步相同），而它的正确性依赖
 * 「两条路由的组装口径完全一致」。两份副本已经造成过一次用户可见的缺陷
 * （见下方 `composeWorkspaceSkills` 调用点的历史注释），所以这里把它收敛成一处：
 * 只要这个函数是对的，两条路由就都是对的。
 *
 * 顺序要求（**步骤顺序是逻辑，不是风格**）：
 * 1. 先读工作区策略与 agent 作用域清单（`scopedSkills`）——后者的作用域**必须传会话
 *    解析出的 agent 本体**，替换对象会让 `dsh-scope` 按身份查不到层、静默退化成全局层。
 * 2. 读全局清单与全局策略。全局策略是**硬上限**：被它关掉的名字要整条摘除，
 *    而不是折叠展示（用户明确要求「完全不显示」）。
 * 3. 组装 skill 清单（`composeWorkspaceSkills`）。
 * 4. 摘除全局关闭项（skill 按 `name`、MCP 按 `serverName`）。
 * 5. **摘除之后**才算 `inherited.total`——它必须等于实际列给用户的继承项数量，
 *    否则「继承自全局：2 项（全局已关闭 1 项）」会在只有 1 行时自相矛盾。
 *
 * 调用方（保存路由）必须在调用本函数**之前**完成写盘与 `reapplyAfterSave`：
 * 本函数只读，不负责落地。
 */
async function buildWorkspaceView(
  deps: RouteDeps,
  view: SessionView,
  sessionId: string,
): Promise<WorkspaceValue> {
  const cwd = view.cwd
  const loaded = await deps.store.loadWorkspace(cwd)
  const scopedSkills =
    view.agent === null ? await readGlobalSkills(deps.skills) : await readAgentSkills(deps.skills, view.agent, cwd)
  // 全局策略是硬上限：先读它，再把已关闭的名字从可见面里摘出去。
  const globalPolicy = (await deps.store.loadGlobal()).policy
  // skill 侧的全局关闭项由 `composeWorkspaceSkills` 在内部整条摘除（它同时要拦下
  // 补回的被关闭项），所以这里**不再**对它叠一层 `withoutClosed`。
  const liveSkills: SkillInventory = composeWorkspaceSkills(
    scopedSkills,
    loaded.policy,
    await readGlobalSkills(deps.skills),
    globalPolicy.skills,
  )
  const visibleMcps = withoutClosed(await readMcpRows(deps), globalPolicy.mcps, (row) => row.serverName)
  return {
    ...toGlobalValue(loaded, {
      skills: withGroups(liveSkills.rows),
      mcps: visibleMcps,
    }),
    cwd,
    policyPath: loaded.path,
    exists: loaded.exists,
    live: view.live,
    disabledGlobally: [...globalPolicy.skills, ...globalPolicy.mcps],
    inherited: {
      total: visibleMcps.filter((row) => row.source === 'global').length,
      disabledGlobally: globalPolicy.mcps.length,
    },
  }
}

/**
 * `POST /api/skill-scope/workspace/save`：写入某会话的工作区策略。
 * 与全局保存同形，只是换到 `saveWorkspace(cwd, …)`，并且必须先从会话解析出 cwd。
 *
 * **组装与读取路由共用 `buildWorkspaceView`**（不再各自复制一份口径），
 * 本函数只保留真正属于「保存」的三步：校验入参 → 写盘 → 重新落地 → 回读。
 */
export async function handleWorkspaceSave(body: unknown, deps: RouteDeps): Promise<Envelope<WorkspaceValue>> {
  try {
    const payload = asRecord(body)
    const resolved = await resolveWorkspaceSession(deps, payload)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const validated = validatePolicyInput(payload)
    if (!validated.ok) {
      return { ok: false, error: { code: 'bad-request', message: validated.message } }
    }
    const saved = await deps.store.saveWorkspace(resolved.view.cwd, validated.policy, readRevision(payload))
    if (!saved.ok) return saveFailure(saved)
    // 保存成功后立刻对该会话的存活 Agent 重新落地：策略文件不触发 `skills/change` /
    // `tools/change`，这条显式调用是「同一会话内改策略立即生效」的唯一来源。
    // 放在回读之前无副作用（回读读磁盘），但让「写入 → 落地 → 回读」同处一条 try。
    await deps.reapplyAfterSave()
    return { ok: true, value: await buildWorkspaceView(deps, resolved.view, resolved.sessionId) }
  } catch (error) {
    return internal(error)
  }
}
