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
 */
export interface LayerPolicy {
  mode: PolicyMode
  skills: string[]
  mcps: string[]
}

/**
 * 缺省策略：两份空名单，等价于「本层不收窄」。
 *
 * 写 `blacklist` 而非 `default`：二者在空名单下行为完全相同，但 `blacklist` 是
 * **唯一会被求值器采纳的模式**，用它当缺省可以避免「存进去的 mode 与读回来
 * 归一后的 mode 不一致」这种需要额外解释的状态。
 */
export const EMPTY_POLICY: LayerPolicy = { mode: 'blacklist', skills: [], mcps: [] }

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
    skills: z
      .array(z.string().regex(SKILL_NAME_RE))
      .max(MAX_NAMES)
      .catch([])
      .default([]),
    mcps: z
      .array(z.string().regex(MCP_NAME_RE))
      .max(MAX_NAMES)
      .catch([])
      .default([]),
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
  const policy: LayerPolicy = {
    mode: parsed.data.mode,
    skills: SORTED_UNIQUE(parsed.data.skills),
    mcps: SORTED_UNIQUE(parsed.data.mcps),
  }
  // 逐字段比对，指出被静默回退的最小集合，便于用户定位手写错误的键。
  //
  // `mode` 单独处理：它**不并入 `drifted`**。两条进入 `migratedMode` 的路径都不是
  // 「用户写坏了」：`default` 在枚举内被 `.transform()` 归一，`whitelist` 走
  // `.catch()` 兜底——两者都是**权威口径的迁移**（白名单已废弃，名单语义统一）。
  // 若并入 `drifted`，警告会写成 agnostic 的「已忽略字段：mode」，让用户以为自己的
  // 写法有语法错，而实际上是插件改了语义。
  const drifted: string[] = []
  if (source?.skills !== undefined && !sameSet(source.skills, policy.skills)) drifted.push('skills')
  if (source?.mcps !== undefined && !sameSet(source.mcps, policy.mcps)) drifted.push('mcps')
  const migratedMode = source?.mode !== undefined && source.mode !== policy.mode
  if (drifted.length > 0) {
    const migrated = migratedMode
      ? `；mode 由「${String(source?.mode)}」归一到「${policy.mode}」（白名单已废弃，名单语义统一为黑名单）`
      : ''
    return { policy, warning: `策略中有内容不合法，已忽略字段：${drifted.join(', ')}${migrated}` }
  }
  if (migratedMode) {
    return {
      policy,
      warning: `mode 由「${String(source?.mode)}」归一到「${policy.mode}」（白名单已废弃，名单语义统一为黑名单）`,
    }
  }
  return { policy }
}

function sameSet(raw: unknown, normalized: readonly string[]): boolean {
  if (!Array.isArray(raw)) return false
  const asStrings = raw.filter((item): item is string => typeof item === 'string')
  if (asStrings.length !== raw.length) return false
  return asStrings.length === normalized.length && SORTED_UNIQUE(asStrings).join('\n') === normalized.join('\n')
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

function toRows(policy: LayerPolicy): { mode: PolicyMode; skills: string[]; mcps: string[] } {
  return { mode: policy.mode, skills: SORTED_UNIQUE(policy.skills), mcps: SORTED_UNIQUE(policy.mcps) }
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
 */
const strictPolicySchema = z.object({
  mode: z
    .enum(['blacklist', 'default'])
    .transform((): PolicyMode => 'blacklist'),
  skills: z.array(z.string()).max(MAX_NAMES),
  mcps: z.array(z.string()).max(MAX_NAMES),
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
  const { mode, skills, mcps } = parsed.data
  for (const name of skills) {
    if (!SKILL_NAME_RE.test(name)) return { ok: false, message: `Skill 名不合法：${name}` }
  }
  for (const name of mcps) {
    if (!MCP_NAME_RE.test(name)) return { ok: false, message: `MCP 名不合法：${name}` }
  }
  return { ok: true, policy: { mode, skills: SORTED_UNIQUE(skills), mcps: SORTED_UNIQUE(mcps) } }
}
