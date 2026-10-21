/**
 * 官方（`@deepseek-ai`）基础设施 skill 的**默认不展示**规则。
 *
 * 口径：默认不展示、也不控制 `@deepseek-ai` 官方的 skills——面板里完全不出现这些行，
 * 但模型仍可自动调用它们。用户在面板上打开「显示官方 Skill」后，这些行回到清单，
 * 与普通行一样可以逐项关闭（关闭才会真正挡掉模型的自动调用）。
 * 开关存在全局策略的 `showOfficialSkills`，见 `src/policy/schema.ts`。
 * 本文件只回答「哪一行算官方」，不回答「列不列」——后者由调用方传口径。
 *
 * ── 为什么只能按**路径**判定，不能按 provider 或 source ──
 *
 * 实测结论（2026-10-14）：这四个 skill 的
 * `(provider, source)` 与用户自己的自定义 skill **完全相同**：
 *
 *   name=agent-experience             source=custom provider=filesystem rank=300
 *   name=cordis-composition-reference source=custom provider=filesystem rank=300
 *   name=cordis-plugin-development    source=custom provider=filesystem rank=300
 *   name=editing-cordis-compositions  source=custom provider=filesystem rank=300
 *
 * 原因在宿主 web-app 的 preset 补丁里：
 * `@deepseek-ai/dsh-web-app/presets/cordis.patch.yml:135-138` 把
 * `@deepseek-ai/dsh-agent-preset` 包内 `skills/` 目录塞进 **`skill-filesystem`** 的
 * `customSkillDirs`。因此它们由**同一个 `filesystem` provider** 拥有，
 * `source` 也是同一支 `custom`。⇒ 按 provider/source 过滤会把用户自己的
 * custom skill（88 条）一起误伤，**不可用**。
 *
 * 唯一可区分的信号是 `path` 里含 `@deepseek-ai` 这一串。
 *
 * ── 为什么用「路径含 @deepseek-ai」而不是「按根目录绝对路径前缀」──
 *
 * 包物理路径随 pnpm 版本目录变化（实测含 `.../pnpm/global/v11/5bd1-<hash>/...`），
 * 写死前缀会在 pnpm 升级后**静默失效**。而作用域名由官方包自身决定，跨机器稳定。
 * 另有一处软链副本在 `~/.dsh/profiles/<profile>/node_modules/` 下，同一规则也能覆盖。
 *
 * ── 路径之外的第二条信号：官方 provider（2026-10-21 补充）──
 *
 * 上面的路径规则有一个**已知漏口**：它只在行带 `path` 时生效。`@deepseek-ai/dsh-skill-office`
 * 注册的 7 条 `office-*` skill **不填 `path`**（只填 provider 自用的 `locator` 与
 * `resourceBase`，见 `dsh-skill-office/lib/index.js:61-101`），而宿主 `dsh-skill` 的
 * `toSummary` 只透出 provider 明确给出的 `path`（`dsh-skill/lib/index.js:491-503`）。
 * 实测这 7 条因此绕过路径规则：既出现在面板上、可被开关（与「官方 skill 不展示」冲突），
 * 也曾被错归到「运行时注入」组。分组已在 `groupKeyOf` 里补了 provider 兜底：
 * 没有 `path` 的插件 provider 行按 `provider:<名字>` 单独成组（组名即 provider 名）。
 *
 * 所以对这类行补一条按 **provider 名**的判定（`isOfficialSkill`）：
 * - **不用 `source === 'bundled'`**：`filesystem` provider 的 `DSH_BUNDLED_SKILL_DIR`
 *   会把**用户自己的目录**也标成 `bundled`（`dsh-skill-filesystem/lib/index.js:83,180-182`），
 *   按 source 判定会隐藏用户技能。
 * - **不用「provider 不是 filesystem 就算官方」**：第三方插件（如 `superpowers-dsh`）
 *   也注册自己的 provider，而它们正是「来源写插件名」要展示的对象。
 * - provider 名是注册表的**强制约束**（`validateCandidate` 校验
 *   `candidate.provider === providerName`，`dsh-skill/lib/index.js:462`），provider 无法
 *   自报别名；`source` 则可以随便填。因此按 provider 判定比按 source 可靠。
 */

