import { z } from 'zod'

/**
 * 策略层（设计 3.1）。一个策略由「模式 + 两份名单」组成。
 *
 * **只有 `blacklist` 一种模式**：名单内的名字被关闭。
 * 白名单已删除——它让同一个 `skills` 数组在不同模式下含义相反，是「关闭一项
 * 反而把其他项打开」那类缺陷的温床。
 *
 * `PolicyMode` 之所以仍留 `'default'` 两个字面量：磁盘上存在历史策略文件写着
 * `"mode":"default"`（首装默认值），`dsh --dump-config` 的全局层也可能回传它。
 * 宽松读取会接受这两个取值并归一到 `blacklist`（见 `normalizePolicy`），
 * 于是「名单为空时二者等价」这一点在读取侧就收敛掉了，调用方只需要处理一种语义。
 */
export type PolicyMode = 'default' | 'blacklist'

/**
 * **全局层**的策略（设计 3.2）。
 *
 * 工作区层**不再共用此形状**：它存的是逐项绝对状态（`名字 → 布尔`），
 * 见 `./workspace-schema.ts`。两层形状分家是「工作区可以打开全局关着的项」
 * 这条语义变更的直接结果——黑名单数组表达不了「明令开」。
 *
 * 除两份名单外，全局层还带一个**展示开关** `showOfficialSkills`（见该字段注释）。
 * 它不属于「关掉谁」，但只影响全局层——工作区的展示口径跟随它，所以放在这个
 * 随全局文件落盘的形状里，比新开一个文件少一套 revision/锁语义。
 */
export interface LayerPolicy {
  mode: PolicyMode
  skills: string[]
  mcps: string[]
  /**
   * 面板是否展示官方（`@deepseek-ai`）基础设施 skill。**缺省 `false`（不展示）**。
   *
   * 关（`false`）：官方 skill 不进清单——面板上完全没有这些行，用户也无法开关它们，
   * 但模型仍可自动调用（口径是「不展示」，不是「关闭」）。
   * 开（`true`）：这些行回到清单，按普通行处理——本地面板可以逐项关掉它们，
   * 关掉后由 Agent 作用域的 shadow 真正挡掉模型的自动调用。
   *
   * 它是**单机级展示口径**，不随工作区变化：两个面板读同一份全局策略，因此
   * 「全局面板显示什么」与「工作区面板显示什么」永远同口径。
   */
  showOfficialSkills: boolean
}

/**
 * 缺省策略：两份空名单 + 不展示官方 skill，等价于「本层不收窄」。
 *
 * 写 `blacklist` 而非 `default`：二者在空名单下行为完全相同，但 `blacklist` 是
 * **唯一会被求值器采纳的模式**，用它当缺省可以避免「存进去的 mode 与读回来
 * 归一后的 mode 不一致」这种需要额外解释的状态。
 */
export const EMPTY_POLICY: LayerPolicy = deepFreeze({
  mode: 'blacklist',
  skills: [],
  mcps: [],
  showOfficialSkills: false,
})

/**
 * 冻结缺省策略（含里面的数组）。
 *
 * 它是**被所有调用方共享**的常量：`tests/agent/hooks.spec.ts` 的 `makeHarness` 直接把它
 * 当作 `global`，生产侧也可能把它当缺省层返回。一次原地 `push` 就会让缺省策略永久带上
 * 别人的名字，而且跨用例、跨会话串味（单跑不复现、全量偶发）。冻结后这种写入会直接抛。
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const inner of Object.values(value)) deepFreeze(inner)
  return Object.freeze(value)
}

/** Skill 名形状（与 `dsh-skill` 的命名一致，见设计 3.1）。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/**
 * MCP server 名长度上限。**唯一来源**，`inventory/mcp.ts` 从这里 import。
 *
 * 上限来自 `dsh-tools` 的 `publicToolName` 约束：超长名会被加哈希后缀截断
 * （`dsh-mcp-client/lib/index.js` 的 server 名校验点，见设计 4.3）。
 *
 * 原先 `inventory/mcp.ts` 也写了一份 `SERVER_SEGMENT_MAX = 32`，两处靠注释互相提醒
 * 「必须与另一处一致」。那等于靠人工保证两个数字相等；现在只在这里定义一次，
 * 正则由它生成，`serverNameOf` 的切割也用它，两处不可能再分叉。
 */
