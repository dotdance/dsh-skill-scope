/**
 * 工作区层策略（设计 3.2）。
 *
 * **与全局层不同形状**：全局层是「要关掉的名单」（黑名单），工作区层是
 * 「逐项绝对状态」（`名字 → 布尔`）。这个差异是本次改造的核心——
 * 工作区因此可以**打开**全局关着的项，全局退化为默认值而不是硬上限。
 *
 * 三类语义由「键在不在」区分：
 * - 键不存在 ⇒ 跟随全局（随全局变化）
 * - `true`   ⇒ 明令开
 * - `false`  ⇒ 明令关
 *
 * 文件名沿用 `.dsh-scope.json`，新格式写在顶层 `workspace` 键下，
 * 旧格式（`default` 行 + 黑名单数组）只读不写。
 */
import { MAX_NAMES, type LayerPolicy } from './schema.ts'

/** 工作区层的两个域。与全局层同名，便于求值层按域统一处理。 */
export type Domain = 'skills' | 'mcps'

/** 一个域的状态表：`名字 → 是否明令开/关`。键不存在 = 跟随全局。 */
export type StateMap = Record<string, boolean>

/** 工作区策略：两个域各一张状态表。 */
export interface WorkspacePolicy {
  skills: StateMap
  mcps: StateMap
}

/** 空策略：什么都不覆盖，等价于「完全跟随全局」。 */
export const EMPTY_WORKSPACE_POLICY: WorkspacePolicy = { skills: {}, mcps: {} }

/**
 * 工作区文件里装我们这个插件的顶层键。
 *
 * 顶层允许存在其他工具写的未知键（`serializeWorkspacePolicy` 会原样保留），
 * 所以这个键只是本插件的命名空间，不代表整个文件归本插件所有。
 */
const WORKSPACE_KEY = 'workspace'
/** 旧格式的行键。读到它即视为「未迁移的黑名单」。 */
const LEGACY_KEY = 'default'

const sortKeys = (map: StateMap): StateMap => {
  const out: StateMap = {}
  for (const name of Object.keys(map).sort()) out[name] = map[name] as boolean
  return out
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 解析一个域的状态表。
 *
 * **不校验名字形状**：这个表记录的是「用户的决定」，不是「当前清单的投影」。
 * 名字没出现在清单里（技能还没装、或已卸载）时仍要保留——见设计 3.3 边界规则 2。
 * 若在这里按 `SKILL_NAME_RE` 过滤，手写一个不合形状的名字会让整次保存被后续
 * 严格校验拒绝，用户从面板上无路可退。
 *
 * `MAX_NAMES` 上限仍然保留：只为防止文件被写成无界清单，正常用量远低于它。
 */
function parseDomain(raw: unknown, label: string): { map: StateMap; warnings: string[] } {
  const map: StateMap = {}
  const warnings: string[] = []
  if (raw === undefined) return { map, warnings }
  if (!isPlainObject(raw)) {
    warnings.push(`${label} 不是对象，已忽略`)
    return { map, warnings }
  }
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'boolean') {
      // 字段级回退：只有这一项退回「跟随全局」，其余项照常生效。
      warnings.push(`${label}.${name} 的值不是布尔，已忽略`)
      continue
    }
    map[name] = value
  }
  const names = Object.keys(map)
  if (names.length > MAX_NAMES) {
    const kept = names.sort().slice(0, MAX_NAMES)
    const keptSet = new Set(kept)
    for (const name of names) if (!keptSet.has(name)) delete map[name]
    warnings.push(`${label} 超过 ${MAX_NAMES} 项，已只保留前 ${MAX_NAMES} 项`)
  }
  return { map, warnings }
}

/** 旧格式：`default.skills` 是黑名单数组，每一项的含义都是「关」。 */
function parseLegacyDomain(raw: unknown, label: string): { map: StateMap; warnings: string[] } {
  const map: StateMap = {}
  const warnings: string[] = []
  if (raw === undefined) return { map, warnings }
  if (!Array.isArray(raw)) {
    warnings.push(`${label} 不是数组，已忽略`)
    return { map, warnings }
  }
  for (const name of raw) {
    if (typeof name !== 'string') {
      warnings.push(`${label} 里有非字符串元素，已忽略`)
      continue
    }
    map[name] = false
  }
  return { map, warnings }
}