/**
 * 官方作用域目录名。**这就是全部判定依据**——路径里出现它即视为官方 skill。
 *
 * 注意这不是「provider 名」：官方 skill 由 `filesystem` provider 持有，
 * 与用户自建 skill 同一个 provider（见文件顶部说明）。
 */
const OFFICIAL_SCOPE = '@deepseek-ai'

/**
 * 这一行是否属于官方 `@deepseek-ai` skill（⇒ 面板不展示）。
 *
 * 判定：`path` 的**任意位置**出现子串 `@deepseek-ai`。
 *
 * ── 口径与取舍（有意放宽到整个作用域）──
 *
 * 口径是「不展示 @deepseek-ai **官方的** skills」。按字面，指的是整个
 * `@deepseek-ai` 作用域，而不只是 `dsh-agent-preset` 这一个包。因此这里用
 * **子串**匹配，覆盖该作用域下的**所有**包：
 * - 当前的 `dsh-agent-preset`（面板上那 4 条）；
 * - pnpm store 里形如 `.../.pnpm/@deepseek-ai+dsh-xxx@<版本>_<hash>/` 的目录
 *   （用 `+` 而非 `/`，子串匹配天然覆盖）；
 * - 将来官方任何新包里的 skill —— 无需再改这条规则。
 *
 * **已知代价（有意接受，不要当成 bug）**：子串匹配**不区分目录层级**。
 * 用户自己写的、路径里恰好含 `@deepseek-ai` 的 skill 也会被一并藏掉，
 * 例如 `/proj/sand/@deepseek-ai/my-own/SKILL.md` 或 `/proj/@deepseek-ai-tools/skills/x`。
 * 这类 skill 在面板上**完全消失且没有任何提示**。
 * 曾评估过两个更窄的口径（限定 `node_modules` 内 / 要求相邻两段恰好是
 * `@deepseek-ai` + `dsh-agent-preset`），二者都能避免这处误伤，
 * 但用户明确选择了最宽、覆盖最全的口径。**若日后要收窄，改这里并同步改
 * `tests/inventory/official.spec.ts` 里那组「已知代价」用例。**
 *
 * `path` 缺失（runtime 注入的 skill）时返回 `false`：没有路径就无法判定，按「不是官方」处理。
 * 这类行改由下面 `isOfficialSkill` 的 provider 白名单兜底（`dsh-office` 就是这么盖住的）。
 */
export function isOfficialSkillPath(path: string | undefined): boolean {
  if (path === undefined) return false
  return path.includes(OFFICIAL_SCOPE)
}

/**
 * 已确认的官方 provider：**官方包自己注册、不经磁盘 provider，因此没有 `path` 可判**。
 *
 * 目前只有 `dsh-office`（`@deepseek-ai/dsh-skill-office` 注册 7 条 `office-*`，实测
 * `provider='dsh-office'`、`source='bundled'`、`path` 缺失）。这是**白名单**：名单外的
 * provider 一律按第三方处理，面板照常展示。
 *
 * `runtime` **不在**名单内：`browser-skill`、`memory-recall` 这类宿主内置能力必须留在
 * 面板上，用户要能单独关掉它们（见 `tests/routes/handlers.spec.ts` 的「活清单项」用例）。
 */
const OFFICIAL_PROVIDERS: ReadonlySet<string> = new Set(['dsh-office'])

/**
 * 这一行是否属于官方 `@deepseek-ai` skill（⇒ 面板不展示）。**清单过滤只调这一个。**
 *
 * 判定顺序（任一命中即官方）：
 * 1. `path` 任意位置含 `@deepseek-ai`（既有规则，覆盖有磁盘出处的官方包）；
 * 2. `provider` 在 `OFFICIAL_PROVIDERS` 白名单里（覆盖没有 `path` 的官方 provider）。
 *
 * 两条都判不出时返回 `false`：**不能因为「判不出」就把它藏起来**，否则用户会失去
 * 自己技能/第三方插件技能的开关入口。
 */
export function isOfficialSkill(entry: { path?: string; provider?: string }): boolean {
  if (isOfficialSkillPath(entry.path)) return true
  return entry.provider !== undefined && OFFICIAL_PROVIDERS.has(entry.provider)
}