export const MCP_SERVER_NAME_MAX = 32
/** MCP server 名形状。由 `MCP_SERVER_NAME_MAX` 生成，长度约束不再手写第二遍。 */
export const MCP_NAME_RE = new RegExp(`^[A-Za-z0-9_-]{1,${MCP_SERVER_NAME_MAX}}$`)
/** 单份名单的元素上限，防止策略文件被写成无界清单。 */
export const MAX_NAMES = 512

const SORTED_UNIQUE = (names: readonly string[]): string[] => [...new Set(names)].sort()

/**
 * 逐元素挑出合法名字，并把被丢弃的元素**原样**带出来（`previewValue` 与去重交给调用方）。
 *
 * **不能退回「正则挂在 zod 数组元素上」的写法**：`z.array(z.string().regex(…)).catch([])`
 * 的 `.catch` 是整数组级别的，一个坏名字让整份名单失效（见 lenientPolicySchema 的注释）。
 * 这里改成逐个判，最坏只丢那一条，且丢弃项可被用户看见。
 *
 * `pattern` 必须**不带 `g` 标志**：`RegExp.prototype.test` 对带 `g` 的正则会推进
 * `lastIndex`，同一个正则复用会漏判隔项（这里用的是模块级共享正则）。
 */
function pickNames(raw: readonly unknown[], pattern: RegExp): { names: string[]; dropped: unknown[] } {
  const names: string[] = []
  const dropped: unknown[] = []
  for (const item of raw) {
    if (typeof item === 'string' && pattern.test(item)) names.push(item)
    else dropped.push(item)
  }
  return { names, dropped }
}

/**
 * 丢弃项去重后再渲染：按**原值**去重（`Set` 对原始值按值、对对象按引用），
 * 先渲染再去重会把 `1` 与 `"1"` 这类不同原值合并成一条，条数与实际不符。
 */
function previewDropped(items: readonly unknown[]): string[] {
  return [...new Set(items)].map(previewValue)
}

/** 被丢弃条目的展示上限：单条超过这个长度就截断（用户输入长度不可控）。 */
const PREVIEW_MAX = 40

/**
 * 把被丢弃的元素写成一短段可读文本。**永不抛错**。
 *
 * `normalizePolicy` 的契约是「永不抛错」，而 `JSON.stringify` 遇到 `BigInt` 与循环引用
 * 会抛 `TypeError`（实测 `{skills:[1n]}` → `TypeError: Do not know how to serialize a BigInt`），
 * 所以这里必须兜住；字符串走 `JSON.stringify` 是为了让空串与前导空格在日志里可见
 * （`""` / `" good"` 一眼可辨）。
 */
function previewValue(item: unknown): string {
  // `JSON.stringify(NaN)` / `JSON.stringify(Infinity)` 都是 `"null"`，两个不同的坏值
  // 会渲染成同一条 `null`，日志里分不清用户写了什么。数字非有限值直接按字面量写。
  if (typeof item === 'number' && !Number.isFinite(item)) return String(item)
  let text: string
  if (typeof item === 'string') {
    // 先按码点截断**原串**再 stringify：转义符与代理对都在合法边界上产生，
    // 反序（先 stringify 再切）会把 `\uD83D\uDE00` 切成孤立代理，日志里是乱码。
    text = JSON.stringify(clamp(item))
  } else {
    try {
      text = JSON.stringify(item) ?? `[${typeof item}]`
    } catch {
      text = `[${typeof item}]`
    }
  }
  return clamp(text)
}

/** 按**码点**（不是 UTF-16 码元）截断，超长加省略号。 */
function clamp(text: string): string {
  if (text.length <= PREVIEW_MAX) return text
  return `${Array.from(text).slice(0, PREVIEW_MAX).join('')}…`
}

/**
 * 该字段是否**整份**被 zod 丢掉——与「只丢了几个元素」区分开。
 *
 * 只剩「非数组（类型写错）」一种：数量超限**不再**由 zod 判（见 reconstruct 后的注释），
 * 因为超限必须在元素过滤之后、按**过滤后的有效名字数**判，否则
 * 「512 条合法 + 1 条 junk」会先因 513 条超限被整份 `.catch()` 掉。
 */