/**
 * 解析工作区策略文件。永不抛错：整体坏掉时返回空策略。
 *
 * 优先级：`workspace` 行存在时**一律以它为准**，`default` 行只作旧格式兜底。
 * 两者并存会记一条 warning（用户能知道自己正在看哪一份），并在下次写盘时清掉旧行。
 */
export function parseWorkspacePolicy(text: string | undefined): {
  policy: WorkspacePolicy
  warning?: string
} {
  if (text === undefined || text.trim() === '') return { policy: EMPTY_WORKSPACE_POLICY }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { policy: EMPTY_WORKSPACE_POLICY, warning: `工作区策略文件不是合法 JSON，已按空策略处理：${String(error)}` }
  }
  if (!isPlainObject(raw)) {
    return { policy: EMPTY_WORKSPACE_POLICY, warning: '工作区策略文件的顶层不是对象，已按空策略处理' }
  }

  const next = raw[WORKSPACE_KEY]
  const legacy = raw[LEGACY_KEY]
  const warnings: string[] = []

  if (next !== undefined) {
    if (legacy !== undefined) {
      warnings.push(`文件同时存在「${WORKSPACE_KEY}」与「${LEGACY_KEY}」，已以「${WORKSPACE_KEY}」为准`)
    }
    if (!isPlainObject(next)) {
      return { policy: EMPTY_WORKSPACE_POLICY, warning: `「${WORKSPACE_KEY}」不是对象，已按空策略处理` }
    }
    const skills = parseDomain(next['skills'], `${WORKSPACE_KEY}.skills`)
    const mcps = parseDomain(next['mcps'], `${WORKSPACE_KEY}.mcps`)
    warnings.push(...skills.warnings, ...mcps.warnings)
    const policy: WorkspacePolicy = { skills: sortKeys(skills.map), mcps: sortKeys(mcps.map) }
    return warnings.length === 0 ? { policy } : { policy, warning: warnings.join('；') }
  }

  if (legacy !== undefined) {
    if (!isPlainObject(legacy)) {
      return { policy: EMPTY_WORKSPACE_POLICY, warning: `「${LEGACY_KEY}」不是对象，已按空策略处理` }
    }
    // 旧格式没有 `workspace` 行，按黑名单语义整体转换。此时**不**按全局过滤：
    // 过滤需要全局状态，而读取必须是纯函数；同向条目统一留到写盘时剔除。
    const skills = parseLegacyDomain(legacy['skills'], `${LEGACY_KEY}.skills`)
    const mcps = parseLegacyDomain(legacy['mcps'], `${LEGACY_KEY}.mcps`)
    warnings.push(...skills.warnings, ...mcps.warnings)
    // `legacy.mode` 刻意不读：旧文件的 mode 只有 default/blacklist 两种历史取值，
    // 而数组的语义在两种取值下都等同于「关」，所以它不携带任何信息。
    const policy: WorkspacePolicy = { skills: sortKeys(skills.map), mcps: sortKeys(mcps.map) }
    return warnings.length === 0 ? { policy } : { policy, warning: warnings.join('；') }
  }

  return { policy: EMPTY_WORKSPACE_POLICY }
}

/** 某一项在工作区层的决定：`undefined` 表示跟随全局。 */
export function localStateOf(policy: WorkspacePolicy, domain: Domain, name: string): boolean | undefined {
  return policy[domain][name]
}

/**
 * 剔除与全局**同向**的条目（设计 3.3 写盘规则）。
 *
 * 同向条目此刻不产生行为差异，但它会在全局将来变化时突然变成一条「用户没做过的
 * 决定」（表现为面板上莫名出现红标）。落盘只保留真实差异，文件内容就恒等于
 * 「与本工程相关的决定」，红标语义也恒等于「与全局不同」。
 */
