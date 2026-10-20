import type { LayerPolicy } from '../policy/schema.ts'
import { validatePolicyInput } from '../policy/schema.ts'
import type { WorkspacePolicy } from '../policy/workspace-schema.ts'
import { validateWorkspaceInput } from '../policy/workspace-schema.ts'
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
 * 工作区面板返回体。
 *
 * **不再沿用 `GlobalValue` 的形状**：三态语义下，这个面板要同时回答三个问题——
 * 「全局怎么算的」「本工程怎么算的」「两项是否不同」。所以它带**两份策略**：
 *
 * - `global`：全局层（黑名单）。只读用途——客户端据此判断「这一项是否与全局不同」。
 * - `workspace`：本工程的决定（`名字 → 布尔`）。键不存在 = 跟随全局。
 *
 * 最终状态由客户端按 `workspace[name] ?? !global.includes(name)` 算出，
 * 与服务端 `openResolver` 同一公式（见 `src/policy/evaluate.ts`）。
 *
 * `revision` 是**工作区文件**的 revision（保存时的期望值），不是全局的。
 *
 * 旧字段 `disabledGlobally` / `inherited` 已删除：它们唯一的用途是把全局关闭项
 * 从清单里摘掉，而三态方案下**没有任何项会被摘掉**——全局关掉的东西必须留在
 * 面板上，否则用户没有入口把它打开。
 */