function listVoided(raw: unknown): boolean {
  return raw !== undefined && !Array.isArray(raw)
}

/**
 * 宽松的读取 schema：任何一项不合法都退回该层的缺省，由调用方补一条 warning。
 * `mode` 可选（缺失时取调用方给的层缺省）；名单元素必须过正则、数量不得超限。
 *
 * `mode` 的枚举**列出两个历史取值**，随后由 `.transform()` 归一到 `blacklist`：
 * - 枚举里必须收 `default`，否则本插件早期版本写下的文件（`"mode":"default"`）会被
 *   `.catch()` 当成「存在但不合法」而走 warning 分支。这两类情况不一样：
 *   `default` 是**已知的历史取值**，迁移是权威口径的变化，不是用户写错。
 * - `whitelist` 刻意**不在枚举里**：它确实是被废弃的写法，走 `.catch()` 并被
 *   `normalizePolicy` 记一条迁移 warning，让用户知道语义变了。
 */
const lenientPolicySchema = (fallbackMode: PolicyMode) =>
  z.object({
    // `.catch()` 兜「存在但不合法」；`.default()` 兜「整个键缺失」。
    mode: z
      .enum(['blacklist', 'default'])
      .transform((): PolicyMode => 'blacklist')
      .catch((): PolicyMode => fallbackMode)
      .default((): PolicyMode => fallbackMode),
    /*
     * 名单**不在这里按元素校验**：`.catch()` 挂在**数组**上，任一元素不过正则就让整份
     * 名单变 `[]`（实测 `{"skills":["good-one","Bad Name"]}` → `skills: []`），一个写错的
     * 名字把 512 条有效关闭项一起失效，而面板与日志都看不到。改为收 `unknown[]`，
     * 由 `normalizePolicy` 逐元素过滤并点名被丢掉的元素（见 `pickNames`）。
     *
     * 数量上限 `.max(MAX_NAMES)` **也移走**了，理由同一条缺陷的边界形态：
     * `.max` 在过滤**之前**跑，「512 条合法 + 1 条 junk = 513 条」会先被判超限、
     * 由整份 `.catch()` 清空，512 条有效关闭项照样失效（实测 `skills.length === 0`）。
     * 现在数量在 `normalizePolicy` 里按**过滤后的有效名字**判，junk 不再占额度。
     */
    skills: z.array(z.unknown()).catch([]).default([]),
    mcps: z.array(z.unknown()).catch([]).default([]),
    // 展示开关与两份名单同一口径：坏值 / 缺键都退回缺省 `false`（不展示），
    // 由 `normalizePolicy` 记 warning 指出被回退的那个键。
    showOfficialSkills: z.boolean().catch(false).default(false),
  })

/**
 * 宽松解析任意输入为 `LayerPolicy`（设计 3.3）。永不抛错：整体坏掉时返回 `EMPTY_POLICY`。
 * 任一字段被回退都带一条 `warning`，让调用方可以记录但不阻塞加载。
 */