export function filterAgainstGlobal(policy: WorkspacePolicy, global: LayerPolicy): WorkspacePolicy {
  const denied = {
    skills: new Set(global.skills),
    mcps: new Set(global.mcps),
  } satisfies Record<Domain, Set<string>>
  const pick = (map: StateMap, domain: Domain): StateMap => {
    const out: StateMap = {}
    for (const [name, value] of Object.entries(map)) {
      const globalOpen = !denied[domain].has(name)
      if (value !== globalOpen) out[name] = value
    }
    return out
  }
  return {
    skills: sortKeys(pick(policy.skills, 'skills')),
    mcps: sortKeys(pick(policy.mcps, 'mcps')),
  }
}

/**
 * 序列化工作区策略。
 *
 * 三条硬要求：
 * 1. **先解析 `previousText` 做底**，保住同目录下其他工具写入的未知顶层键；
 * 2. **删掉旧格式的 `default` 行**——它已经被 `workspace` 取代，留着会让每次读取
 *    都报一条「两者并存」的 warning；
 * 3. **键排序 + 固定缩进 + 结尾换行**，保证同一策略的 `sha256(content)` 恒定
 *    （`store.ts` 的 `revision` 靠它做乐观锁）。
 */
export function serializeWorkspacePolicy(
  policy: WorkspacePolicy,
  previousText: string | undefined,
  global: LayerPolicy,
): string {
  const base: Record<string, unknown> = {}
  if (previousText !== undefined && previousText.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(previousText)
      if (isPlainObject(parsed)) Object.assign(base, parsed)
    } catch {
      // 旧文坏了：当作全新文件。不能因为无法解析就不让用户保存。
    }
  }
  delete base[LEGACY_KEY]

  const filtered = filterAgainstGlobal(policy, global)
  const row: Record<string, StateMap> = {}
  // 空域直接省略，避免每个工程都写两行空对象。
  if (Object.keys(filtered.skills).length > 0) row['skills'] = filtered.skills
  if (Object.keys(filtered.mcps).length > 0) row['mcps'] = filtered.mcps

  const out = { ...base, [WORKSPACE_KEY]: row }
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * 严格校验**入站**工作区策略（路由层用，设计 3.4）。
 *
 * 「严格」指的是拒绝坏数据，不是拒绝老写法：这里不接受旧的 `{mode, skills[]}`
 * 形状，因为数组表达不了「明令开」。旧格式只由读侧兼容，写侧一律新格式——
 * 这样磁盘上的文件会随着每一次真实保存自然收敛，不需要单独的迁移步骤。
 *
 * 名字的**形状不校验**（理由同 `parseDomain`）：表里可能躺着当前清单里没有的名字，
 * 客户端保存时会原样送回来；若在这里按正则拒绝，用户会卡在一个改不掉的 400 上。
 * 真正需要保证的是「值是布尔」与「项数有界」。
 */
export function validateWorkspaceInput(
  raw: unknown,
): { ok: true; policy: WorkspacePolicy } | { ok: false; message: string } {
  if (!isPlainObject(raw)) return { ok: false, message: '缺少 workspace 字段，或它不是对象' }
  const extra = Object.keys(raw).filter((key) => key !== 'skills' && key !== 'mcps')
  if (extra.length > 0) return { ok: false, message: `workspace 里有未知字段：${extra.join(', ')}` }

  const readDomain = (key: Domain): { ok: true; map: StateMap } | { ok: false; message: string } => {
    const value = raw[key]
    if (value === undefined) return { ok: true, map: {} }
    if (!isPlainObject(value)) return { ok: false, message: `workspace.${key} 必须是对象` }
    const names = Object.keys(value)
    if (names.length > MAX_NAMES) {
      return { ok: false, message: `workspace.${key} 超过 ${MAX_NAMES} 项（当前 ${names.length} 项）` }
    }
    for (const name of names) {
      if (typeof value[name] !== 'boolean') {
        return { ok: false, message: `workspace.${key}.${name} 必须是 true 或 false` }
      }
    }
    return { ok: true, map: sortKeys(value as StateMap) }
  }

  const skills = readDomain('skills')
  if (!skills.ok) return skills
  const mcps = readDomain('mcps')
  if (!mcps.ok) return mcps
  return { ok: true, policy: { skills: skills.map, mcps: mcps.map } }
}