export type WorkspaceValue = {
  /** 全局层策略（黑名单），供客户端判断「与全局不同」。 */
  global: LayerPolicy
  /** 本工程的决定：键不存在表示跟随全局。 */
  workspace: WorkspacePolicy
  /** 工作区策略文件的 `sha256`；`null` 表示文件不存在。 */
  revision: string | null
  cwd: string
  policyPath: string
  exists: boolean
  live: boolean
  inventory: { skills: GroupedSkillRow[]; mcps: McpRow[] }
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
 * **清单是全量并集，不再按全局状态摘除任何行**（三态方案的直接结果）：
 * 全局从「硬上限」退化为「默认值」，被全局关掉的项必须仍然列在这里，
 * 否则用户就没有入口把它在工作区打开。
 *
 * 这与旧实现相反。旧实现有三条组装规则（全局未关闭 / Agent 可见 / 本工作区已关闭
 * 但全局未关闭），起点是「全局未关闭」，全局关掉的整条摘除。那套规则在
 * 「工作区只能收窄」的年代是自洽的，但换成三态后每一条都会把可选项删掉。
 *
 * `modelInvocable === false` 的项仍然不过滤：这类 skill 的 frontmatter 写了
 * `disable-model-invocation: true`（「只给用户手动调用」），面板照样列出，
 * 靠行内标注区分。理由是**授权**与「AI 能否调用」是两件事。
 *
 * **组装工作全部委托给 `buildWorkspaceView`**：本函数只负责解析会话与拒绝未知会话。
 * 保存路由共用同一个函数，因此两条路由的清单口径不存在分叉的可能。
 */
export async function handleWorkspace(body: unknown, deps: RouteDeps): Promise<Envelope<WorkspaceValue>> {
  try {
    const resolved = await resolveWorkspaceSession(deps, asRecord(body))
    if (!resolved.ok) return { ok: false, error: resolved.error }
    return { ok: true, value: await buildWorkspaceView(deps, resolved.view) }
  } catch (error) {
    return internal(error)
  }
}

/**
 * 工作区面板的 Skill 清单：**全局清单 ∪ 会话可见清单**。
 *
 * 这是一个真实缺陷的修复，不是重构顺带的整理。
 *
 * 旧实现以 `readGlobalSkills` 为起点。它读的是**全局注册表**，而 `browser-skill`
 * 这类能力是 Agent 启动时**自注册**的——它不在全局注册表里，只出现在会话作用域的
 * 清单中。于是它从一开始就不在面板上：用户想为某个工程单独打开它，找不到入口。
 * 旧实现之所以没暴露这个问题，是因为当年工作区**只能收窄**，面板上「看不到」与
 * 「不能开」是一回事；三态下「能不能开」成了用户要回答的问题，缺行就是缺功能。
 *
 * 所以清单必须取并集：
 * - `readGlobalSkills`：全局注册表全量行（提供描述、来源、分组等行数据）；
 * - `readAgentSkills`：会话作用域的活清单（补上自注册项）。
 *
 * 去重按 `name`，同名时**以全局行为准**（来源信息更完整），会话侧只补缺。
 * `complete` 取两者之**与**：两份清单都完整，并集才完整；任一残缺时 UI 按既有
 * 契约拒绝收窄写入。
 */
async function readWorkspaceSkills(
  deps: RouteDeps,
  view: SessionView,
  cwd: string,
): Promise<SkillInventory> {
  const global = await readGlobalSkills(deps.skills)
  if (view.agent === null) return global
  const scoped = await readAgentSkills(deps.skills, view.agent, cwd)
  const present = new Set(global.rows.map((row) => row.name))
  const extra = scoped.rows.filter((row) => !present.has(row.name))
  return { rows: [...global.rows, ...extra], complete: global.complete && scoped.complete }
}

/**
 * **工作区视图的唯一组装口径**（读取路由与保存路由共用，调用方不许各自再拼一遍）。
 *
 * 抽出来的理由不只是「少写几行」：这段逻辑原先在两条路由里**逐段复制了两份**，
 * 而它的正确性依赖「两条路由的组装口径完全一致」。两份副本已经造成过一次用户可见的
 * 缺陷，所以这里收敛成一处：只要这个函数是对的，两条路由就都是对的。
 *
 * 顺序要求（**步骤顺序是逻辑，不是风格**）：
 * 1. 先读工作区策略与作用域清单——后者的作用域**必须传会话解析出的 agent 本体**，
 *    替换对象会让 `dsh-scope` 按身份查不到层、静默退化成全局层。
 * 2. 再读全局策略与全局清单。它们不再用来「摘除」任何行，只提供两件事：
 *    ①三态里「跟随全局」的取值来源（`global` 字段）②清单并集的基底。
 * 3. 组装 skill 清单与 MCP 清单——**两者都不排除任何项**。
 *
 * 调用方（保存路由）必须在调用本函数**之前**完成写盘与 `reapplyAfterSave`：
 * 本函数只读，不负责落地。
 */
async function buildWorkspaceView(deps: RouteDeps, view: SessionView): Promise<WorkspaceValue> {
  const cwd = view.cwd
  const loaded = await deps.store.loadWorkspace(cwd)
  // 读取期的 warning（旧格式并存、字段被回退）不当错误：记一条日志，面板照常打开。
  if (loaded.warning !== undefined) deps.logger.warn(`dsh-skill-scope: ${loaded.warning}（${loaded.path}）`)
  const global = await deps.store.loadGlobal()
  const skills = await readWorkspaceSkills(deps, view, cwd)
  return {
    global: global.policy,
    workspace: loaded.policy,
    revision: loaded.revision,
    cwd,
    policyPath: loaded.path,
    exists: loaded.exists,
    live: view.live,
    inventory: {
      skills: withGroups(skills.rows),
      mcps: await readMcpRows(deps),
    },
  }
}

/**
 * `POST /api/skill-scope/workspace/save`：写入某会话的工作区策略。
 * 与全局保存同形，只是换到 `saveWorkspace(cwd, …)`，并且必须先从会话解析出 cwd。
 *
 * 入参是 `payload.workspace`（`{ skills: {名字: 布尔}, mcps: {...} }`），
 * 不是全局那套 `{ mode, skills[], mcps[] }`——两层形状已分家，混用会在校验处被拒。
 *
 * **组装与读取路由共用 `buildWorkspaceView`**，本函数只保留属于「保存」的三步：
 * 校验入参 → 写盘 → 重新落地 → 回读。
 */
export async function handleWorkspaceSave(body: unknown, deps: RouteDeps): Promise<Envelope<WorkspaceValue>> {
  try {
    const payload = asRecord(body)
    const resolved = await resolveWorkspaceSession(deps, payload)
    if (!resolved.ok) return { ok: false, error: resolved.error }
    const validated = validateWorkspaceInput(payload?.['workspace'])
    if (!validated.ok) {
      return { ok: false, error: { code: 'bad-request', message: validated.message } }
    }
    const saved = await deps.store.saveWorkspace(resolved.view.cwd, validated.policy, readRevision(payload))
    if (!saved.ok) return saveFailure(saved)
    // 保存成功后立刻对该会话的存活 Agent 重新落地：策略文件不触发 `skills/change` /
    // `tools/change`，这条显式调用是「同一会话内改策略立即生效」的唯一来源。
    // 放在回读之前无副作用（回读读磁盘），但让「写入 → 落地 → 回读」同处一条 try。
    await deps.reapplyAfterSave()
    return { ok: true, value: await buildWorkspaceView(deps, resolved.view) }
  } catch (error) {
    return internal(error)
  }
}