export function normalizePolicy(
  raw: unknown,
  fallbackMode: PolicyMode,
): { policy: LayerPolicy; warning?: string } {
  const parsed = lenientPolicySchema(fallbackMode).safeParse(raw ?? {})
  if (!parsed.success) {
    return { policy: EMPTY_POLICY, warning: `策略内容不合法，已回退为空策略：${parsed.error.message}` }
  }
  const source = raw as Record<string, unknown> | null | undefined
  const skillsScan = pickNames(parsed.data.skills, SKILL_NAME_RE)
  const mcpsScan = pickNames(parsed.data.mcps, MCP_NAME_RE)
  const droppedSkills = previewDropped(skillsScan.dropped)
  const droppedMcps = previewDropped(mcpsScan.dropped)
  // 上限按**去重后的有效名字数**判（重复项不占额度），超出则整份忽略：
  // 静默截断会让用户以为「第 513 条之后的名也关着」。
  const skills = SORTED_UNIQUE(skillsScan.names)
  const mcps = SORTED_UNIQUE(mcpsScan.names)
  const skillsOverflow = skills.length > MAX_NAMES
  const mcpsOverflow = mcps.length > MAX_NAMES
  const policy: LayerPolicy = {
    mode: parsed.data.mode,
    skills: skillsOverflow ? [] : skills,
    mcps: mcpsOverflow ? [] : mcps,
    showOfficialSkills: parsed.data.showOfficialSkills,
  }
  // 逐字段比对，只指出**整份被回退**的字段，便于用户定位手写错误的键。
  //
  // 名单字段**不按 `sameSet` 判漂移**：`sameSet` 在「有元素被丢弃」与「只有重复项」
  // 两种情况下都返回 `false`，若据此写成「已忽略字段：skills」，而实际只丢了几个名字
  // （或什么都没丢），用户会以为整份名单失效而去重写策略。整份失效只有两种情形，
  // 由 `listVoided` 判定；元素级丢弃单独措辞。
  //
  // `mode` 单独处理：它**不并入 `drifted`**。两条进入 `migratedMode` 的路径都不是
  // 「用户写坏了」：`default` 在枚举内被 `.transform()` 归一，`whitelist` 走
  // `.catch()` 兜底——两者都是**权威口径的迁移**（白名单已废弃，名单语义统一）。
  // 若并入 `drifted`，警告会写成 agnostic 的「已忽略字段：mode」，让用户以为自己的
  // 写法有语法错，而实际上是插件改了语义。
  const drifted: string[] = []
  if (listVoided(source?.skills)) drifted.push('skills')
  if (listVoided(source?.mcps)) drifted.push('mcps')
  // 展示开关只有「是 / 不是布尔」两种坏法；后者会被 `.catch()` 静默退回 `false`，
  // 必须点名，否则用户看到「官方 skill 又不见了」却找不到原因。
  if (source?.showOfficialSkills !== undefined && source.showOfficialSkills !== policy.showOfficialSkills) {
    drifted.push('showOfficialSkills')
  }
  const migratedMode = source?.mode !== undefined && source.mode !== policy.mode
  // 被逐个丢弃的名字必须点名：否则「少关了一条 skill」在面板上完全看不出来。
  // 按域分开、去重、单条截断：混成一句时用户不知道哪条属于哪份名单。
  const dropSegment = (label: string, names: readonly string[]): string =>
    names.length === 0
      ? ''
      : `${label}：${names.slice(0, 5).join(', ')}${names.length > 5 ? ` 等 ${names.length} 项` : ''}`
  const droppedTotal = droppedSkills.length + droppedMcps.length
  const dropParts = [dropSegment('不合法 skill', droppedSkills), dropSegment('不合法 mcp', droppedMcps)].filter(
    (part) => part !== '',
  )
  const droppedText = dropParts.length === 0 ? '' : `（${dropParts.join('；')}）`
  // 整份失效（字段类型写错）与元素级丢弃必须**并列成两句**，不能嵌套在同一对括号里：
  // `已忽略字段：mcps（不合法 skill："Bad Name"）` 读起来像「mcps 里有这个 skill」。
  const clauses: string[] = []
  if (drifted.length > 0) clauses.push(`已忽略字段：${drifted.join(', ')}`)
  if (droppedTotal > 0) clauses.push('已丢弃不合法的名字')
  if (skillsOverflow) clauses.push(`skills 有效名字 ${skills.length} 条超过上限 ${MAX_NAMES}，已整份忽略`)
  if (mcpsOverflow) clauses.push(`mcps 有效名字 ${mcps.length} 条超过上限 ${MAX_NAMES}，已整份忽略`)
  if (clauses.length > 0) {
    const migrated = migratedMode
      ? `；mode 由「${String(source?.mode)}」归一到「${policy.mode}」（白名单已废弃，名单语义统一为黑名单）`
      : ''
    return { policy, warning: `策略中有内容不合法，${clauses.join('；')}${droppedText}${migrated}` }
  }
  if (migratedMode) {
    return {
      policy,
      warning: `mode 由「${String(source?.mode)}」归一到「${policy.mode}」（白名单已废弃，名单语义统一为黑名单）`,
    }
  }
  return { policy }
}

/**
 * `JSON.parse` 一次，失败时折叠成 `{ ok: false, warning }`。
 *
 * 两个 `parse*Policy` 原先各写一份同样的 try/catch，只有文案里的「全局 / 工作区」不同；
 * 收敛到这里后，两条读取路径的**失败语义**（当空策略 + warning，绝不抛错）只有一处实现。
 */
