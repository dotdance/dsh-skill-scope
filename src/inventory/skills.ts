/**
 * Skill 清单读取（设计 4.3）。本模块只做两件事：
 * - 用**正确的 `snapshot` 实参**分别读全局层与工作区层；
 * - 把 `dsh-skill` 的可选字段收敛成稳定形状，供 UI 与策略求值共用。
 *
 * 它刻意不判定可见性：策略求值在 `policy/evaluate.ts`，这里只提供「有哪些」。
 * **唯一例外**是官方基础设施 skill 的「不展示」过滤（见 `./official.ts`），
 * 因为它必须与「有哪些」同口径，放到调用点会造成全局/工作区两份清单分叉。
 */

import { isOfficialSkillPath } from './official.ts'

/** 面板/求值共用的一行 skill。字段全部必有，缺省由本模块补，调用方不必再兜。 */
export interface SkillRow {
  name: string
  description: string
  source: string
  /**
   * 拥有这个 skill 正体的 **provider 名**（`dsh-skill` 的 `SkillSummary.provider`，
   * 见宿主 `@deepseek-ai/dsh-skill/lib/types/index.d.ts:57-58`）。
   *
   * **它是「这个 skill 是否来自某个插件」的唯一权威信号。** `source` 做不到这件事：
   * 它只标「哪一个内置根目录」，且**由 provider 自己填的字符串**、落在
   * `SkillSource` 的 `(string & {})` 兜底分支里，值本身不含插件身份。
   * 实测 141 条的 `(provider, source)` 组合只有 4 种：
   * - `filesystem` 拥有 122 条，`source` 分别为 `custom` 88 / `user-agents` 34；
   * - `superpowers-dsh` 拥有 15 条（包在 `node_modules` 里的插件，`source` 自报 `custom`）；
   * - `runtime` 拥有 4 条（`source` 为 `runtime` 3 / `bundled` 1），无 `path`。
   *
   * 缺省 `'unknown'`：provider 字段缺失代表「没能判定」，不能当作 `filesystem`。
   */
  provider: string
  modelInvocable: boolean
  /**
   * 技能目录的绝对路径；`dsh-skill` 的 `toSummary` 只在存在时透出。
   *
   * **它是磁盘 skill 的「文件夹」信号**：`path` 的粒度是技能目录本身
   * （`.../skills/agent-browser`），要拿分组/来源标签得先向上归一到注册根。
   * runtime 注入的 skill 没有路径，此时为 `undefined`。
   */
  path?: string
}

/**
 * 一份 skill 清单。
 * `complete: false` 表示服务没能枚举完整（例如某个 provider 报错）。
 * **它绝不能与「没有 skill」混同**：调用方必须据此拒绝执行收窄写入，
 * 否则会用一个残缺清单去覆盖策略，静默关掉用户没打算关的条目。
 */
export interface SkillInventory {
  rows: SkillRow[]
  complete: boolean
}

/** `dsh-skill` 服务的最小面（只声明本模块用到的 `snapshot`，便于注入替身）。 */
export interface SkillsServiceLike {
  snapshot(options: { cwd?: string; scope?: unknown }): Promise<{
    skills: Array<{
      name: string
      description?: string
      source?: string
      provider?: string
      path?: string
      invocation?: { modelInvocable?: boolean }
    }>
    complete: boolean
  }>
}

/**
 * 读全局层：`snapshot({})`——**空对象，不带 `cwd`、不带 `scope`**。
 * 带上 `cwd` 会让 `dsh-skill` 追加工作区的 skill provider，全局清单就被污染了。
 */
export async function readGlobalSkills(skills: SkillsServiceLike): Promise<SkillInventory> {
  const result = await skills.snapshot({})
  return { rows: toRows(result.skills), complete: result.complete }
}