function parseJson(text: string, label: string): { ok: true; raw: unknown } | { ok: false; warning: string } {
  try {
    return { ok: true, raw: JSON.parse(text) }
  } catch (error) {
    return { ok: false, warning: `${label}不是合法 JSON，已按空策略处理：${String(error)}` }
  }
}

/** 全局策略文件是**裸策略对象**（无外层包装），见设计 3.3。 */
export function parseGlobalPolicy(text: string | undefined): { policy: LayerPolicy; warning?: string } {
  if (text === undefined || text.trim() === '') return { policy: EMPTY_POLICY }
  const parsed = parseJson(text, '全局策略文件')
  if (!parsed.ok) return { policy: EMPTY_POLICY, warning: parsed.warning }
  return normalizePolicy(parsed.raw, 'blacklist')
}

/** 序列化全局策略：裸对象 + 稳定键序，保证 `sha256(content)` 对同一策略恒定。 */
export function serializeGlobalPolicy(policy: LayerPolicy): string {
  return `${JSON.stringify(toRows(policy), null, 2)}\n`
}

// 工作区层的解析与序列化**不在这里**：它的文件形状与全局层不同
// （逐项绝对状态，不是黑名单），见 `./workspace-schema.ts`。

function toRows(policy: LayerPolicy): {
  mode: PolicyMode
  skills: string[]
  mcps: string[]
  showOfficialSkills: boolean
} {
  return {
    mode: policy.mode,
    skills: SORTED_UNIQUE(policy.skills),
    mcps: SORTED_UNIQUE(policy.mcps),
    showOfficialSkills: policy.showOfficialSkills,
  }
}

/**
 * 严格 schema：用于**入站请求**（设计 3.4）。任何一处不合法都拒绝，不静默回退。
 *
 * `mode` 这里**收两个历史取值并归一到 `blacklist`**，与宽松读取 schema 同一口径：
 * 「严格」指的是**拒绝坏数据**，不是「拒绝老写法」。`default` 在写入侧不是坏数据——
 * 它曾是首装默认值，外部脚本或旧版面板仍可能送它；归一后落盘统一为 `blacklist`，
 * 于是磁盘上不再新增 `default` 这种一文两义的模式。真正的非法值（如 `whitelist`
 * 或任意字符串）仍然被拒，`message` 会指出期望值。
 *
 * 名单元素的**形状**不在这里校验，由 `validatePolicyInput` 逐个过正则，
 * 这样 `message` 才能点名第一个不合法的名字。
 *
 * `showOfficialSkills` **可选**：缺键按 `false`（保持旧行为）。旧版面板/脚本只送
 * 两份名单时不会因此被 400 拒绝——代价是那次保存会把展示开关重置成「不展示」，
 * 这是可自愈的展示状态，比拒绝一次策略写入轻。
 */
const strictPolicySchema = z.object({
  mode: z
    .enum(['blacklist', 'default'])
    .transform((): PolicyMode => 'blacklist'),
  skills: z.array(z.string()).max(MAX_NAMES),
  mcps: z.array(z.string()).max(MAX_NAMES),
  showOfficialSkills: z.boolean().optional().default(false),
})

/**
 * 严格校验入站策略（路由层用）。失败时 `message` 里带上**第一个非法名字**，
 * 便于用户一眼看出是哪个开关的数据坏了。
 */
export function validatePolicyInput(raw: unknown): { ok: true; policy: LayerPolicy } | { ok: false; message: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: '策略体必须是对象' }
  }
  const parsed = strictPolicySchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, message: `策略体不合法：${parsed.error.issues[0]?.message ?? parsed.error.message}` }
  }
  const { mode, skills, mcps, showOfficialSkills } = parsed.data
  for (const name of skills) {
    if (!SKILL_NAME_RE.test(name)) return { ok: false, message: `Skill 名不合法：${name}` }
  }
  for (const name of mcps) {
    if (!MCP_NAME_RE.test(name)) return { ok: false, message: `MCP 名不合法：${name}` }
  }
  return {
    ok: true,
    policy: { mode, skills: SORTED_UNIQUE(skills), mcps: SORTED_UNIQUE(mcps), showOfficialSkills },
  }
}