/**
 * 读工作区层：`snapshot({ cwd, scope: agent })`。
 *
 * `scope` 必须显式传入**活的 agent 对象本体**：`dsh-skill` 只读取 `options.scope`，
 * 省略它不会报错，而是静默退化成只读全局层——那样工作区清单会缺掉 agent 自己的 skill，
 * UI 会显示成「这个 agent 没有 skill」，比抛错更难发现。
 *
 * **`scope` 为什么收 agent 本体（而不是 `agent.ctx`）**：宿主
 * `@deepseek-ai/dsh-agent-loop/lib/index.js:778` 用 `createScope(loopCtx, this)`
 * 建作用域，第二个实参（scope key）**就是 agent 对象自己**；而
 * `@deepseek-ai/dsh-scope/lib/index.js:296-300` 把它写成 `fiber.ctx.extend({ [kScope]: key })`。
 * `dsh-skill` 的 `chainLayers(options.scope)`（`dsh-skill/lib/index.js:299`）走
 * `scopeChainOf(scope)` → `scopeParents.get(scope)`，这张表正是以 **scope key**
 * 为键的 WeakMap。所以传 agent 本体是对的，传 `agent.ctx` 反而取不到链。
 *
 * **`scope` 只做「覆盖」，不做「削减」**（`dsh-skill/lib/index.js:299`：
 * `const layers = [this.layers.global, ...this.layers.chainLayers(options.scope)]`）：
 * 全局层**永远最先并入**，agent 层只能按名字覆盖它。因此当某 agent 没有自己的
 * skill 层时，工作区清单会与全局清单**逐条相同**——这是宿主的设计，不是本插件的缺陷。
 * （实测：同一会话走本函数与走 `snapshot({})` 都得到 141 条且名单完全一致。）
 */
export async function readAgentSkills(
  skills: SkillsServiceLike,
  agent: unknown,
  cwd: string,
): Promise<SkillInventory> {
  const result = await skills.snapshot({ cwd, scope: agent })
  return { rows: toRows(result.skills), complete: result.complete }
}

/**
 * 把宿主返回的 raw skill 收敛成 `SkillRow`，并**滤掉官方 `@deepseek-ai` skill**。
 *
 * 两个读函数都走这一行，所以全局层与工作区层**口径必然一致**——不会出现
 * 「全局视图藏了、工作区视图还在」这类分歧。判定与取舍见 `./official.ts`。
 *
 * 注意过滤**只影响清单读取**：`src/agent/hooks.ts` 的遮蔽集合是从清单反推的
 * （`清单 − 允许集`），被滤掉的名字不在清单里 ⇒ **模型仍可调用它们**，
 * 口径是「只隐藏不控制」。
 */
function toRows(raw: ReadonlyArray<Parameters<typeof toRow>[0]>): SkillRow[] {
  return raw.filter((entry) => !isOfficialSkillPath(entry.path)).map(toRow)
}

/** 可选字段收敛：`description` → `''`，`source`/`provider` → `'unknown'`，`modelInvocable` 缺省 `true`。 */
function toRow(raw: {
  name: string
  description?: string
  source?: string
  provider?: string
  path?: string
  invocation?: { modelInvocable?: boolean }
}): SkillRow {
  return {
    name: raw.name,
    description: raw.description ?? '',
    source: raw.source ?? 'unknown',
    // 与 `source` 同样按「缺失即 unknown」收敛：缺 provider 不能被当成 `filesystem`，
    // 否则会把一个判定失败的 skill 冒充成「普通磁盘 skill」而给出误导性的来源标签。
    provider: raw.provider ?? 'unknown',
    // 缺省 true：`dsh-skill` 里可被模型调用的 skill 是常态，字段缺失代表「未特别声明」。
    modelInvocable: raw.invocation?.modelInvocable ?? true,
    // 只在存在时带上：runtime 注入的 skill 没有路径，补 `''` 会让「无路径」与
    // 「路径为空字符串」两种不同事实混成一个，分组时无法区分。
    ...(raw.path === undefined ? {} : { path: raw.path }),
  }
}

/**
 * 一个 skill 的**真实来源**（给用户看的来源标签）。取代原先直接显示 `source` 的做法。
 *
 * 用户的原始诉求：`source` 显示 `custom` 对用户毫无信息量，**来源应当写明是哪个插件、
 * 或者磁盘上的哪个路径**。返回三态，按序判定：
 *
 * 1. **插件**：`provider` 不是文件系统/运行时这两个内置 provider 时，写 **provider 名**。
 *    这是唯一权威的「插件身份」信号——`superpowers-dsh` 这个 provider 由同名的
 *    npm 包注册（`superpowers-dsh/lib/index.js:108-109` 自报
 *    `provider: 'superpowers-dsh'`），而它**故意把 `source` 填成 `'custom'`**
 *    （同文件 `const SOURCE = 'custom'`），所以只看 `source` 根本分不出插件。
 *
 * 2. **磁盘路径**：provider 是 `filesystem` 时，写 skill 所在**注册根目录的绝对路径**
 *    （`/Users/go/node_modules/gbrain/skills`），而不是每个 skill 各自的目录。
 *    用注册根是因为一个根下的几十个 skill 应当显示同一个来源，逐条写各自的
 *    `.../skills/academic-verify` 会让「来源」变成「路径列表」，反而看不出出处。
 *
 * 3. **内置/运行时**：`provider === 'runtime'` 的 skill 由注册表直接注入，没有磁盘出处，
 *    返回 `null` 让调用方去取本地化文案（不能在这里写死中文，本模块不持有 locale）。
 *
 * **为什么不用 `source` 判定插件**：它是 provider 可自定的 `SkillSource` 字符串
 * （类型定义见 `@deepseek-ai/dsh-skill/lib/types/index.d.ts:24`，末段是 `(string & {})`），
 * 插件可以（也确实）随便填。`provider` 则是注册表的强制约束：宿主校验
 * `candidate.provider === providerName`（`dsh-skill/lib/index.js:461`），无法伪造。
 */
export function sourceLabelOf(row: SkillRow): string | null {
  if (row.provider === 'runtime') return null
  if (row.provider !== 'filesystem' && row.provider !== 'unknown') return row.provider
  // filesystem / unknown 都退回磁盘路径：unknown 时至少还能给出 path，比显示 unknown 有用。
  if (row.path !== undefined) return groupKeyOf(row)
  return null
}

/**
 * 「无路径」分组的 key。runtime 注入的 skill 没有 `path`（实测 141 条里 4 条）。
 *
 * 用**不可能出现在真实路径里**的字符串（含 NUL）而不是 `''`：真实路径非空，
 * 用 `''` 会在将来某天「路径恰好为空」时静默并组。
 */
export const UNGROUPED_KEY = '\u0000ungrouped'

/**
 * 从一个 skill 路径算出它的**注册根目录**（分组 key）。
 *
 * **规则：向上找最近的名为 `skills` 的目录。**
 *
 * 为什么不能直接按 `path` 分组：`path` 的粒度是**技能目录本身**
 * （如 `.../skills/agent-browser`），实测 141 条会散成 138 组、每组 1 个 —— 分组毫无意义。
 * 上卷到 `skills/` 这一层才得到用户要的「同一文件夹下的 skills 放在一组」。
 *
 * 兜底返回上一级目录：当路径里**没有** `skills` 这一级时（provider 自定义了别的目录名），
 * 至少还归到技能目录的父目录，不会退化成「每个技能一组」。
 */
export function groupKeyOf(row: SkillRow): string {
  if (row.path === undefined) return UNGROUPED_KEY
  const parts = row.path.split('/')
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === 'skills') return parts.slice(0, i + 1).join('/')
  }
  return parts.slice(0, -1).join('/')
}

/**
 * 一个分组 key 的**显示名**。
 *
 * 两条规则，按序判定：
 * 1. **插件**：路径形如 `<...>/node_modules/<包名>/skills` 时取 `<包名>`
 *    （实测命中 `superpowers-dsh`、`gbrain`）。插件名比一长串绝对路径可读得多，
 *    也正是用户举例的「插件 a、插件 b」。
 * 2. **文件夹**：取注册根的 basename；**当 basename 就是 `skills` 时再退一级**
 *    取父目录名（`.agents/skills` → `.agents`，`sand/skills` → `sand`）。
 *
 * 规则 2 的后半句是**必需的，不是美化**：实测 6 组里有 3 组（`.agents/skills`、
 * `sand/skills`、`LocalAgent/skills`）的 basename 都是 `skills`，不退这一级就会得到
 * 三个一模一样的组名，用户完全无法区分——与「按来源分组」的目标直接相反。
 *
 * 与 host 上的 `dsh` 版本、profile 名、用户名**无关**：提取的是 `node_modules` 后的
 * 包名或注册根的目录名，不是绝对路径前缀。
 */
export function groupLabelOf(key: string): string {
  if (key === UNGROUPED_KEY) return ''
  const parts = key.split('/')
  // `node_modules/<包名>/skills` → 取第 3 段。
  const nodeModulesAt = parts.lastIndexOf('node_modules')
  if (nodeModulesAt >= 0 && nodeModulesAt + 1 < parts.length) {
    const pkg = parts[nodeModulesAt + 1]
    // scoped 包（`@scope/name`）在此形态下不会作为 `skills` 的直接父级出现，故只取一段；
    // 实测覆盖当前全部分组。`skills` 本身要排除，否则 `node_modules/skills/` 会自命名。
    if (pkg !== undefined && pkg !== '' && pkg !== 'skills') return pkg
  }
  const last = parts[parts.length - 1]
  if (last === 'skills') return parts[parts.length - 2] ?? key
  return last ?? key
}