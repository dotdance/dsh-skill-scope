# dsh-skill-scope 设计文档

- 文档版本：v1.7
- 日期：2026-10-12（v1.7 修订于 2026-10-13）
- 基准：DSH `0.2.1-alpha.2`（`@deepseek-ai/cordis` `4.0.5-alpha.1`）
- 目标仓库：本仓库（相对路径 `.`）
- 状态：设计方向已与用户确认；本文件是实施计划的输入。实现已完成，当前代码以本文件的机制与不变量为准。
- 修订历史见 13 节。本节只记录**当前**口径，不再复述各版本的编辑过程。

本文档只描述逻辑、机制与接口，不粘贴实现代码。所有接口结论都在已装包上核实过；引用格式为 `<包>/lib/<文件>:<行号>`，「包根」见 12 节。正文结论**只**引用已装官方包。

---

## 1. 背景与目标

### 1.1 要解决的问题

模型在一次会话里能看到的 Skill 与 MCP 工具越来越多，注意力被稀释。既有机制只覆盖一半：

| 能力 | 既有机制的状态 |
| --- | --- |
| 收窄范围 | 只有单一层（按工作区），**没有全局面板** |
| 作用域模型 | **不区分「全局」与「本工程」**，偏向「全机器」视图 |

两者能力互补但都不完整：收窄机制没有全局视图，作用域模型不区分全局与工作区。

### 1.2 合并后的目标

一个插件同时回答两个问题：

1. **全局**：这台机器上、无论哪个工程都能被模型调用的 Skill / MCP，要关掉哪些？
2. **本工程**：在当前工作区里，进一步关掉哪些？

并满足：

- 全局层给的是**默认值**，工作区层可以**逐项**跟随、打开或关闭（三态）。
  全局关掉的项在工作区面板里**仍然可见、可直接打开**；全局打开的也能在本工程单独关掉。
- 两层都不改文件、不改 profile、不改 frontmatter；只收窄「模型可调用」的能力视图。
- 用户手动 `/name` 调用 Skill 的行为不受本插件影响——**前提是 shadow 忠实复制原定义**（`content` 等字段原值透传，见 5.1）。「关闭 = 只对模型不可见，保留 `/name`」是显式产品决策（见 11 节已定），不是实现限制。本插件从不写 Skill 文件。

### 1.3 非目标（明确不做）

| 不做 | 原因 |
| --- | --- |
| 创建 / 编辑 / 删除 Skill 文件 | 用户已明确选择「只做启停控制」（create / edit / delete 三个 tab 不做） |
| 安装、发现或提供 Skill / MCP | 插件只收窄既有能力视图 |
| 修改 DSH profile、loader 行、`cordis.yml` | 改配置属于安装期行为，不是运行时策略 |
| 改写 Skill frontmatter | frontmatter 是 Skill 作者的文件，启停是运行期策略，两者不混：改文件会把「模型可见性」变成磁盘上的持久状态，且在只读 Skill 目录上根本不可行；`userInvocable` 语义完全交给 Skill 自身 |
| 新增 / 连接 MCP server | 增删 MCP 只能改 loader 行或改 preset 组合（同属安装期行为）；本插件没有 MCP 注册面 |
| 读取 `.trash` 或提供恢复 UI | 与启停无关 |
| 读取 Skill 正文用于展示 | 面板只列摘要字段（但 shadow 内部需要正文，见 5.1） |

---

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| 策略 | 一份持久化的「关闭哪些能力」的声明。分全局策略与工作区策略。 |
| 全局策略 | 存在 `$DSH_HOME/skill-scope/global.json`，对每个工作区生效。路径经 `dshHomePath('skill-scope','global.json')` 求得（优先级「显式配置 → `$DSH_HOME` → `~/.dsh`」，`dsh-home-paths/lib/index.js:101-106`、`:132`）。存储选型见 3.8。 |
| 工作区策略 | 存在 `<工程根>/.dsh-scope.json`，只对该工程生效。 |
| 名称 | Skill 的 `name`（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）或 MCP 的 `serverName`（`[A-Za-z0-9_-]{1,32}`）。策略按名称取值，与来源无关。 |
| 全局清单 | 与工作区无关、任何 cwd 下都存在的 Skill / MCP 集合。 |
| 工作区清单 | 某个 Agent 在当前 cwd 下**实际能看到**的能力集合。 |
| 生效集 | 逐名字求值的结果：`工程层表里有这项 ? 表里的值 : 全局是否启用`。表里没有 = 跟随全局（见 3.1）。 |
| shadow | 在 Agent 作用域注册一个同名 Skill，`modelInvocable: false`，压住更外层同名 Skill。 |
| restriction | 通过 `tools.restrict({deny})` 在 Agent 作用域上屏蔽一组工具名。 |
| restrictableNames | 该作用域**继承面**上可被 `restrict` 合法屏蔽的工具名集合；`restrict` 用它做校验，不在其中的名字会抛错（见 5.2）。它只存在于**非 public** 的 `tools.view(scope)`（`dsh-tools/lib/types/index.d.ts:680` 声明 `private view;`），public 面只有 `schemas(scope)`；取舍见 5.2。 |
| loader-only server | 在 loader 行里配置了 `@deepseek-ai/dsh-mcp-client`、但没有产出任何 `mcp__` 工具（通常启动失败）的 MCP server。只能只读展示，不可用 `restrict` 关闭。 |
| 非实时视图 | 没有 live Agent 时（`agents.get(sessionId)` 取不到），用全局 registry + preset 作用域拼出的**预演**视图；不等于该会话的实际生效集（见 6.3、7.2）。空白会话**不属于**这一情形，它已有 live Agent。 |
| fail-closed | 收窄动作失败时选择「保持关闭」并显式抛错，而不是静默放行。 |

---

## 3. 策略模型

### 3.1 两层与两个文件

```
                ┌─────────────────── 全局层 ───────────────────┐
$DSH_HOME/      │ global.json  mode/skills[]/mcps[]            │  默认值
skill-scope/  └──────────────────────────────────────────────┘
                                    │ 逐项：跟随 / 打开 / 关闭
                                    ▼
                ┌────────────────── 工作区层 ──────────────────┐
<工程根>/        │ .dsh-scope.json  workspace{skills{},mcps{}}  │  按名字覆盖
.dsh-scope.json  └──────────────────────────────────────────┘
                                    │
                                    ▼
                      Agent 作用域上的实际生效集
```

求值顺序固定为：**先算全局，再逐名应用工程层的决定**。每个名字的开关是：

```
isOpen(name) = 工程层表里有 name ? 表里的值 : 全局是否启用(name)
```

工程层表里**没有**这个名字 = 跟随全局；表里**有** = 工程层的明文决定 —— 可以打开全局关掉的项，也可以关掉全局打开的项。因此全局层是**默认值**，不是上限：这一条推翻了 v1.5 之前的「工作区只能收窄」，理由与实现见 13.10。

### 3.2 文件格式

全局文件（新增）：

```json
{
  "version": 1,
  "mode": "blacklist",
  "skills": ["writing-skills", "get-baidu-index"],
  "mcps": ["codegraph"]
}
```

工作区文件（**路径不变**；存储形状自 v2.0 起为逐项表，见 3.5 的兼容规则）：

```json
{
  "workspace": {
    "skills": { "md-word-count": false, "writing-plans": true },
    "mcps": { "codegraph": false }
  }
}
```

`workspace.skills` / `workspace.mcps` 是 `名字 → 布尔` 的映射，语义是**绝对状态**：
`false` = 本工程关闭，`true` = 本工程打开（即使全局关着它）。

- **键不存在 = 跟随全局**。因此「改回跟随全局」在文件里表现为**删掉这个键**，而不是写一个与全局相同的值。
- 保存时**剔除与全局同向的条目**：文件恒等于「真实差异集」，写盘即自愈。代价是手写的同向条目会被静默删除（这是有意的取舍，见 13.10）。
- 键排序写回，理由与全局层相同：同一逻辑策略必须产出同一份字节，否则 `revision`（`sha256(content)`）会假变更。
- 工作区层**没有 `mode`**。三态不是第四种 mode，它是「逐名字给定状态」这件事本身；再加一个 mode 字段就等于又把「同一份名单有两种相反含义」请回来（那正是白名单被删的原因，见 3.4）。
- 顶层允许存在其它工具写的未知键（如 `"note"`），保存时原样保留。本插件只用 `workspace` 这一个命名空间。

校验规则（zod，宽松读 + 严格写）：

- `mode` **只有 `blacklist` 一种生效语义**。宽松读取仍接受 `default`，但归一到 `blacklist`；`whitelist` 已不在合法取值内，读到它按非法处理并给迁移 warning。**缺失时两层都取该层缺省**（列表保留但无效）。口径统一为 fail-open（见 13 节）。
- `skills` / `mcps` 为字符串数组；去重、排序后写回；单数组上限 512。
- 名称在写入前按类型各做一次正则校验；非法名称整体拒绝并回 400。
- 解析失败时**不覆盖**原文件，按「空策略」使用，并在响应中带上 `warning`。

### 3.3 名字键控与交叉语义

策略按名称生效，因此有一条必须写进 UI 文案的推论：

> 若某个名称同时存在于全局根与某个工程根，**两层对该名称的所有来源同时生效** —— 全局的默认值、以及工程层的覆盖，都不区分来源。

这是「按名字键控」的直接结果，不是缺陷。它有一个有用推论：同名 Skill 不需要逐来源开关，一次决定就够。

### 3.4 mode 语义

**只有黑名单一种语义**（2026-10-13 删除白名单）：

| mode | 列表含义 | 生效集 |
| --- | --- | --- |
| `blacklist` | 列表内为关闭项 | 清单 − 列表 |
| `default`（仅读取兼容） | 归一为 `blacklist` | 清单 − 列表 |

白名单被删除的理由：它让同一个 `skills` 数组在不同模式下**含义相反**（黑名单里在名单上
= 关闭，白名单里在名单上 = 启用），是「关掉一项反而把其他项打开」那类缺陷的温床；
且它有一个无法闭合的缺口——**未出现在名单里的名字不可枚举**，于是全局层关掉了什么，
工作区层无从如实反映（该模式下只能返回空集合，宁可多显示）。

删除后名单永远可枚举，「全局关了哪些」有确切答案。

工作区层**不再沿用黑名单**：它是逐项表（3.2），因此既不需要「全局关了哪些」这份补集，也不会把两种相反含义塞进同一个数组。两层各自只有一种读法：**全局的数组 = 关掉的名字；工作区的表 = 明文状态**。（不变量 1/2/3/27）

### 3.5 兼容与迁移

**文件名**：工作区策略文件为 **`.dsh-scope.json`**（`paths.ts` 的 `WORKSPACE_POLICY_FILE`）。

**文件形态（两种并存，读取都支持）**：

| 形态 | 谁写出的 | 怎么读 |
| --- | --- | --- |
| 旧：`{"default":{"mode":"blacklist","skills":[…],"mcps":[…]}}` | v1.x（本机现存 13 个文件全部是这一形态，条目合计 418 条） | 数组里每个名字都当作 `false`（旧数组的唯一含义就是「关」）；`mode` 丢弃（工作区层没有 mode） |
| 新：`{"workspace":{"skills":{…},"mcps":{…}}}` | v2.0 起 | 直接读表；键不存在 = 跟随全局 |

**迁移是懒的**：只有该工程**真的写盘**时才发生（面板里改一项并保存）。理由有三条：
① 插件没有「所有工程」注册表 —— 工程文件路径由会话 `cwd` 算出来，批量迁移只能扫盘猜根目录或从 `~/.dsh/sessions/--…--/` 反解路径，两者都不可靠，且会在启动时就写盘；
② 懒迁移不需要用户做任何事，老工程下次打开照常工作；
③ 一次性批迁移会让「同一个逻辑策略」在不同工程里写出不同条数，难以解释。

**旧格式兼容分支永久保留**，不当过渡代码删：删掉它，任何半年没打开的工程下次打开时会静默丢掉全部设置。

**首次保存会「瘦身」**：写盘时剔除与全局同向的条目，因此旧文件里那些「全局早就关着、工程层又记了一遍」的重复条目会消失（本机实测：418 条 → 保留 54 条，丢弃 87%）。这不是丢设置 —— 那些条目的效果与「跟随全局」完全相同；面板上也不会出现任何未预期变化。

**并发写者**：`.dsh-scope.json` 的读写用模块级 promise 链串行化**进程内**的写，**不取文件锁**；读取则整份 JSON 解析，只取 `workspace` 字段，再整份写回（保留其它顶层键）。本插件读写该文件时不与其他插件协作；若有另一个写者同样读写它，同一次保存仍可能互相覆盖，这条边界要写进 README。

### 3.6 读写规则

- **写入走宿主侧 `node:fs`**（探针 6 实测确定）：`ctx.get('fs')` 是**模型能力缝**，它的沙箱围栏按**目标路径**判定，可写根只有 `workspaceRoot`、`/tmp` 与 `tmpdir()`（`dsh-fs-sandbox/lib/index.js:157-166` 的 `checkedTarget`；集合在 `dsh-sandbox/lib/index.js:166-173` 的 `writableRoots`）。全局策略文件在 `$DSH_HOME/skill-scope/` 下，**永远不在可写根内**，所以在宿主默认的 `workspace-write` 模式下 `writeText` 必然抛 `FS_SANDBOX_DENIED` —— 实测「带 `sandboxPolicy`」与「不带」两种写法结果**完全相同**（探针 6；证据见 `docs/dsh-runtime-facts.md` §1）。官方包先例同向：`dsh-plugin-manager`（写 `$DSH_HOME/profiles/**`）与 `dsh-credentials-local`（写 `~/.dsh/.credentials.yaml`）都用 `node:fs` + `writeFileAtomic` + `withFileLock`，已装官方包里**没有一个**用 `ctx.fs` 写自有配置文件。因此读写都由插件在宿主侧自己做，原子性交给 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic(filename, content, { mode })`（`mode` **必填**，`dsh-atomic-write/lib/types/index.d.ts:47-83`）：策略文件用 `0o600`，其父目录用 `0o700`。
- **陈旧性检查用内容哈希**：`FsWriteIntent` / `FsVersion` 是 `ctx.fs` 的概念，宿主侧写入用不上。改为：在 `withFileLock` 的临界区内读当前文件内容，取 `sha256(content)` 摘要作为该文件的 `revision` 返回给面板，保存时原样回传比较；不符即拒绝写入并回 `409 stale-revision`。因为「读 → 比较 → 原子替换」整体在文件锁的临界区内，不存在「先查后写」的窗口。`mtime` 不参与判定：同秒内两次写入会撞车，且不同文件系统的精度不一致。文件不存在时 `revision` 为 `null`，语义是「当前无策略」。
- 读取宽容（fail-open）：文件不存在 = 空策略；JSON 坏或 schema 不符 = 空策略 + `warning`，且**不自动修复**（自动修复会把用户的意图改掉）；全局 `mode` 缺失按 `blacklist` 之前先归一（列表保留但无效）。三者同一条口径：读不懂就什么都不关。工作区侧同样逐字段宽容：某个值不是布尔 ⇒ 该项按「跟随全局」并给 warning，**不整份丢弃**（其余条目照常生效）；`default` 与 `workspace` 同时存在 ⇒ 以 `workspace` 为准 + warning。
- 并发：进程内按文件路径串行化写操作；跨进程由 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock(file, op, { waitMs? })`（`wx` 创建的 `<file>.lock` 兄弟文件，记录持有者 PID）覆盖读-改-写周期。读侧无需加锁：`rename` 提交是原子的。
- 目录不存在时按需创建（`$DSH_HOME/skill-scope/`）。路径来自官方 `@deepseek-ai/dsh-home-paths`（`resolveDshHome()` / `dshHomePath()`；优先级「显式配置 → `$DSH_HOME` → `~/.dsh`」，空白的 `$DSH_HOME` 视同未设置），不手工拼 `~/.dsh`。
- **sandbox 策略参数整体作废**：既然写入不走 `ctx.fs`，`sandboxPolicy.resolve({ session, mode })` 与「能取到就带上、取不到按后端默认并标注」这套口径就没有落点了 —— 宿主侧写入本来就在宿主权限内，与模型能力缝的沙箱模式无关。**一条会误导人的环境事实**：本机 `~/.dsh/profiles/web/cordis.patch.yml` 把 `dsh-permission-presets` 的 `defaultPreset` 配成 `danger-full-access`，所以在 web 会话里 `ctx.fs` 恰好也能写 `$DSH_HOME`；那是用户本机的 preset 配置，不是契约，插件不得依赖。

### 3.7 生效时机：创建时落地 + 回合边界生效

一条规则：**策略在「回合边界」上生效——`agent/created` 时先按当时的全局策略与工作区策略落地一次收窄面；此后每次保存都对该会话的活跃 Agent 重新落地，从该会话的下一回合装配起生效。回合内不变，跨回合重读。**

**为什么不用「会话内锁定」**：锁定规则的前提是「空白会话没有 live Agent」，而探针 9 证伪了它 —— `session.create` 时就已建 Agent，`agents.list()` 又能枚举活跃 Agent。前提一坏，锁定就产生自相矛盾的后果：**§7.2 的主用法（在空白会话的 chip 里改本工程策略）反而对它自己那个会话不生效**，因为该会话的 Agent 早在用户编辑之前就创建并冻结了。因此改为「回合边界生效」。**保留下来的实质是「回合内稳定」**：正在生成的这一回合不受影响，避免模型看到的工具列表在本回合中途改变。

**为什么挂在 `agent/created`**：不挂在 `system-prompt/assemble` 上，因为「只有装配上下文才拿得到 `cwd`」这个理由不成立 —— `cwd` 早已由 `agent.session.header.cwd` 在事件派发前快照（`dsh-agent/lib/types/index.d.ts:47-58`），另有 `ctx.workingDirectory.ensure(agent, signal)` 可用。选 `agent/created` 的决定性原因是**它能保证注册面早于该 Agent 的第一次装配**：该事件是 serial 派发、监听器被逐个 `await`（`dsh-agent/lib/index.js:579`），因此 5.2/5.3 的 shadow 与 restriction 都能在首次装配之前落地，不需要装配瀑布、不需要重跑。代价是这里的监听器**绝不许抛错**（`api-catalog.js` 事件描述：会让会话创建失败），所以一律 fail-open。

| 场景 | 结果 |
| --- | --- |
| 在**空白会话**（从未发过消息）的工作区面板里改策略 | 该会话**已经有** live Agent（探针 9）；保存即对该活跃 Agent 重新落地，因此它**首个回合**的装配就按新策略 ⇒ 对该会话生效（7.2 的主用法因此成立） |
| 在**已发起过请求**的会话里改策略（任一层） | 当前回合不受影响；重新落地后自**下一回合**装配起生效（探针 2 实测「对 live Agent 施加 `restrict`，下一次装配即收窄」；探针 10 实测清单变化同样「下一个 pre-step 生效」） |
| 在运行中的会话里打开全局面板改全局策略 | 同上一行（全局策略是各会话下一次重读时的输入）；另影响此后新建的会话 |
| 会话进行中清单发生变化（provider 失效、文件增删、MCP 连接完成） | 策略快照不变，但**隐藏集按当前清单重算**；新出现的、名字在快照关闭集里的 Skill 会被补上 shadow |

**没有任何东西被冻结**：每次触发都重读策略与清单。被固定的是**回合内稳定** —— 一次装配用同一份策略与同一份清单算隐藏集，回合中途不重算（见 5.3）。清单变化由 `skills/change` / `tools/change` 通知驱动，策略变化由保存驱动；两者都从下一个回合的装配起体现。

该语义必须在 UI 上显式表达（见 7.3）。两条读路由**不返回**任何会话状态字段：没有 UI 读它们（7.3 的文案只讲「保存后何时生效」，不随会话状态变化）。

### 3.8 为什么全局策略是自己的一份 JSON

全局策略的存放位置由三个候选的比较得出（比较时用全库检索统计了本机 profile 中实际出现的写法）：

| 候选 | 实际用法 | 结论 |
| --- | --- | --- |
| `$DSH_HOME/skill-scope/global.json`（本项目选它） | 本机 profile 中多数已装包都这么放自己的状态文件；跨 profile 稳定；文件自可见、可备份 | ✅ 采用 |
| `ctx.settings`（写 `cordis.patch.yml`） | 官方包用它写**本 profile 的配置**：文档路径由 profile 决定（`dsh-settings/lib/index.js:400-401` → `$DSH_HOME/profiles/<name>/cordis.patch.yml`）。0.2.0 起已**移除** `settings.register`（`dsh-plugin-codegraph-project/lib/index.js:102-105` 记录该迁移），本仓库全库检索 `settings.define` 为 **0 命中** | ❌ 不用：策略是「与 profile 无关的机器级事实」，写进 patched 配置会让换 profile 失效，还会改动用户人写的 YAML |
| `ctx.storage`（KV hub） | 只有官方包在用（`dsh-workspace`、`dsh-session-projection-cache`、`dsh-schedule`），且其文档明确「unit 不负责串行化并发写」；根目录 `$DSH_HOME/storages`，需要注册 domain | ❌ 不用：为一个 2 KB 的策略引入 KV 域、版本与迁移成本 |

补充一条同类先例：本机已存在 `~/.dsh/dsh-skill-hub.json`（`{"version":4,"disabled":[…]}`，约 70 KB），形态正是「**$DSH_HOME 下的全局 Skill 禁用清单 JSON**」。可见「全局启停清单放 `$DSH_HOME` 下的一份 JSON」是这台机器上既有的选择。

---

## 4. 清单定义（含 2026-10-12 修正）

修正内容：**全局清单只列全局可见的 Skill / MCP；工作区内部的 Skill / MCP 只在工作区层展示与控制。** 全局层因此不需要枚举任何会话的工作区，也不需要跨会话扫描。

### 4.1 全局层清单 = 与工作区无关的集合

依据是官方文件系统 provider 的根解析（`dsh-skill-filesystem/lib/index.js:149-186`）：

| 根 | 来源标记 | 何时出现 |
| --- | --- | --- |
| `<工程根>/.dsh/skills` | `project-dsh` | **仅当调用带 `cwd`**（:151） |
| `<工程根>/.agents/skills` | `project-agents` | **仅当调用带 `cwd`** |
| `customSkillDirs` | `custom` | **宿主给文件系统 provider 配了自定义目录时** |
| `$DSH_HOME/skills`（跳过 `.system`） | `user-dsh` | 总是 |
| `$AGENTS_HOME/skills` | `user-agents` | 总是 |
| `bundledSkillDir` | `bundled` | 配置或 `DSH_BUNDLED_SKILL_DIR` 存在时 |

所以 `skills.snapshot({})`（不传 `scope`、不传 `cwd`）恰好给出 `custom + user-dsh + user-agents + bundled`，即「无论哪个工程都存在」的集合。这就是全局清单，无需自建扫描器。

### 4.2 工作区层清单 = Agent 作用域视图

通过会话解析出 live Agent，再读它的作用域视图：

- `ctx.agents.get(sessionId)` 得到 Agent（`agent.id === agent.session.id`，见 `dsh-agent/lib/index.js:510-512`）。
- `agent.ctx.get('skills').snapshot({ cwd, scope: agent })` 得到该 Agent 在 `cwd` 下的合并视图（global 层 + preset 层 + agent 层的最近层胜出结果）。
- **`scope: agent` 不可省略**：`snapshot()` 的可见层**只由显式的 `options.scope` 决定**——`collectFresh` 用 `[global, ...chainLayers(options.scope)]` 拼层（`dsh-skill/lib/index.js:299`），而 `chainLayers(undefined)` 是空链，只剩 global 层（`dsh-scope/lib/index.js:162-169`，`:173` 的注释写作「undefined for the global view」）。`SkillRegistry` 只在**注册**时用 `scopeOf(this.ctx)` 落层（`dsh-skill/lib/index.js:193-215`，全文件仅此一处 `scopeOf`），**读取不会从 `this.ctx` 兜底**。因此「从 `agent.ctx` 上取到服务」这件事本身不构成读取作用域，必须显式传 `scope`。
- **必须经 `agent.ctx.get(...)` 取服务，不能用插件自己的 `ctx.get(...)`**：`ctx.get()` 返回**绑定到调用方 Context** 的服务面（`dsh-agent/lib/types/index.d.ts:291-294`：「calling through `agent.ctx` scopes EFFECTS」），而 `register()` / `restrict()` 都要检查自身调用上下文（`restrict` 对非作用域上下文直接抛 `tools.restrict() requires a scoped context (agent.ctx)`，`dsh-tools/lib/index.js:2895`），所以在 Host 上下文里调用的 restriction 会变成「屏蔽所有 Agent」而被拒绝。
- 面板只呈现 `invocation.modelInvocable === true` 的条目（`SkillSummary.invocation` 是必填字段，见 12 节；过滤用官方谓词 `isModelInvocable`，`dsh-skill/lib/index.js:104`）。
- **读取清单前先检查完整性**：`snapshot().complete !== true` 时不改变当前生效状态、记录警告，并按「未知」而不是按「空清单」处理。官方 doc 明确这不完整观察**不会被缓存**，消费者应「保留 last-good 状态并在下一个请求边界重试」（`api-catalog.js` 服务 `skills.snapshot` 的描述）。
- 再减去全局策略已关闭的名称，才是工作区层真正可操作、也是真正生效的集合。

因此工作区层清单**天然覆盖**了 preset 层技能（preset 自带 `customSkillDirs`、preset 作用域 provider 注册）——该限制在本设计里被并进「工作区层视图」而消失。

### 4.3 MCP 清单

0.2.1 没有 MCP 清单服务。清单由两个来源并集得到，**两个来源的可写权限不同**：

1. **工具名来源（可关闭）**：`schemas(scope)` 里以 `mcp__` 开头的工具名，按 `mcp__<serverName>__<rawName>` 分组。
   - **解析优先用「已知 server 名集合」做最长前缀匹配**：官方构造是 `` `mcp__${serverName}__${rawName}` ``，再按 DeepSeek 函数名契约（64 字符、`[A-Za-z0-9_-]`）做字符替换，改动过就截断并追加 12 位 SHA-256 前缀（`dsh-mcp-client/lib/index.js:96-101`）。而 server 名的合法集合是 `/^[A-Za-z0-9_-]{1,32}$/`（`:767`、`:782`、`:793`）——**允许下划线**，所以 `mcp__` 之后「第一个 `__`」并不必然是边界，纯正则解析在构造上就不唯一。已知 server 名有权威来源（第 2 类的 loader 行），用**最长前缀匹配**即确定；只有遇到未知 server 时才退化为「去掉前导 `mcp__` 后取到下一个 `__` 之前」的启发式，并在日志里标注「按启发式解析」。
   - 不要假设工具名里只有一个 `__`，也不要用「取第一个 `__` 之前」——那会得到 `mcp`。
2. **loader 行来源（只读）**：loader 行里 `name === '@deepseek-ai/dsh-mcp-client'` 的 `options.config.serverName`（或 `fiber.config.serverName`）。这能覆盖「已配置但没有产出任何工具」的 server（典型是启动失败）。

**只有第 1 类里真实存在的工具名可以进 `restrict({ deny })`**：`restrict` 用 `view(scope).restrictableNames` 校验名字，不在其中直接抛 `names unknown global tool(s) …`（`dsh-tools/lib/index.js:2893-2907`）。因此：

- 调 `restrict` 前，deny 集必须先与 `restrictableNames` 取交集；等价做法是把 server 名展开成它当前真实的工具名。后者成本低、无需私有成员，但**列不出没有工具的 server**，本设计用第 2 类来源补上这个盲区。两件事都要做：第 2 类来源负责「让用户看见」，交集负责「让 `restrict` 不抛错」。
- loader-only server 只能**只读展示**，标注「未加载、不可在此关闭」，不提供开关。

**两层清单不一定相同**：`schemas()` 的可见面由作用域决定，与 Skill 同理。全局层用插件自身的全局视图（`schemas()`，不含任何 Agent 作用域）；工作区层用 `agent.ctx.get('tools').schemas(agent)`，它包含 preset / agent 作用域注册的 MCP。0.2.1 **支持**作用域内 MCP：`dsh-mcp-client` 的 `activeServerNames` 注释（`:769-773`）说明 server 名预留是**按注册作用域隔离**的（「Agent-scoped MCP servers may reuse a namespace in another Agent」）；**但「作用域内 MCP」不等于「Agent 层注册」** —— 一个易犯的错误举例是：本机 `dsh-plugin-codegraph-project` 的 MCP 工具**注册在根 ctx（GLOBAL 层）**，因此**可以**被 `restrict` 收窄（见 10 节）。它的 per-session 行为不是靠分层注册，而是靠「按工具名引用计数的**一份**全局注册」加「按 `agent.id` 路由 + **一个根 guard**」（`lib/agent-tools.js:233`、`:248`、`:299`、`:383`）。

因此工作区层清单里会出现三类行，UI 必须区分：**可关闭**（继承面：global / preset / 祖先作用域注册）、**只读-未加载**（loader 行配置了但没产出工具）、**只读-本会话自有**（直接注册在 Agent 自带的那一层，`restrict` 从定义上就管不到，见 5.2）。
第三类**有真实实例**：凡是把工具注册进 `agentCtx` 的路径都落在这一层，本机至少两处 ——
①ACP 客户端的每会话 MCP 挂载：`dsh-acp/lib/index.js:216 mountAcpMcpServers(agentCtx, servers, sessionCwd)`，
其文档 `:212` 原文是「unpublished Agent scope that owns the MCP clients and tools」，
`:218 for (const config of configs) await agentCtx.plugin(McpClient, config)`，
调用点 `:702`/`:721` 在 Agent 发布**之前**；
②`dsh-subagent/lib/index.js:914 childCtx.tools.register({` 把结构化输出工具注册进**子 Agent 本层**，且它必须能被模型调用。
⇒ 这一类必须靠**逐名探测**判定，不得按插件类型推断（codegraph 就是被推错的例子）。

### 4.4 已确认的边界与交叉效应

| 情形 | 行为 | 说明 |
| --- | --- | --- |
| 名字既是全局 Skill 又是工程 Skill | 全局面板关闭它 → 两处都消失 | 名字键控，见 3.3 |
| 名字只存在于某个工程 | 全局面板不出现 | 在该工程的工作区面板里关闭；全局面板无「按名称添加」入口，因此**不能**全机器关闭一个只存在于某工程的 Skill |
| preset 层提供的 Skill | 全局面板不出现，工作区面板出现 | 同上：只能在对应工作区面板里关闭 |
| MCP（全局 loader 行注册） | 两层清单**分别**列出，不假设相同 | 可见面由作用域决定 |
| MCP（preset / agent 作用域注册） | 只在工作区层出现 | 归属工作区层；全局层不跨会话枚举 |
| loader-only MCP server（配置了但没有工具） | 两层都可以只读展示，**都不能关闭** | `restrict` 不认识没有工具的名字，见 4.3 |
| 直接注册在 **Agent 自带层**的 MCP / 工具（实例：ACP 每会话挂载的 MCP `dsh-acp/lib/index.js:216-218`、子 Agent 的结构化输出工具 `dsh-subagent/lib/index.js:914`；**不是** `dsh-plugin-codegraph-project`，它属全局层） | 只出现在工作区层，且**只读、不能关闭**（`guard` 可拦调用，见 5.2） | 它们进 `knownNames` 与 `visible`、但**不进** `restrictableNames`（`dsh-tools/lib/index.js:2969-2975`）；`restrict` 会把它们当「未知名字」抛错，见 4.3、5.2 |
| 工作区面板里的 MCP 段 | 列「全局未关闭项」+「本作用域注册项」，并显示「全局已关闭 N 个」 | 避免「明明有却看不到」的困惑 |

---

## 5. 执行机制

### 5.1 Skill：Agent 层 shadow（0.2.1 已核实）

**作用域证据链**（这是本设计最关键的一条）：

1. `dsh-agent-loop/lib/index.js:778-779`：`this.scope = createScope(loopCtx, this); this.ctx = this.scope.ctx;` —— Agent 的 ctx 就是它的作用域上下文。
2. `dsh-scope/lib/index.js:293-306`：`createScope` 用 `fiber.ctx.extend({ [kScope]: key })` 打标记；`:312-314` `scopeOf(ctx)` 即 `ctx[kScope]`。
3. `dsh-agent/lib/index.js:230-232`：carrier 为 `scopeTarget(agent, agent)` —— **Agent 本身是它自己的作用域 key**。
4. `dsh-skill/lib/index.js:193-215`：`register(skill)` 用 `scopeOf(this.ctx)` 决定落层；读取时「最近层同名直接胜出」（`:114`）。

⇒ 在 `agent.ctx.get('skills')` 上注册的同名 Skill 落在 **Agent 层**，是链上最近的一层，因此**压得住 preset 层与全局层**的同名 Skill（该限制「不覆盖 preset 作用域」因此不再适用；本条仍需探针 1 实测）。

> **已验**：本节结论已由探针 1 实测确认，三条判定同时成立 —— ①Agent 层 `modelInvocable:false` 且全局视图未外溢；②**模型收到的技能目录消息不含该名字**（对照臂 `catalogMentionsProbeDemo:true` vs 实验臂 `false`）；③`skill` 工具调用抛 `skill "…" is not available for model invocation`。证据见 `docs/dsh-runtime-facts.md` §5。

> **承重约束：层查找按对象身份索引，传「字段相同的替身」等于传错作用域。**
>
> `dsh-scope` 的两条层查找都按对象身份做键：`peek(scope)` 走 `this.scoped.get(scope)`
> （`dsh-scope/lib/index.js:151-152`），`scopeChainOf(key)` 走 `scopeParents` 这个 **WeakMap**
> （同文件 `:239`、`:276-280`）。而本插件内部为了结构化处理，用 `asAgentLike()` 把宿主载荷
> 重包成 `{ id, ctx, session }` —— **这是一个新对象**，字段与原 agent 相同，但 `!==`。
> 拿它当 `snapshot({ scope })` 会查不到 Agent 层，静默退化成只读全局层。
>
> 实测（probe1 / 3131-3133，chat 工作区，`hidden=137`）：
> ```
> scope = 替身（ctor=Object）          → exposed=69   md-word-count 读回 modelInvocable=true
> scope = 本体（ctor=ReactLoopAgent）  → exposed=1    （只剩真漏的 browser-skill）
> [CHK-SCOPEKEY] agentAsScope_isSameAsScopeKey=false  scopeKeyCtor=ReactLoopAgent  agentCtor=Object
> ```
> ⇒ 遮蔽本身**是生效的**（136/137），此前看到的 69 全部是探针传错 scope 造成的假象。
>
> 因此 `AgentLike` 新增承重字段 `raw`（宿主原始对象本体），`asAgentLike` 原样保存；
> 复验路径必须用 `scopeOf ?? agent`。**任何要读 Agent 层的调用都必须传这个本体**，
> 不能传任何重新构造的 `{ id, … }` 字面量。

注册细节（按源码逐条）：

- `register()` 先 `validateRuntimeSkill`：名称必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`；`description` 必须非空；否则抛错。
- 注册对象必须是**完整定义**：形如 `{ ...definition, invocation: { ...definition.invocation, modelInvocable: false, userInvocable: <原值> } }`。`definition` 只能来自 `skills.get(name, { scope: agent, cwd })`——`snapshot()` / `toSummary()` **不返回 `content`**（`dsh-skill/lib/index.js:234-240`、`:491-503`），而 `SkillRegistration` 的 `content` 是必填字段（`lib/types/index.d.ts` 的 `SkillRegistration = Omit<SkillDefinition,'invocation'|'provider'>`）。
- `content` 等字段必须原值透传**：`path` / `whenToUse` / `resourceBase` 不是「可选」，而是「有则原值复制」。`validateRuntimeSkill` 只校验名称、非空 `description` 与 `invocation` 布尔（`dsh-skill/lib/index.js:465-469`），**不校验 `content`**；漏复制不会报错，只会静默产出一个空技能。做法就是先整体取定义、再覆盖 `invocation` 两个布尔。
- 同一层已有同名 runtime 注册时，`register()` **只告警并返回空 disposer**（`:197-200`）。因此更新前必须**先释放自己上一轮的 shadow**，否则新 shadow 不会生效。
- `userInvocable` **保留原值**，这是产品决策而不是实现细节：本插件的「关闭」定义为**只对模型不可见**，用户手动调用一律保留。机制上：目录侧只看 `isModelInvocable`（`dsh-tool-skill/lib/index.js:943`），斜杠菜单侧看 `isUserInvocable`（`dsh-api-session-controller/lib/index.js:2320-2330`），两者都按「最近层同名胜出」取值，因此把 shadow 的 `modelInvocable` 置 `false`、`userInvocable` 透传原值，正好得到「模型看不见、`/name` 照旧」。**但这条只在字段忠实复制的前提下成立**：用户 `/name` 加载的正是 shadow 的定义，`content` 复制错了，手动调用就跟着错（不变量 8）。

### 5.2 MCP：`tools.restrict`

- API：`agent.ctx.get('tools').restrict({ deny: string[] }) → () => void`（`dsh-tools/lib/index.js:2893-2900`）。
- **挂点：`agent/created`（一次性、serial 等待）**。`agent/created` 是 **serial** 派发（`dsh-agent/lib/index.js:579`），监听器被逐个 `await`，因此在这里完成的 shadow 与 restriction **必然早于该 Agent 的第一次装配**；同时事件载荷里的 `agent.session.header.cwd` 已经可用（会话与 cwd 在 Agent 构造前校验并快照，`dsh-agent/lib/types/index.d.ts:47-58`）。⇒ 不需要装配瀑布、不需要重跑、不需要 key 防重入。
  - **在 `agent/created` 里做注册面的唯一硬约束是「绝不许抛错」**：官方口径是 `agent/created` 的监听器抛错会让会话创建失败（`api-catalog.js` 事件描述）。因此这里的策略读取与注册全部 fail-open：任何异常都降级为「本会话按空策略运行」并记日志，绝不让会话创建失败。
- **后续变化靠通知，不靠步骤**：订阅 `skills/change`（技能清单变化）与 `tools/change`（工具注册/注销或作用域 restriction 变化；它**故意不做作用域过滤**，全局变化也会到达），在回调里按**已冻结**的策略重算并做差分更新。
  - `tools/change` 是我们自己的写入也会触发的通知 ⇒ 回调必须遵循「隐藏集 key 未变则不动」，否则会自激（每次 `restrict` 都会再次触发 `tools/change`）。
- 契约（官方 doc）：只过滤调用方作用域**继承**的工具（全局层与祖先层），不碰它**自己层**注册的；空过滤器、未知名字、作用域本地名字、保留的传输名会**抛错**。
- 来源判定（0.2.1 源码核实）：`view(scope)` 里 `restrictableNames` 只收 global 与祖先层；`own` 层（直接注册在该 Agent 层上的工具）既不进 `restrictableNames`，又恒在 `visible` 里（`dsh-tools/lib/index.js:2957-2985`）。**preset 作用域挂载的 MCP 属祖先贡献，因此在可 restrict 之列**——这是 4.3 能把作用域内 MCP 纳入管理的前提；反过来，任何直接注册在 Agent 层上的工具都**关不掉**，遇到这种工具只能记入文档、不做开关。
- **deny 必须先过 `restrictableNames`**：用 `tools.view(agent).restrictableNames`（`dsh-tools/lib/index.js:2957-2985`）过滤，或把 server 名展开成当前真实工具名。loader-only server 绝不进 deny 集，只做只读展示。
  - **这个访问器是 private**：类型上只声明了 `private view;`（`dsh-tools/lib/types/index.d.ts:680`），public 面只有 `schemas(scope?)`。`schemas` 返回的是**可见**面，比 `restrictableNames` 多出「本层注册的工具」、少掉「被 restriction 挡住的工具」，两者语义不同，因此不能用它替代。本插件在**自有的、窄的**接口类型里声明 `view(scope)`，并在注释里标明「依赖非 public 成员，升级时优先复验探针 2/7」。替代口径（不推荐）：`restrict` 抛出的 `names unknown global tool(s) …; known global tools: …` 消息里列出了已知名，可以解析它——但那等于依赖错误消息文本，比依赖一个名为 `view` 的方法更脆。
  - **真正安全的兜底是 `restrict()` 自己的校验**：即使过滤有偏差，`restrict` 也会在写入前抛错并保持现状（fail-closed）。插件捕获该错误、记日志、**不宣称该 server 已关闭**，并把失败反映到 UI（不变量 13）。
- **不是所有 MCP 都能关**：能不能关取决于**该工具注册在哪一层**。`restrictableNames` 只收 global 与祖先层；**判据是「该名字注册在哪一层」，而不是「它是不是 MCP」，也不是「哪个插件装的」**。注意不要拿 `dsh-plugin-codegraph-project` 当「Agent 层注册」的例子 —— 它的 MCP **注册在根 ctx**，属 GLOBAL 层，**可关**；`lib/index.js:268` 的 `agent.ctx` 只用于会话记账，`lib/pool.js` 更是纯传输层客户端池、**不注册任何工具**。仍然成立的部分：**直接注册在 Agent 自带那一层上的工具关不掉**，只能按**只读行**展示，文案说明「由当前会话自己的作用域注册，本插件无法屏蔽」。这一层的判据原文（`dsh-tools/lib/index.js:2957-2978`）：`:2960` 继承面起点是 global，`:2962` 的 `if (layer === own) continue;` 把**own 层排除在继承面之外**，`:2969-2971` 只给继承面加 `knownNames` + `restrictableNames` + `visible`，`:2973-2975` 给 own 层只加 `knownNames` + `visible`。**本机实例**：ACP 每会话 MCP（`dsh-acp/lib/index.js:216-218`，发布前挂载）、子 Agent 结构化输出工具（`dsh-subagent/lib/index.js:914`）。preset 作用域挂载的 MCP 属**祖先**贡献，仍可关 —— 同一函数上方的注释 `:2948-2952` 正是这段历史：「Once presets moved them onto the agent plane they became an ANCESTOR contribution, so a child's filter silently stopped constraining anything it was given.」

因此在实现上必须**逐名探测**，不得推断：读 `view(scope).restrictableNames`（私有面，见下条），或对 `restrict` 做 try/catch 并解析 `names unknown global tool(s) …; known global tools: …`。探测结果决定该行走开关还是只读。

**探测到不可收窄时的退化路是 agent 作用域的 `guard`**：`dsh-tools/lib/index.js:2910-2913` 的原文是「A plain-context guard applies globally; **one registered through `agent.ctx` applies only to that agent**」，`:2925-2931` 的 `guardReason(exec)` 先查全局层、再按作用域链从最远祖先到本层逐层查 ⇒ **agent 级 guard 确可生效**。注意能力差异，UI 必须如实告知：**`restrict` 遮的是模型可见列表，`guard` 只拦调用、不遮列表**。

> 旁证（不属本设计范围，但直接影响上一条的写法）：`dsh-plugin-codegraph-project/lib/agent-tools.js:362-369` 的注释称「经 `agent.ctx` 挂 guard 在 DSH 里不可达，所以只能用一个根 guard」。该说法**不成立**：它引用的症状是属性式 `ctx.tools` 缺 `inject` 时的报错，而 `agent.ctx.get('tools')` 是可达的（探针 2 实测 `restrict` 成功），其上挂 `guard` 也按 `:2910-2913` 只作用于该 Agent。该插件用根 guard 是**自选**，不是平台所迫。
- **多次 restrict 是相交而不是替换**，所以每次变更必须 `dispose` 旧的 restriction 后再注册新的。
- **为什么不能挂在装配瀑布里**：若把注册面留在装配内部，就只能「进瀑布时注册 → 重跑一次装配 → 把重跑的装配作为监听器返回值返回」，代价是整条重跑链。而工具 schema 在广播瀑布**之前**就已生成（`assemble()` 先收集 `toolProviders`（`dsh-system-prompt/lib/index.js:362-378`）并 `orderTools`（`:391`），**最后**才广播 `system-prompt/assemble`（`:395`））。把注册面提到装配之前，这一整条代价链就消失了。
- **为什么也不能挂在 `agent/pre-step`**：`preStep()` 先 `assemble()`（`dsh-agent-loop/lib/index.js:907`）再派发 `agent/pre-step`（`:910`），并用**自己的局部变量**覆盖 pre-step 结果里的同名字段（`:925` 的 `return { ...decision, assembly }`）⇒ 那里注册的 restriction 只能影响下一步；而且装配期之后没有任何环节会重算工具（`refreshContext` 的文档明确「sections、tools 与插值变量的 provider 与瀑布不再重跑」，`dsh-system-prompt/lib/index.js:321-328`；`step()` 直接把 `assembly.tools` 交给 `buildRequest`，`dsh-agent-loop/lib/index.js:1075`、`:1214`）。
- **重入与幂等**：没有重跑，所以不再需要「key 未变即 `next()`」这种重入终止条件；保留的只是**幂等判据**——隐藏集 key 未变时什么都不做（既避免 `tools/change` 自激，也避免不必要的注册面抖动）。
- **专家逃生口（不默认启用）**：`system-prompt/assemble` 的监听器可以返回替换后的 `PromptAssembly`（含 `tools`），这是官方文档给出的「一次性重写本步工具列表」通道。若探针 2/8 证明存在「工具在首次装配之后才注册」的窗口且不可接受，就在那里做一次补偿，而不是恢复整条重跑链。
- **挂在 waterfall 事件上的监听器必须 `next()` 透传**（由探针事故反推得出）：cordis 的 `EventsService.dispatch(type, args)` **不按 `type` 过滤**监听器（type 只用于广播 `internal/dispatch`，`@deepseek-ai/cordis/lib/index.js:258-264`），所以 `ctx.on(name, fn)` 注册的回调会参与该名字的**每一种**派发模式；而 `waterfall` 的语义原文是「不调用 `next()` 的监听器否决链的其余部分，包括内建行为」（`:307-325`）。`agent/pre-step`（`dsh-agent-loop/lib/index.js:909` 的 `dispatch.waterfall`）与 `system-prompt/assemble` 都是 waterfall ⇒ 上面这个逃生口只能写成「`const result = await next()`，再返回改造后的 `result`」，**不能**自己造一个 `PromptAssembly` 返回，也**不能**只观察而不 `next()`。实测代价：一个只观察、既不 `next()` 也不返回值的监听器会让宿主在 `step_start` 之前崩于 `Cannot read properties of undefined (reading 'contexts')`（隔离实验见 `docs/dsh-runtime-facts.md` §4）。同理，5.3 那条「本插件不注册 `agent/pre-step` / `system-prompt/assemble`」是硬要求，不是风格偏好。

### 5.3 生命周期、差异更新与并发

- **没有执行步骤钩子**：Skill shadow 与 MCP restriction 都在 `agent/created` 一次性落地，之后由 `skills/change` / `tools/change` 差分维护。插件**不注册** `agent/pre-step`，也**不注册** `system-prompt/assemble`。
  - Skill 侧为什么不需要 pre-step：模型可见的技能目录不是 system-prompt 段，而是 `agent/pre-step` 阶段现算并注入的一条 **user 消息**（`dsh-tool-skill/lib/index.js:929-970`，`:943` 用 `snapshot().skills.filter(isModelInvocable)` 过滤，`renderCatalogMessage` `:966`）。只要 shadow 在**该步开始之前**已在册（`agent/created` 一次性落地 + `skills/change` 增量维护），目录消息里就不会出现它——不需要在 pre-step 里抢注，也就避免了「注册晚于 `next()` ⇒ 固定晚一步」的坑。
  - MCP 侧为什么不需要 assemble：见 5.2 的挂点论证。
  - 两侧都从事件载荷拿到 Agent，`cwd` 取 `agent.session.header.cwd`（`dsh-agent/lib/types/index.d.ts:47-58` 保证会话建立时已快照）。
- **首次落地点 = `agent/created`**：在这里把两级策略（3.7）算成隐藏集并落地；此后每次策略保存都对**活跃 Agent 重新落地**，自下一回合装配起生效。
  - 早期版本写的「不能挂 `agent/created`（那时 cwd 与冻结策略尚未就绪）」是错的：cwd 已由 `agent.session.header.cwd` 在事件派发前快照，策略文件本来就是外部同步可读状态。
  - 空白会话（7.2 的主用法）**已有 live Agent**：`session.create` 时就建 Agent，所以不能在 `agent/created` 之后就把策略当成不可变 —— 那样 chip 里保存的策略对它自己那个会话不生效。改为「保存即重新落地」后，空白会话的**首个回合**即按新策略装配。
  - 落地的对象是**活跃 Agent 的枚举结果**（`agents.list()`，`dsh-agent/lib/types/index.d.ts:357`）；子 Agent 是否也算「同会话」需按 `roots()` 或 `isOwnedBy` 过滤，这一点**尚未实测**（见 11 节）。
- 状态：模块级 `Map<agentId, { agent, policy, skillKey, mcpKey, skillDispose, mcpDispose }>`（字段名 `policy`：它是**最近一次读到的**策略，不是不可变快照）；`skillKey` / `mcpKey` 各是本轮隐藏集的规范化字符串（用于变更比较）；两个 disposer 分别是本轮 shadow 与 restriction 的释放句柄。**没有** `lockedAt` / `live`：它们只为「已装配」文案存在，而该文案已被 7.3 改写为不变量。
- 每次触发（`agent/created`、保存策略、`skills/change`、`tools/change`）：读两级策略（见 3.7）→ 用该次读到的策略与**当前清单**算隐藏集 → 与 key 比较 → 变化时做「release 旧的 + 注册新的」。**策略本身不再冻结**：每次触发都重读，被固定的是「同一个回合内不变」。
  - **Skill 侧：目标集变化时重建**。shadow 只要还在册就继续生效，因此集合未变时不做任何事；变化时重建必须**先释放旧的**——同层重名注册只告警并返回空 disposer（`dsh-skill/lib/index.js:196-201`），不释放就永远换不上。
  - **MCP 侧：只在 `mcpKey` 变化时重建**。restriction 是「相交」语义，重复注册会叠加出错误的交集，所以必须先 dispose 再注册；而且写入本身会触发 `tools/change`，集合未变时必须早退（否则自激）。
- 复验：Skill 侧在注册后用一次 `snapshot({ scope: agent, cwd })` 复验（生产路径传 `verifyStillVisible: true`）；若仍有被禁 Skill 可见，则**记 warning 并保留其余生效项**，不回滚、不抛错。早先的「回滚 + 抛 `dsh-skill-scope: failed to hide skill \"<name>\"`（fail-closed）」设计已废弃：它要求抛错只出现在**非 `agent/created`** 的路径上（见 5.2 的 fail-open 硬约束），而落地路径无法可靠区分，抛错落到 `onCreated` 的 catch 就会 fail-open ⇒ 一个 Skill 都关不上。
- 清单不完整（`snapshot().complete === false`，例如 watcher 启动失败）时，**不改变**当前生效状态，并记录警告；不把「不完整」当成「已关闭」。
- teardown：插件卸载时 `ctx.effect` 注销 `skills/change` / `tools/change` 订阅并清掉全部 Agent 状态；每个 Agent 结束时 `agent/disposed` 释放它的 shadow 与 restriction；disposer 调用统一包 `try/catch`，失败只记日志。
- 并发：插件内所有 Skill registry 操作、`restrict` 调用与策略文件读改写走同一条 promise 链；跨进程的读-改-写由 `withFileLock` 兜（见 3.6）。

---

## 6. 传输与 API

### 6.1 通道选型

采用官方 `ctx.connection.fetch.register`（`dsh-client-connection/lib/index.js:634`、`:679-695`）：

- 路由挂在共享的 `/api` Fetch 处理器上，**自动继承** launch token → 签名 cookie 的登录态，以及 Host/Origin 防 DNS-rebinding 闸门（同文件 `:640-652` 的 `requestRejection` / `admit`）。因此不需要自写 loopback 围栏、Origin 校验或配对凭据。
- 约束（`:814-818`）：`path` 必须在 `/api` 之下、路径段须匹配 `/^[A-Za-z0-9_$.-]+$/`、`methods` 非空且不重复、必须声明 `requestBody`（`'buffered' | 'streaming'`）。
- 重复注册同一路径抛错（`:686`）。
- `connection` 用**可选嵌套注入**（`ctx.inject(['connection'], c => …)`）。headless profile 里没有 `connection` 时，只运行策略、不注册路由，不报错。

### 6.2 路由表

统一前缀 `/api/skill-scope/`，全部 `method: POST`（GET 无请求体，无法携带 `sessionId`），响应统一 `cache-control: no-store`，信封统一：

```
成功：{ "ok": true, "value": … }
失败：{ "ok": false, "error": { "code": string, "message": string } }
```

| 路由 | 请求体 | 响应 `value` |
| --- | --- | --- |
| `POST /api/skill-scope/global` | `{ sessionId? }` | `{ policy, revision, inventory: { skills[], mcps[] } }` |
| `POST /api/skill-scope/global/save` | `{ mode, skills[], mcps[], revision? }` | `{ revision }` |
| `POST /api/skill-scope/workspace` | `{ sessionId }` | `{ cwd, policyPath, exists, policy, revision, inventory: { skills[], mcps[] } }` |
| `POST /api/skill-scope/workspace/save` | `{ sessionId, mode, skills[], mcps[], revision? }` | `{ revision }` |

**读路由不返回会话状态字段**。理由不是语义，而是**没有消费者**：7.3 的生效提示已改写为不随会话状态变化的固定文案，UI 从不读这两个字段，服务端也就没有必要计算它们。`/global` 仍接收可选 `sessionId`（影响工作区层求值），只是返回值与是否传 `sessionId` 无关。

错误码：`bad-request`（400）、`stale-revision`（409）、`unknown-session`（404）、`internal`（500）。上限：请求体 64 KiB，单数组 512 项。

**关于 405**：本插件**不实现** `method-not-allowed`（405）。依据 0.2.1 的分发器行为：共享处理器的路由匹配是 `route?.methods.has(request.method) === true`，不匹配时**根本不进我们的 handler**，而是落到 channel interceptor，未命中就返回 `404 not found`（`dsh-client-connection/lib/index.js:664-676`）。也就是说，只要路由只声明 `POST`，非 POST 请求在到达我们之前就已被处理成 404；要在自己的代码里返回 405，反而必须先声明一个我们不支持的方法再拒绝它，属于无谓的接口面。因此：**只声明 POST，不实现 405**。

### 6.3 会话解析

工作区两条路由按下列顺序解析 `sessionId`：

1. `ctx.get('sessionQuery').observeSession(sessionId, { projectionMode: 'none' })` 取 `header.cwd` 与 `projections.values.agentPreset`；observation 用后 `dispose`。
2. live Agent 优先：`ctx.get('agents').get(sessionId)`；取到就用 `agent.ctx.get('skills')`（读取时必须带 `scope: agent`，见 4.2）。
3. 取不到 live Agent（会话未处于活动状态）时，退化为全局 registry + `ctx.get('agentPresets').acquireScope(agentPreset)` 得到的 `scope` 只读展示，并标记该视图为「非实时」。

### 6.4 client 取数

浏览器侧用同源 `fetch('/api/skill-scope/<route>', { method: 'POST', headers: { 'content-type': 'application/json' }, body })`。

- 同源绝对路径 `/api/...` 在本机客户端里可用（宿主自身的客户端资源即如此）；若将来出现子路径部署（`<base href="./">`）导致绝对路径打不到，属于 Review Focus 里的独立风险项，与插件机制无关。
- 请求必须带超时（`AbortSignal.timeout`），失败时面板显示可重试的错误态。

---

## 7. UI 设计

保留两个入口，各管一层（用户选择 B 方案）。

### 7.1 全局面板（侧栏 → 原生中栏页）

- 注册点：`ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'skill-scope', order: 30, label }, Entry))` 与 `ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'skill-scope' }, Panel))`；导航用 `ctx.layout.selectPanel('skill-scope')`（未注册该 main key 时它抛错，`dsh-client-ui-layout/lib/client.js:468-469`），因此侧栏按钮只在 main 面板注册成功后才调用它。
- 结构：顶部**视图过滤器**（全部 / 已启用 / 已禁用）；两个分段 `Skills` 与 `MCP`，每段有搜索框与逐项开关；每个分段标题上带一个「启用量/总量」计数。
  - 两个分段**都没有**「全部启用」「全部禁用」批量按钮，也没有 `confirm` 弹窗（`confirm` 的唯一触发点随批量按钮一并消失）。若将来要加，那是新增功能，不是「补回缺失」。
  - 计数取**同一批可见行**（视图过滤与搜索之后）的 `启用数/总数`，分区标题与来源分组头共用一份实现（`src/client/parts.tsx` 的 `countText`）。写成 `2/2` 而不是只给总数 `2`，是为了让**被关掉的项在数字里仍然可见**；只给总数会让「关掉一项」在视觉上无迹可寻。分子按该行的**最终状态**算（三态求值结果），不是按「名字是否在黑名单里」。`data-testid` 为 `skill-count` / `mcp-count`（工作区弹层加 `ws-` 前缀）。
  - 该过滤器**只是前端列表谓词**（`PolicyView`，纯组件状态，不进策略文件、不触发保存）——它与「mode 选择器」的关键区别正在这里：模式切换会按模式重写名单，即一次有真实后果的策略写入。
- 列表只能操作清单里已出现的名字；无「按名称添加」入口。
- 列表字段：名称、描述（单行截断）、来源标记（`custom` / `user-dsh` / `user-agents` / `bundled`）、当前开关态。
- MCP 段里 loader-only server 显示为**只读行**（标注「未加载」），行内无开关。
- 标题明确写出语义：**「全局能力 · 与工程无关，对所有工作区生效」**。
- 写入后提示「已保存」。**不显示**「本会话首个回合生效 / 当前回合不受影响」这类按装配状态分支的提示：服务端不返回装配状态，界面也没有可分支的依据。

### 7.2 工作区入口（空白会话输入卡右侧 chip）

- 注册点：`ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'skill-scope-workspace', order: 30 }, Chip))`，仅当 `props.useSession(s => s.blank)` 时渲染；弹层用 `shell.overlay`（`ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'skill-scope-workspace-modal', order: 50 }, Modal))`）。
- 该槽位的标准 props 由 `dsh-client-ui-session` 的声明合并给出：`sessionId`、`useSession`（读 `SessionSnapshot.blank`）、`useProjection`（`dsh-client-ui-session/lib/types/client/index.d.ts:71-85`）。因此「空白会话才渲染」可以直接判 `blank`，不需要额外订阅服务。
- **该入口走 live 路径，不再是「只读非实时视图」**：空白会话**已经有** live Agent（探针 9 —— `session.create` 时就建 Agent），因此面板直接用 `agent.ctx` 取真实可见集（6.3 的 live 路径），不需要「非实时」标记。**仅当** `agents.get(sessionId)` 取不到 Agent（promote 尚在进行的窗口）时才退回 6.3 的退化路径（全局 registry + `agentPresets.acquireScope(preset)`），**那时**必须显示「非实时」标记。是否在非空白会话以只读形式保留入口，留待实施时决定。
- 结构：顶部为标题（含工程名）与一段说明；退化路径时另有「非实时」标记。两个分段 Skills / MCP；搜索、逐项开关。MCP 段顶部**不再有**「继承自全局」汇总行（2026-10-14 按用户要求删除），本作用域注册的 MCP 与继承来的 MCP 在视觉上不再区分。
  - 顶部**没有**「工程路径 · 已有策略/未创建，保存后创建」这一行；`cwd` 只在标题的工程名里出现。
  - 那段说明的**终态全文**为 `下面是未被全局禁用的项, 改动对本 workspace 新 session 生效，不影响已有 session`（2026-10-14 定稿）。它**不再**带任何「被全局关闭 N 项」计数。
- 被全局关闭的名字**不出现在列表里**：服务端把这些名字从 `inventory` 整条摘除，列表区没有任何可渲染的行，**UI 也不报关闭项数**（那个计数 2026-10-14 已删）。loader-only MCP server 仍作只读展示（`readonlyReason` 标注「未加载」）。
- 标题：**「本工程能力 · 只影响 <工程名>」**。

### 7.3 交互与文案要点

- 开关即保存，无需「提交」按钮；失败时回滚本地状态并提示。
- **回合边界生效是服务端行为，不依赖界面文案。** 界面**不显示**生效提示：没有对比对象时它是噪声，服务端也不返回装配状态。本条只保留行为要求（3.7、不变量 20）。
- 工作区面板的「非实时」标记与 6.3 的实际取数路径一致，不得在无 live Agent 时声称实时。**空白会话不触发这条**。
- 面板不做内容缓存，重新挂载即重新取数。
- **面板内没有需要二次确认的动作**（`src/` 下不存在任何 `confirm` 引用）。逐项开关是唯一写入口，它在**两个方向上都可逆**（关掉 = 名字进名单，打开 = 移出名单），且每次只影响一项、保存失败时前端回滚，因此不需要二次确认。将来若增加破坏性动作，需**重新引入**确认机制——不要假定它还在。
- 工作区弹层列出**完整清单**（与全局面板同一份来源），全局关闭的项也在其中、开关为关。三态（3.1）要求如此：若把全局关闭项从列表里摘掉，用户在工程里就**没有入口**把这项打开 —— 那是「一排按不动的死按钮」的反面，同样不能用。
  - 历史与教训：v1.5~v1.9 期间这些名字被服务端整条摘除（`composeWorkspaceSkills` + `withoutClosed`），顶部文案写「下面是未被全局禁用的项」。当时它与「工程层不能打开全局关闭项」这条规则**自洽**，所以不是缺陷；三态落地后两者必须一起改，只改一边就会出现不一致。（同类教训见 13.7：只在工作区关闭、全局放行的项曾「彻底消失，用户既看不见、也没有入口重新打开」。）
  - **仍然不显示任何计数**：不出现「另有 N 项被全局关闭」这类内部记账（`data-testid="globally-closed"` 必须不存在）。完整清单 ≠ 把记账摊给用户看。
  - 跨层差异标记只有一件事：**这一项与全局的当前状态不同**。同向（跟随全局）不标。标记是红色 `Tag`，文案「与全局不同」，`title` 同位；红色表达的是「这与全局不一样」，不表示错误。状态本身仍由开关位置表达（开关开 = 全局关着而你在本工程打开了它），因此色弱用户不依赖颜色也能读懂。
  - 「明令打开」与「明令关闭」不各配一种颜色：那会引入第三个视觉通道去说一件开关位置已经说清的事。
- 保存请求体只发 `workspace` 表（`{skills:{…},mcps:{…}}`）与 `revision`，不发 `mode`、不发 `sessionId` 之外的派生字段；响应是完整视图，客户端**只合并 `revision` 与 `workspace`**，不整体替换（`exists` / `cwd` 是写盘前采集的旧值）。
- 测试里「不标红」的断言必须配一条「真的改过就要标红」的正向用例，否则在完全没有标记实现时它也会通过。

- 面板不展示 Skill 正文；不提供任何文件写入口。

---

## 8. 工程形态

### 8.1 包元数据与兼容性声明

| 项 | 值 |
| --- | --- |
| 包名 | `dsh-skill-scope`（与仓库同名） |
| 许可 | MIT |
| 模块形态 | `type: "module"`，`exports`: `.` → `lib/index.js`，`./client` → `lib/client.js` |
| engines | `node: "^22.19.0 || >=24.0.0"`；`dsh: ">=0.2.0-rc.2"`（见 13.8 与 13.9：v1.7 那条「engines.dsh 无消费者」的结论已被源码证伪；区间在 v1.9 放宽） |
| 兼容性 | **`engines.dsh`（本版本起采用）** 与 **`peerDependencies` 里的 `@deepseek-ai/dsh-*` 区间**都是被消费的机制，由 `dsh-app-boot` 的 `evaluatePluginCompatibility` 判定。**二者不是并存关系：一旦声明 `engines.dsh`，它单独决定，`peerDependencies` 里的 dsh 项被完全忽略**（`dsh-app-boot/README.md:52`：「When the manifest declares `engines.dsh`, that range alone decides and `peerDependencies` are ignored.」）。`peerDependencies` 里**非 dsh 的项**（`@deepseek-ai/cordis`、`react`）不受影响，仍照常生效。不存在的 `dsh.engines.dsh` / `dsh.compatibility.dshReleases` 仍不采用。 |
| bundle | `dsh.bundle.patch` → `./cordis.patch.yml`（`insert` 一行 `dsh-skill-scope`） |
| client | `dsh.client = { platform: 'web', inject: [...包名图...], external: ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-runtime/client'] }`（字段语义见 `@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts:75-92`：`inject` 只是信息性包名依赖，**不是** cordis 服务注入；`external` 是「client baseline 之外的精确模块请求」，含 `<pkg>/client` 这类子路径，未声明即运行期失败） |
| 不采用 | `dsh.dynamic`（那是某个插件开发回路的私有约定，官方 `dsh-client-modules` 不读，因此不是可用契约） |

### 8.2 client bundle 契约

client 半必须精确复刻官方输出形态，否则宿主会抛 `client-modules: bundle … loaded without registering "…" via __ModuleLoader__.load`：

```js
window.__ModuleLoader__.load({
  id: "dsh-skill-scope",
  factory: (require) => { var module = { exports: {} }; var exports = module.exports;
    /* body */
    exports.apply = apply; exports.inject = inject; return module.exports; } });
```

- `entryFileNames: 'client.js'`，format CJS，platform browser，`dts: false`，`clean: false`。
- neverBundle：`react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-primitives` / `@deepseek-ai/dsh-client-runtime/client`；其余（含 zod）内联。**neverBundle 集合与 `package.json` 的 `dsh.client.external` 必须一致**：与宿主模块表共享的包写成 external，不上表的包（含 zod）必须内联，否则运行期取不到。
- 官方 `packages/client/tsdown.client.ts` preset **不随包发布**，所以仓库外必须自己复刻上述 banner/intro/footer。
- `require('react')` 得到宿主单例；官方 `@deepseek-ai/dsh-client-ui-primitives` 在默认白名单里，**直接 require**，不要写成 external。
- client bundle 内 `export const inject = ['slots','layout','locale']` 是 **cordis 服务名**，与 `package.json` 的 `dsh.client.inject`（包名图）是两件事。
- CSS：用 `.module.css` + 主题变量 `--dsw-*`，由构建注入 `<style data-plugin="dsh-skill-scope" data-plugin-css="dsh-skill-scope/styles.module.css">`。**两个属性都要写**：宿主 `window.__ModuleLoader__` 卸载模块时按 `style[data-plugin=<id>]` 找到元素、再用其 `data-plugin-css` 判定归属（`dsh-client-modules/lib/client.js:499`）；首方样板见 `dsh-client-ui-chat/lib/client.js:1383-1389`（`tag.dataset.plugin = '<pkg>'; tag.dataset.pluginCss = '<pkg>/X.module.css'`）。
- 槽位注册必须走官方两段式 `ctx.slots.inject(key, () => ctx.slots.register({...}, Component))`（首方先例：`dsh-client-ui-chat`、`dsh-client-ui-layout`、`dsh-client-ui-session` 均为该写法）；`register` 做装载期校验并可抛出，卸载级联由它自己管理。
- client 半边的官方参考文档是**运行时内置**的：宿主 `cordis_inspect` 暴露 `clientApi()/clientSlots()/clientSlot('sidebar.panellist')/clientEvents()/clientTypes()` 查询面（`dsh-cordis-client-runner/lib/client.js`，`CLIENT_SLOT_API` 表在 `:2412-6460`）；据此可核对每个槽位的 kind/props/occupantKind，不必依赖任何第三方产物。
- i18n：`ctx.locale.register(ns, {zh, en})` 必须写在 `ctx.effect` 内，否则卸载不注销。

### 8.3 依赖

| 类型 | 包 |
| --- | --- |
| dependencies | `zod`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-atomic-write`（`writeFileAtomic` 负责原子替换、`withFileLock` 覆盖跨进程读-改-写；写入是宿主侧 `node:fs`，**不**走 `ctx.get('fs')`，见 3.6） |
| dependencies（放弃的方案） | 不引入 `ctx.storage`：持久领域机制按 0.2.1 只服务首方（`workspace`/`session-projection-cache`/`schedule`），第三方 0 先例。理由见 3.8 |
| peerDependencies | `@deepseek-ai/cordis`、`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-host-webserver`（区间按基准版本），以及 `react` |
| devDependencies | `tsdown`、`lightningcss`、`typescript`、`vitest`、`@vitest/coverage-v8`、`jsdom`、`@testing-library/react`、`@testing-library/user-event`、`@types/node`、`@types/react`、`@types/react-dom`、`react`、`react-dom`（与实施计划的依赖白名单一致） |

### 8.4 脚本

| 脚本 | 命令 |
| --- | --- |
| `build` | `tsdown` |
| `typecheck` | `tsc --noEmit` |
| `test` | `vitest run` |
| `check` | `typecheck && build && test` |
| `deploy` | `build && dsh plugin --profile skilldev add .` |

### 8.5 开发与部署

- 开发用独立 profile：`dsh --profile skilldev --from-default-profile web`，再 `dsh plugin --profile skilldev add .`；不拿现有 `web` profile 当试验田。
- 动态热测走独立 profile 的插件开发回路。
- 上线（由用户执行，本插件不改 profile）：`dsh plugin --profile web add .`，并确认 `web` profile 的 bundles 中没有其他插件同时读写 `.dsh-scope.json`（3.5 记录了并发写者边界）。
- 策略文件格式与路径不变，因此无需迁移数据，但同一时刻只应有一个写者。

---

## 9. 不变量清单（可测）

1. 策略按名称取值，与 Skill 来源无关。
2. 全局层先于工作区层求值；**工作区层可以启用被全局关闭的名字**，也可以关闭被全局启用的名字。两层的唯一关系是：工程层表里没有的名字按全局的值定。
3. 工作区层的存储是逐项表（`名字 → 布尔`），**没有 `mode`**；「跟随全局」只能由「表里没有这个键」表达，不得写一个与全局相同的值来表达（保存时同向条目会被剔除）。
4. 全局面板只列 `snapshot({})` 的条目（无 `cwd`、无 `scope`），因此不含任何工程 Skill。
5. 工作区面板只列 live Agent 作用域视图，**读取必须显式传 `scope: agent`**（省略即退化为仅 global 层），只呈现 `modelInvocable === true` 的条目。
6. 面板不提供任何文件写入口；只写两个策略文件。
7. 隐藏 Skill 时只改 `modelInvocable`；`userInvocable` 保持原值；`content` 与 `path` / `whenToUse` / `resourceBase` 原值透传（漏复制不会被校验拦住）。
8. shadow 更新前必须先释放上一轮同层注册，再注册新的。同层重名是 **first-wins + 无效 disposer**（`dsh-skill/lib/index.js:196-201`），所以顺序写反就只剩告警噪声。
9. 隐藏后必须用一次全新 snapshot 复验（`verifyStillVisible: true`，生产路径已启用）；**复验失败只记警告并保留其余生效项，不回滚、不抛错**。
10. 读清单不完整（`complete === false`）时不改变当前生效状态。
11. restriction 每次隐藏集变化都重建（不得依赖替换语义，`tools.restrict` 的语义是追加求交）；deny 集先与 `view(scope).restrictableNames` 取交集；隐藏集 key 未变时**不写 restriction**（`tools/change` 是全局未过滤通知，写成循环会自激）。
12. 无 `connection` 服务时插件正常工作、不注册路由、不报错。
13. 无 live Agent 时工作区路由返回只读视图，不抛错，并标记为非实时。
14. `revision` 不匹配时拒绝保存并回 `409`，不写入。
15. 插件卸载与 `agent/disposed` 后不留 shadow 与 restriction。
16. 所有策略文件写入是原子的，且不会在解析失败时覆盖原文件。
17. 收窄面在**该 Agent 创建时（`agent/created`）**首次落地；此后本会话内每次保存都重新落地（回合边界生效，见不变量 18）。`agent/created` 监听器**绝不抛错**（抛错会让会话创建失败），任何异常都降级为「本会话按空策略运行」。
18. 策略在**回合边界**生效：保存后对活跃 Agent 重新落地，从该会话**下一回合**的装配起生效；**当前回合不受影响**。空白会话的「下一回合」就是它的**首个回合**，所以 §7.2 的用法成立。空白会话在 `session.create` 时就已有 live Agent（探针 9）。
19. 清单变化时按**当时最新读到的策略**重算隐藏集：策略**不冻结**（每次触发都重读全局与工作区策略、重新求值后 `reground`），清单也不冻结（差分维护；Skill 侧与 MCP 侧各自的 key 未变时不动）。
20. 策略保存一律在**回合边界**生效：当前回合不受影响，下一次装配起生效（3.7）。**这是服务端行为，不依赖界面文案**：面板不显示任何生效提示（没有对比对象时是噪声），两条读路由也不返回会话状态字段。
21. 面板只操作清单中已出现的名字，无任何按名称写入的入口。
22. loader-only MCP server 不进 deny 集，只在 UI 只读展示。
23. Skill shadow 按**最新策略**与实际可见集合**差分**更新（集合未变则不动）；MCP restriction 按隐藏集 key 比较决定是否重建。
24. 工作区面板的「非实时」标记由**数据来源**驱动（`live` 标志）：无 live Agent 时不得声称是实时视图。**空白会话不属于这一情形**，它已有 live Agent、走实时路径；该标记只用于 `agents.get(sessionId)` 取不到 Agent 的窗口，例如 promote 尚在进行中。
25. 策略文件的读写走宿主侧 `node:fs`：写入经 `writeFileAtomic(file, text, { mode: 0o600 })`，跨进程读-改-写经 `withFileLock`。**不得**经 `ctx.get('fs')` 写 `$DSH_HOME` —— 该服务的沙箱围栏按目标路径判定，`$DSH_HOME` 不在可写根内，必然失败（探针 6 实测；见 3.6）。
26. 只有 global 层与祖先层（含 preset 作用域）的工具可被 `restrict`；直接注册在 Agent **自带层**上的工具不进 `restrictableNames`，因此**在工作区面板里只读、不提供开关**。实例：ACP 每会话挂载的 MCP（`dsh-acp/lib/index.js:216-218`）、子 Agent 的结构化输出工具（`dsh-subagent/lib/index.js:914`）。**可收窄性必须逐名探测**（读 `restrictableNames`），不得按插件类型推断。

    本插件**不实现** `guard` 降级：对这类工具它只是不给开关，不做任何调用拦截。`dsh-tools` 确实支持经 `agent.ctx` 注册只作用于该 Agent 的 `guard`（`dsh-tools/lib/index.js:2909-2917`），但本插件未使用它。

27. 三态的求值公式唯一：`isOpen(name) = 工程层表里有 name ? 表里的值 : 全局是否启用(name)`。服务端（`src/policy/evaluate.ts` 的 `openResolver`）与客户端（`WorkspaceModal` 的取值闭包）必须逐字同构；界面的「与全局不同」标记当且仅当「表里有这个键且值与全局当前状态不同」。旧格式（`default.skills[]`）读入时每个名字视为 `false`，`mode` 丢弃。

---

## 10. 验证探针与风险

| # | 探针 | 通过标准 | 失败对策 |
| --- | --- | --- | --- |
| 1 ✅ | Agent 层 shadow 能否压住 preset 层与全局层同名 Skill | **模型收到的技能目录消息里不出现该名字**（即 `agent/pre-step` 注入消息不含它，对应 `dsh-tool-skill/lib/index.js:943` 的 `snapshot().skills.filter(isModelInvocable)`），**且** skill 工具调用抛错（同文件 `:873`、`:876`） | 改用 preset 作用域注册面（`agentPresets` 提供的 scope），或降级为「只支持关闭全局层技能」并记入文档 |
| 2 ✅ | `agent/created` 里落地的 restriction 是否**早于该 Agent 的首次装配** | 首次请求的 tool schema 列表已无被禁 MCP 工具（`request/header.tools`，`dsh-agent-loop/lib/index.js:1285`）；且 `agent/created` 的 serial 等待确实覆盖本插件的异步注册（`dsh-agent/lib/index.js:579`） | 退到官方专家通道：在 `system-prompt/assemble` 返回替换后的 `assembly`（`PromptAssembly.tools`），或接受延迟一格并在 UI 明示 |
| 3 未跑 | 手工复刻的 client bundle 能否被宿主消费 | 页面出现侧栏入口与 chip，无 `__ModuleLoader__` 报错（`client-modules: bundle … loaded without registering`），且 `<style data-plugin="dsh-skill-scope" data-plugin-css=…>` 已注入 | 逐项比对 banner/intro/footer 与 id |
| 4 ✅ | `snapshot({})` 是否真的不含工程 Skill | 在含 `.dsh/skills` 的工程里，全局面板不出现该 Skill | 回退到「显式传一个中性 cwd」或自建扫描 |
| 5 🔶 部分 | 无 `connection` 的 headless profile 启动 | 插件装配成功，策略仍生效 | 把 `connection` 从「可选」改为「必需」并调整 peer 声明 |
| 6 ⚠️ 已测 | 0.2.1 下策略文件写入是否仍需要宿主 sandbox 策略 | 四种组合（带/不带策略 × 工作区内/`$DSH_HOME`）的结果都可观测 | **已测，原假设不成立**：工作区内两种写法都成功；`$DSH_HOME` 下两种写法都 `FS_SANDBOX_DENIED` —— 策略参数**不影响**结果，围栏只按目标路径判定。裁决：两个候选口径都不用，改为宿主侧 `node:fs` 写入（见 3.6）。证据见 `docs/dsh-runtime-facts.md` §1 |
| 7 ✅ 通过（方向相反） | 作用域内 MCP 是否真的出现在 `schemas(agent)` 里，且落在哪一层 | 装一个按工程根挂 MCP 的插件（如 `dsh-plugin-codegraph-project`），工作区面板出现该 server 并**报告它的注册层**；全局面板不出现 | **未触发，且方向相反**：codegraph 的工具在**根 ctx** 注册 ⇒ GLOBAL 层 ⇒ **可** `restrict`，因此**不降级**。但结论要写成「按注册层判定、逐名探测」而不是「MCP 一律可关」——own 层注册确实存在于平台上（ACP 每会话挂载、子 Agent 结构化输出工具），本插件对这种情形只是不给开关，不做拦截 |
| 8 ✅ | 有没有「工具在该会话首次装配之后才注册」的窗口（异步连接器） | 用一个延迟注册 MCP 工具的探针，观察 `tools/change` 到达后下一次请求是否已收窄；若收窄，记录延迟量 | 接受延迟一格并在 UI 明示，或启用 5.2 的专家逃生口（补偿一次 `PromptAssembly` 替换） |
| 9 ❌ 证伪 | `agent/created` 时刻 `agent.session.header.cwd` 是否必定可用、且空白会话的 Agent 确实在首次发送时才创建 | 空白会话里保存策略 → 发送 → 首次请求的清单已按新策略收窄；未发送时工作区路由仍走 6.3 的退化路径 | **已触发**：Agent 确实在编辑前就已创建（`session.create` 就建），且 `agents.list()` 可枚举活跃 Agent。**不采纳**原文的「改为新会话生效」——那会让 §7.2 的 chip 对**它自己那个会话**失效，主用法作废。改判为 3.7 的**回合边界生效**（保存即重新落地，下一回合装配起生效；空白会话即首个回合） |
| 10 ✅ | Skill 集合的**变更驱动**差分是否覆盖所有来源 | 运行中新建一个被冻结策略关闭的 Skill / 启停一个 plugin → 集合变化后下一次请求前已生效；且 `skills/change` 监听器抛错不影响宿主（官方口径：失败被记录与隔离） | 保留一条每步兜底比较（成本低），或改用「下一个 `agent/inbox/claimed` 时补一次 snapshot」 |

**上表的触发情况**：10 条探针里只有 3 条的失败对策需要动设计 —— 6（已裁：改宿主侧 `node:fs` 写入）、7（**方向相反**的修正：不降级，改为逐名探测）、9（**证伪**：改「回合边界生效」）。1/2/3/4/5/8/10 的失败对策**均未触发**：探针 1 的通过标准（目录消息不含该名字 **且** skill 工具调用抛错）已**同时**成立；探针 2 的「退到装配瀑布」不需要；探针 8 的延迟窗口只表现为「边界 = 下一次装配」，不需要补偿；探针 10 的 `skills/change` 驱动已足够，不需要 `agent/inbox/claimed` 兜底。探针 3（手工复刻 client bundle 能否被宿主消费）本轮**未跑**，是本设计唯一没有实测支撑的探针。

其他风险：

- **MCP 名字解析**：`mcp__<server>__<raw>` 必须**去掉前导 `mcp__` 后取到下一个 `__` 之前**；写成「第一个 `__` 之前」会得到 `mcp`。若 `serverName` 含 `__`（官方正则 `^[A-Za-z0-9_-]{1,32}$` 禁止），解析会偏——用 loader 行做交叉校验。
- **`schemas()` 规模**：MCP 工具多时每次重读清单都要分组；结果按隐藏集 key 缓存，只在变化时重算。
- **多会话并发保存**：同进程串行化 + revision 检查覆盖。
- **符号链接 Skill**：可列出、可启停；本插件不做文件操作，所以「原子改写会替换符号链接」的风险不存在。
- **不再有「装配重跑」代价**：注入点移到装配之前，因此不再重跑 `assemble()`、不再让其他插件的 assemble 监听器跑两遍。新代价是注入时机必须早于装配（探针 8）。
- **跨插件同层「先到先得」导致个别 Skill 关不掉**。
  `dsh-skill` 的 `register()` 在**同一层**遇到重名时**静默丢弃后来者**，只记一条 warning，并返回 no-op disposer：

  ```js
  // <PKG>/@deepseek-ai/dsh-skill/lib/index.js:195-198
  const existingLayer = scope === void 0 ? this.layers.global : this.layers.peek(scope)
  if (existingLayer !== void 0 && existingLayer.runtime.has(skill.name)) {
    this.ctx.logger.warn(`runtime skill "${skill.name}" ignored because it is already registered`)
    return () => {}
  }
  ```

  若**别的插件**在本插件之前把同名 Skill 注册进**同一个 Agent 层**（`agent.ctx.get('skills')`），本插件的遮蔽副本就会被丢弃，该 Skill 关不掉。

  **实测案例**：`browser-skill` 由本机一个第三方插件注册，它在自身的 `agent/created` 里**同步**注册进 Agent 层；本插件同在该事件里注册但要先 `await` 读两层策略，必然落后 ⇒ 该 Skill 始终关不掉。

  **这不是本插件引入的回归**：该重名竞争此前同样漏掉它。历史会话 `session-c95beb02-588d-40bc-a7a7-23c6629dc3ff`（2026-10-13 14:01）的注入目录为 `count 1 ['browser-skill']` —— 当时策略几乎全关，唯独它存活。

  **缓解手段与否决方案**：用「每轮 `agent/pre-step` 先撕后贴 + 回读复验 + 失败抛错」硬碰的代价是每轮 `revision += 2N`、`collectCache.clear()`（`dsh-skill/lib/index.js:376-380`）——**与 prompt cache 直接冲突**，且如上所述**并未真正解决该案例**。本插件**不采用**每轮重装；`applySkillShadow` 提供 `verifyStillVisible` 复验开关（判据为读回的 `invocation.modelInvocable !== false`，正确处理「遮蔽后名字仍在清单里、只是标记变了」这一事实），**生产路径已传 `verifyStillVisible: true`**（`src/agent/hooks.ts` 的落地调用点）。复验失败的语义是**只记 warning 并保留其余生效项**，**不回滚、不抛错** —— 早先的「回滚 + 抛错」设计会落到 `onCreated` 的 catch 即 fail-open ⇒ **一个 Skill 都关不上**，比「少关一个」严重得多，所以已废弃。

---

## 11. 未决问题

1. 工作区面板是否需要「本工程策略与全局面板联动打开」的跳转（当前设计为各自独立）。

已定（不再开放）：只做启停控制；**关闭 = 只对模型不可见（`modelInvocable: false`），保留 `/name` 手动调用**（用户 2026-10-12 决策，见 1.2/5.1）；清单两层分工（全局只列全局可见项）；全局面板无「按名称添加」入口；策略**创建时落地、回合边界生效**；**不做「同一回合内立即生效」**，因为那会让模型看到的工具列表在本回合中途改变；包名为 `dsh-skill-scope`（2026-10-15 由 `dsh-skill-manager` 更名，原因是 npm 上已有一个同名但功能不同的包）；全局策略用 `$DSH_HOME` 下的自有 JSON（见 3.8）。

---

## 12. 参考

包根（下称 `<PKG>`）：`~/Library/pnpm/global/v11/5bd1-18dcdf5fdc96fa80-0/node_modules/.pnpm/<storeDir>/node_modules/@deepseek-ai/<name>`；已安装的第三方插件在 `~/.dsh/profiles/web/node_modules/`。

| 结论 | 引用 |
| --- | --- |
| Skill 读取时最近层同名胜出 | `<PKG>/dsh-skill/lib/index.js:114` |
| `registerProvider` 原子注册、同层重名抛错 | `<PKG>/dsh-skill/lib/index.js:147-178` |
| `register()` 用 `scopeOf(this.ctx)` 落层、同层重名只告警 | `<PKG>/dsh-skill/lib/index.js:193-215` |
| `snapshot()` / `list()` 签名与 `SkillViewOptions.scope` | `<PKG>/dsh-skill/lib/index.js:219-236` |
| **读取可见层只由显式 `options.scope` 决定**（`[global, ...chainLayers(scope)]`） | `<PKG>/dsh-skill/lib/index.js:299` |
| `chainLayers(undefined)` 为空链（「undefined for the global view」） | `<PKG>/dsh-scope/lib/index.js:162-169`、`:173` |
| `snapshot()` / `toSummary()` 不返回 `content`；`get()` 才取全量 | `<PKG>/dsh-skill/lib/index.js:234-240`、`:250-264`、`:491-503` |
| Skill 注册校验（名称、非空 description、invocation；**不校验 content**） | `<PKG>/dsh-skill/lib/index.js:465-469`（`validateRuntimeSkill`） |
| `restrict(filter)` 语义：相交、只过滤继承层、未知名字抛错 | `<PKG>/dsh-tools/lib/index.js:2893-2908` |
| `guard`：普通 ctx 注册全局生效，**经 `agent.ctx` 注册只对该 agent 生效**（own 层工具的降级路） | `<PKG>/dsh-tools/lib/index.js:2909-2917` |
| `guardReason(exec)` 先查全局层、再按作用域链**从最远祖先到本层**逐层查 | `<PKG>/dsh-tools/lib/index.js:2925-2931` |
| preset 移入 agent 平面后成为 **ANCESTOR** 贡献（所以 preset 的 MCP 可 restrict） | `<PKG>/dsh-tools/lib/index.js:2948-2952` |
| `view(scope)`：`:2960` 继承面起点 global、`:2962` `if (layer === own) continue;`、`:2969-2971` 继承面进 `knownNames`+`restrictableNames`+`visible`、`:2973-2975` **own 层只进 `knownNames`+`visible`** | `<PKG>/dsh-tools/lib/index.js:2957-2978` |
| `schemas(scope)`：`@param scope - the viewing scope (the agent); omitted = the global view` | `<PKG>/dsh-tools/lib/index.js:3015-3022` |
| **`assemble()` 先收工具、最后广播 `system-prompt/assemble`** | `<PKG>/dsh-system-prompt/lib/index.js:362-372`、`:388` |
| `assembleContextFor` 返回 `{agent, scope: agent}` | `<PKG>/dsh-agent/lib/index.js:291-297` |
| `agent/created` 派发点 | `<PKG>/dsh-agent/lib/index.js:579` |
| 官方 `system-prompt/assemble` 监听器范例（带副作用，会被重跑两遍） | `<PKG>/dsh-agent/lib/index.js:167` |
| 模型可见的技能目录是 `agent/pre-step` 注入的 user 消息 | `<PKG>/dsh-tool-skill/lib/index.js:929-970`（`:943` 过滤 `isModelInvocable`；`:873`/`:876` 工具调用校验） |
| UI 斜杠菜单按 `isUserInvocable` 过滤 | `<PKG>/dsh-api-session-controller/lib/index.js:2320-2330` |
| `publicToolName` 截断 + 12 位 hash，仍保留 `mcp__<server>__` 前缀 | `<PKG>/dsh-mcp-client/lib/index.js:96-101` |
| agent-scoped MCP 可存在；`SERVER_NAME_PATTERN` | `<PKG>/dsh-mcp-client/lib/index.js:767-772`、`:769` |
| per-project MCP 的**连接**先例（注意 `pool.js` 是**传输层客户端池**，每个 projectRoot 一个 `Client`、`:202` 发 `tools/list`，**不注册任何工具**） | `~/.dsh/profiles/web/node_modules/dsh-plugin-codegraph-project/lib/pool.js:88-89`、`:202` |
| codegraph 的工具注册点（**根 ctx**）与 per-session 路由 + 根 guard | `…/dsh-plugin-codegraph-project/lib/index.js:164`、`:165`、`:500`；`lib/agent-tools.js:233`、`:237`、`:248`、`:299`、`:383` |
| codegraph 注释「经 `agent.ctx` 挂 guard 在 DSH 不可达」不成立（反例：`agent.ctx.get('tools').restrict` 探针 2 实测成功；guard 见下行） | `…/dsh-plugin-codegraph-project/lib/agent-tools.js:362-369` |
| 作用域根解析：项目根只在有 `cwd` 时出现 | `<PKG>/dsh-skill-filesystem/lib/index.js:149-186`（`:151` 为 `cwd !== void 0` 判定） |
| `findProjectRoot` | `<PKG>/dsh-skill-filesystem/lib/index.js:810-815` |
| **own 层注册的工具确实对模型可见**（子 Agent 的结构化输出工具必须被调用） | `<PKG>/dsh-subagent/lib/index.js:914`（`childCtx.tools.register({`） |
| ACP 把每会话 MCP 挂进**未发布的 Agent 作用域**（own 层），且在 Agent 发布**之前**完成 | `<PKG>/dsh-acp/lib/index.js:212`（文档）、`:216`、`:218`、`:702`、`:721` |
| 空白会话已有 live Agent：`session.create` → `ensureSession` → `createOrAdopt` → `agents.create` | `<PKG>/dsh-api-session-controller/lib/index.js:688`、`:699`、`:414-418`、`:452` |
| 活跃 Agent 可枚举 | `<PKG>/dsh-agent/lib/types/index.d.ts:357`（`list()`）、`:365`（`roots()`） |
| `agent/created` 之前先 `agents.enter`（写入 store）再 `announce` | `<PKG>/dsh-agent-loop/lib/index.js:1791-1794`；`<PKG>/dsh-agent/lib/index.js:510-524`、`:579` |
| `turn/end` **不是**总线事件（是写进会话记录的条目，`ctx.on('turn/end')` 永不触发） | `<PKG>/dsh-agent-loop/lib/index.js:1029` |
| `tools/result` 是 emit（观察者安全，监听器失败被隔离）；`tools/pre-execute`/`execute`/`post-execute` 是 waterfall | `<PKG>/dsh-tools/lib/types/index.d.ts:47`、`:58`、`:70`、`:94`、`:102` |
| Agent 的 ctx 就是其作用域上下文 | `<PKG>/dsh-agent-loop/lib/index.js:778-779` |
| `createScope` / `scopeOf` 实现 | `<PKG>/dsh-scope/lib/index.js:293-314` |
| Agent 是自己的 scope key；`agent.id === session.id` | `<PKG>/dsh-agent/lib/index.js:230-232`、`:510-512` |
| `agent/disposed` 事件与 `ctx.agents.enter` | `<PKG>/dsh-agent/lib/types/runtime-types.d.ts:240`、`lib/types/index.d.ts:289-318` |
| `connection.fetch` 访问器与 `registerFetchRoute` | `<PKG>/dsh-client-connection/lib/index.js:634`、`:679-695` |
| Fetch 路由校验规则 | `<PKG>/dsh-client-connection/lib/index.js:814-818` |
| Host/Origin 与登录态闸门（`admit`） | `<PKG>/dsh-client-connection/lib/index.js:640-652` |
| 官方 `resolveDshHome` / `dshHomePath` | `<PKG>/dsh-home-paths/lib/types/index.d.ts:59,78` |
| 兼容性由 `engines.dsh` 或 peerDependencies 判定；**`engines.dsh` 优先且单独决定** | `<PKG>/dsh-app-boot/lib/index.js:279-299`（`unmetRequirements`：`:281-285` 是 `engines.dsh` 分支并**提前 return**，`:286-298` 才是 peer 回退分支）、`:301-304`（该函数的官方 JSDoc 明文：「An own `engines.dsh` range decides alone and peerDependencies are ignored」）、`<PKG>/dsh-app-boot/README.md:52`（规范性说明）、`<PKG>/dsh-package-manifest/lib/types/types.d.ts:54-64`（`DshEnginesManifest.dsh` 官方类型定义） |
| **官方 API 参考目录本身**（服务/事件/类型的权威描述文本） | `<PKG>/dsh-tool-cordis/lib/types/api-catalog.js`（`SERVICE_API` / `EVENT_API` / `TYPE_API`；宿主 `cordis_inspect` 暴露其查询面） |
| `skills.register` 的契约：borrowed readonly runtime skill；同层同名 **first-wins**，重复只告警并给 no-op disposer | 同上，服务 `skills` 的 `register` 描述；实现 `<PKG>/dsh-skill/lib/index.js:193-215` |
| `skills.snapshot`：不完整观察**不缓存**，消费者保留 last-good 并在下次请求边界重试 | 同上，服务 `skills` 的 `snapshot` 描述 |
| `skills/change`：**监听器抛错不影响注册结果**（顶层 failure 隔离/记录） | 同上，事件 `skills/change` 描述 |
| `tools.restrict` 官方契约：空过滤、未知名、**scope-local 名**、保留名都失败；限制只作用于调用者的 Agent 作用域；多个 restriction **相交** | 同上，服务 `tools` 的 `restrict` 描述；类型 `ToolRestriction`；实现 `<PKG>/dsh-tools/lib/index.js:2893-2907` |
| `tools/change` 是**未过滤**的注册表主题通知（scoped 监听器也会收到全局变化） | 同上，事件 `tools/change` 描述 |
| `agent/created` 是 serial 派发，**监听器抛错会让会话创建失败** | 同上，事件 `agent/created` 描述 |
| `agent/inbox/claimed`：「一条消息在其打开 turn 内离开 inbox」时发出 | 同上，事件 `agent/inbox/claimed` 描述；派发点 `<PKG>/dsh-agent-loop/lib/index.js:106` |
| `systemPrompt.refreshContext` **不重跑** sections / tools / variables 的 provider 与 waterfall | 同上，服务 `systemPrompt` 的 `refreshContext` 描述 |
| `PromptAssembly` 形状：`sections` / `contexts` / `tools` / `variables`（可整体替换） | 同上，类型 `PromptAssembly`；`<PKG>/dsh-system-prompt/lib/types/index.d.ts:27` |
| `SkillViewOptions` = `SkillLookupOptions` + `scope`；`SkillCatalogSnapshot = { skills, complete }` | 同上，类型 `SkillViewOptions` / `SkillCatalogSnapshot` |
| `SkillSummary.invocation` 是**必填**的 `SkillInvocationPolicy` | 同上，类型 `SkillSummary` / `SkillInvocationPolicy` |
| 官方客户端 API 参考的查询面（`clientApi()` / `clientSlots()` / `clientSlot(key)` / `clientEvents()` / `clientTypes()`）与其槽位表 | `<PKG>/dsh-cordis-client-runner/lib/client.js`（`CLIENT_SLOT_API` 表在 `:2412-6460`，`SERVICE_API`/`EVENT_API`/`TYPE_API` 在 `:1125-2412`） |
| 槽位注册的官方两段式 `ctx.slots.inject(key, () => ctx.slots.register({...}, Component))` | 首方先例：`<PKG>/dsh-client-ui-chat/lib/client.js`、`<PKG>/dsh-client-ui-layout/lib/client.js`、`<PKG>/dsh-client-ui-session/lib/client.js` |
| `conversation.input.right` 槽位的标准 props（`sessionId`、`useSession`、`useProjection`）来自 `dsh-client-ui-session` 的声明合并 | `<PKG>/dsh-client-ui-session/lib/types/client/index.d.ts:71-85` |
| `layout.selectPanel(id)` 在 main key 未注册时抛错 | `<PKG>/dsh-client-ui-layout/lib/client.js:468-469` |
| `DshClientManifest`：`platform` 必填；`inject` 是信息性包名；`immediately`；`external` = baseline 之外的精确模块请求（含 `<pkg>/client` 子路径） | `<PKG>/dsh-package-manifest/lib/types/types.d.ts:75-92` |
| 官方原子写 `writeFileAtomic`（`mode` 必填）与跨进程 `withFileLock`；**fsync 不在承诺内** | `<PKG>/dsh-atomic-write/lib/types/index.d.ts:2-16` |
| CSS 归属：按 `style[data-plugin=<id>]` 找元素、读其 `data-plugin-css` | `<PKG>/dsh-client-modules/lib/client.js:499`；首方样板 `<PKG>/dsh-client-ui-chat/lib/client.js:1383-1389` |
| `ConnectionFetchMethod = 'GET' | 'HEAD' | 'POST'`；`ConnectionRequestBodyMode = 'buffered' | 'streaming'` | `dsh-tool-cordis/lib/types/api-catalog.js`，类型 `ConnectionFetchMethod` / `ConnectionRequestBodyMode` |
| 连接分发器对未注册路径/方法**先回 404**（不会走到插件 handler） | `<PKG>/dsh-client-connection/lib/index.js:664-676` |

本机环境事实：DSH `0.2.1-alpha.2`；`~/.dsh/profiles/web` 已装 13 个第三方包；`cordis.patch.yml:430-431` 为 `skill-filesystem` 配了 `customSkillDirs`（`~/proj/sand/skills`、`~/node_modules/gbrain/skills`），这就是 4.1 里 `custom` 行的来源。

> 注意口径：本节的「13 个第三方包」与 3.5 的「12 个 `.dsh-scope.json`」是两件不同的事——前者是 `~/.dsh/profiles/web` 的已装依赖数，后者是本机工程目录里已存在的策略文件数。两者数值恰好相近，阅读时不要混用。

---

## 13. 修订记录

### 13.1 v1.1（历史，逐条核对 v1.0）

改动来源：逐条核对 v1.0；A/B/C 编号沿用审阅时的编号。此表保留为历史记录；其中已被 13.2 的 v1.2 修订取代的依据不再有效。

| 编号 | v1.0 位置 | 问题 | v1.1 修订 | 依据 |
| --- | --- | --- | --- | --- |
| A1 | 4.2（`snapshot({ cwd })`） | 读取作用域漏写 `scope: agent`，只会得到 global 层 | 改为 `snapshot({ cwd, scope: agent })`；补「为什么省略即退化」与「为什么必须经 `agent.ctx` 取服务」；同步修正不变量 5、6.3 | `dsh-skill/lib/index.js:299`；`dsh-scope/lib/index.js:162-169`、`:173` |
| A2 | 4.3、4.4 | 「全局 MCP 清单 = 工作区 MCP 清单」「0.2.1 无 per-workspace MCP 注册」是错误断言 | 撤回断言；工作区层改取 `schemas(agent)`，两层分列；作用域内 MCP 归工作区层；补 loader-only 只读；同步修正 7.2 | `dsh-mcp-client/lib/index.js:767-772`；`dsh-plugin-codegraph-project/lib/pool.js:139` |
| A3 | 4.3、5.2 | loader 行来源的 server 名进 `restrict({deny})` 必然抛「unknown global tool(s)」 | deny 先与 `restrictableNames` 取交集（或展开成真实工具名）；loader-only server 只读展示、不可关闭；新增不变量 22 与 7.1/7.2 UI 规则 | `dsh-tools/lib/index.js:2893-2907`、`:2957-2985` |
| A4 | 5.2、5.3 | 只说「必须重跑」，未说明原因、终止条件与代价；且两个时机（pre-step / assemble）未解释为何分开 | 补①为什么必须重跑 ②key 未变即 `next()` 的终止条件 ③其他插件 assemble 跑两遍的代价；补「Skill 在 pre-step 装、MCP 在 assemble 装」的机制差异；`agent/created` 提前落地列为可选简化（未决 3） | `dsh-system-prompt/lib/index.js:362-372`、`:388`；`dsh-tool-skill/lib/index.js:929-970`；`dsh-agent/lib/index.js:167`、`:579` |
| B1 | 1.2、5.1、不变量 7 | 「`userInvocable` 保留原值 ⇒ `/name` 不受影响」缺前置条件，会让实施者以为复制 `content` 不重要 | 写明必须先 `skills.get(name,{scope,cwd})` 取全量、字段原值透传、`content` 不被校验；把结论改为条件式；同步修正 1.2 与非目标表 | `dsh-skill/lib/index.js:234-240`、`:465-469`、`:491-503`；`dsh-api-session-controller/lib/index.js:2320-2330` |
| B2 | 5.1、10 | 探针 1 只看 `snapshot()` 的标志位，且 5.1 的「已实测确认」措辞越过事实 | 通过标准改为「模型收到的目录消息不含该名字 **且** skill 工具调用抛错」；5.1 结论标注「待验」 | `dsh-tool-skill/lib/index.js:943`、`:873`、`:876` |
| B3 | 4.1 | `custom` 行写「总是」 | 改为「宿主配了自定义目录时」，并给出本机来源 | `dsh-skill-filesystem/lib/index.js:149-186`；`cordis.patch.yml:430-431` |
| B4 | 4.3、10 | 「`serverName` 取第一个 `__` 之前」字面得到 `mcp` | 改为「去掉前导 `mcp__` 后取到下一个 `__` 之前」；补 `publicToolName` 截断仍保留前缀；补官方 serverName 正则 | `dsh-mcp-client/lib/index.js:96-101`、`:769` |
| C1 | 6.2、3.7 | `/global` 不返回 `locked`，与 7.3「两个面板都显示提示」和不变量 20 冲突 | `/global` 接收可选 `sessionId` 并返回 `locked` / `lockedAt`；3.7 明说两条路由都返回 | 内部一致性修正（无外部依据）。**v1.4 补**：`locked` 的含义随 3.7 改为「该会话已有过装配」，字段名不变。**v1.5 撤销**：两个字段整体删除，`/global` 仍接受 `sessionId` 但不再因它改变返回体 |
| C2 | 7.2 | chip 只在空白会话渲染，而空白会话没有 live Agent ⇒ 必然走只读退化路径，但文案要素里没有「非实时」标记 | 明说该入口默认呈现只读非实时视图，必须显示「非实时」标记；新增不变量 24 | 6.3 的退化范式（探针 9） |
| C2 撤回 | 7.2（按 13 节要求保留上一行原断言，不删历史） | 上一行的**前提**「空白会话没有 live Agent」已被探针 9 证伪 | **v1.4 撤回**：§7.2 的入口改回**实时视图**（直接用 `agent.ctx`），「非实时」标记只在 `live === false` 的退化情形出现；不变量 24 保留但触发条件改写。见 3.7、10 节探针 9、13.4 | `dsh-api-session-controller/lib/index.js:688`、`:699`、`:414-418`、`:452` |
| C3 | 11、12 | 「包名最终确认」与 8.1 重复；「13 个第三方包」易与「12 个 `.dsh-scope.json`」混读 | 包名移入「已定」；12 节加口径提示 | 内部一致性修正（无外部依据） |
| D1 | 3.6 | 只讲原子写与 0o600，没提宿主 sandbox 策略 | 补写入前取 `sandboxPolicy.resolve(...)`；0.2.1 下是否仍需要由探针 6 确认；新增不变量 25 | 探针 6（见 13.3） |
| D2 | 6.2 | 未规定非声明方法的响应 | 错误码补 `method-not-allowed`（405） | 内部一致性修正（无外部依据）。**v1.2 删除 405**，见 13.2 的 M6 |
| D3 | 5.1、4.2、5.3 | 缺少「为什么必须经 agent.ctx 取服务」「读取前查 `complete`」「Skill 每步重建」三项已验证做法 | 分别补入 4.2、4.2、5.3；新增不变量 23 | `dsh-skill/lib/index.js:299`；`dsh-scope/lib/index.js:162-173` |
| D4 | 5.2 | 未说明哪些层的工具**可以**被 restrict、哪些关不掉 | 补 `view(scope)` 的 `restrictableNames` 构成与 `own` 层恒可见规则；点明 preset 作用域 MCP 属祖先贡献、可 restrict，而 Agent 层直挂工具关不掉 | `dsh-tools/lib/index.js:2957-2985`、`:3015-3022`（doc 原文「omitted = the global view」） |

### 13.2 v1.2（复核：只以官方包为依据重写机制）

改动来源：全部结论回到已装官方包与服务/事件/类型的官方描述文本上（见 12 节）。M 为机制级修订编号。

| 编号 | 位置 | 问题 | v1.2 修订 | 依据 |
| --- | --- | --- | --- | --- |
| M1 | 5.1、5.3、不变量 8/23 | Skill shadow 用「每步先释放再重注册」实现，且注册点写在 `await next()` 之后 ⇒ 该步的目录消息已经生成，当步不生效（一格延迟）；每步重注册还会在同层重名时刷告警并拿到 no-op disposer | 改为**首次落地 + 差分维护**：`agent/created` 一次性落地，订阅 `skills/change`，集合或冻结策略变化才重建；注册对象仍是完整定义 + `invocation.modelInvocable: false` | `api-catalog.js` 服务 `skills.register` 与事件 `skills/change` 的描述；`<PKG>/dsh-skill/lib/index.js:196-201` |
| M2 | 5.2、5.3、不变量 11/17 | MCP restriction 在 `assemble` 内部注册并**重跑一次 `assemble()`**，用 key 守卫防重入；代价是其他插件的 assemble 工序同一次请求跑两遍 | 挂点改为**该 Agent 的 `agent/created`**（serial 等待，早于首次装配），删除重跑与 key 防重入；后续变化由 `tools/change` 维护；保留「变化时先释放上一轮再 restrict」与「key 未变不动」；`agent/created` 内一律 fail-open | `<PKG>/dsh-agent/lib/index.js:579`；`<PKG>/dsh-agent-loop/lib/index.js:907`、`:910`、`:925`；`api-catalog.js` 事件 `agent/created`/`tools/change` 与服务 `tools.restrict`、类型 `PromptAssembly` |
| M3 | 7.1、7.2 | 槽位用裸 `ctx.slots.register` | 改官方两段式 `ctx.slots.inject(key, () => ctx.slots.register({...}, Component))` | 首方先例三处；`<PKG>/dsh-client-ui-layout/lib/client.js:468-469` |
| M4 | 8.1、8.2 | 未声明 `dsh.client.external`；CSS 只写 `data-plugin` | 补 `external`（与 neverBundle 一致）；CSS 补 `data-plugin-css` 属性对 | `<PKG>/dsh-package-manifest/lib/types/types.d.ts:75-92`；`<PKG>/dsh-client-modules/lib/client.js:499` |
| M5（**已被 13.3 的 P1 推翻**） | 3.6、不变量 25 | 写入用自写 tmp+rename；把「取不到 sandboxPolicy 即失败」列为不变量 | 改用官方 `ctx.get('fs').writeText`（自带原子替换与 `FsWriteIntent` 陈旧性守卫；不自设权限位）+ `withFileLock` 覆盖跨进程读-改-写；sandbox 策略改为「能取到就带」；新增 3.8 存储选型 | `<PKG>/dsh-fs/lib/types/index.d.ts:211-221`、`<PKG>/dsh-fs/lib/types/types.d.ts:111-117`；`<PKG>/dsh-atomic-write/lib/types/index.d.ts:2-16` |
| M6 | 6.2 | 错误码含 `method-not-allowed`(405) | **删除 405**（宿主对未注册路径/方法先回 404，handler 不可达），错误码收敛为 `bad-request` / `stale-revision` / `unknown-session` / `internal` | `<PKG>/dsh-client-connection/lib/index.js:664-676` |
| M7 | 1.2、1.3、5.1、8.5、11 | 多处措辞缺少可核对的依据 | 换成官方依据或显式产品决策；「保留 `/name`」写成用户决策 | 用户 2026-10-12 决策；`<PKG>/dsh-api-session-controller/lib/index.js:2320-2330` |
| M8 | 12 | 参考表混入 9 行非官方依据 | 非官方行移出参考表；新增约 20 行官方 API 参考依据；正文声明只引用官方包 | 见 12 节 |

### 13.3 v1.3（计划 Task 2 的探针实测结论并入）

改动来源：实施计划 Task 2 的探针 4 / 5 / 6 在真实 headless profile 上跑通后的实测结论。证据见 `docs/dsh-runtime-facts.md`。P 为探针级修订编号。

| 编号 | 位置 | 探针结论 | v1.3 修订 | 依据 |
| --- | --- | --- | --- | --- |
| P1 | 3.6、不变量 25、8.3、10 | **探针 6 证伪 v1.2 的写入路径**：`ctx.get('fs').writeText` 在 `workspace-write` 下写 `$DSH_HOME` 必然抛 `FS_SANDBOX_DENIED`（原文 `cannot write "…": file access denied under workspace-write mode`），且传不传 `sandboxPolicy` 结果**完全相同** | 写入回退为宿主侧 `node:fs`：`withFileLock` 包住「读 → 比对内容哈希 → `writeFileAtomic(file, text, { mode: 0o600 })`」；`FsWriteIntent` / `FsVersion` / sandbox 策略参数整体作废；`revision` 改为 `sha256(content)`。不变量 25 重写 | `dsh-fs-sandbox/lib/index.js:157-166`（`checkedTarget`：围栏按**目标路径**判定）、`dsh-sandbox/lib/index.js:166-173`（`writableRoots` = `workspaceRoot` + `/tmp` + `tmpdir()`）；官方包先例 `dsh-plugin-manager`、`dsh-credentials-local` 均用 `node:fs` + `writeFileAtomic` + `withFileLock`；证据见 `docs/dsh-runtime-facts.md` §1 |
| P2 | 5.2（新增约束） | 探针事故反推：把「只观察」的监听器用 `ctx.on` 挂到 waterfall 事件上，会让宿主在 `step_start` 之前崩于 `Cannot read properties of undefined (reading 'contexts')` | 写进 5.2 的专家逃生口：任何挂在 `agent/pre-step` / `system-prompt/assemble` 上的监听器**必须**调用 `next()` 并把它的返回值原样透传（要改就在返回值上改）；「只看不改」没有豁免 | `@deepseek-ai/cordis/lib/index.js:258-264`（`dispatch` 不按 `type` 过滤监听器）与 `:307-325`（`waterfall` 文档：「不调用 `next()` 的监听器否决链的其余部分，包括内建行为」）；证据见 `docs/dsh-runtime-facts.md` §4 |
| P3 | 8.1（确认，设计无改动） | 探针 5 **通过**：无 `connection` 的 headless profile 能装配；但 `apply()` 时刻 `fs` / `skills` / `tools` / `agents` / `sandboxPolicy` **全部尚未就绪**（约 142 ms 后才就绪） | 维持 `inject = ['fs','skills','tools','agents']`；明确 `apply()` 里只能挂监听器与探测服务，不得直接读服务 | 证据见 `docs/dsh-runtime-facts.md` §6 |
| P4 | 4.1（确认，设计无改动） | 探针 4 **通过**：在带 `.dsh/skills/probe-demo` 的工程里，`snapshot({})` 不含该 Skill，`snapshot({ cwd })` 含它，双向差集干净 | 维持「全局层清单 = `snapshot({})`」；不需要中性 cwd，也不需要自建扫描，Task 7 的 `readGlobalSkills` 不改 | 证据见 `docs/dsh-runtime-facts.md` §7（`onlyScoped = ["probe-demo"]`、`onlyGlobal = []`、两侧 `complete` 均为 `true`）；根解析规则见 `dsh-skill-filesystem/lib/index.js:149-186`、`:810-817` |

### 13.4 v1.4（计划 Task 3 的六条探针结论并入）

改动来源：计划 Phase A 的 Task 3 六条探针（1/2/7/8/9/10）。探针 1/2/8/10 的通过标准**全部达成**，只有 7 与 9 需要动正文，另有 6 在 v1.3 已裁。逐条证据见 `docs/dsh-runtime-facts.md`。

| # | 探针 | v1.4 修订 | 依据 |
| --- | --- | --- | --- |
| P1 | Agent 层 shadow 能压住全局层同名 Skill | 通过，**不动正文**；§5.1 的「待验」改为已验。三条判定同时成立：Agent 层 `modelInvocable:false` 且全局视图未外溢、模型收到的目录消息不含该名字、`skill` 工具调用抛错 | findings §7；对照臂 `shadow-off` 的 `catalogMentionsProbeDemo:true` vs `shadow-on` 的 `false` |
| P2 | `agent/created` 落地早于首次装配 | 通过，**不动正文**；§5.2 的装配瀑布逃生口**不需要**启用（它只作为未触发时的预案保留） | findings §8；`restrict-created` 首次装配 `toolCount:24` vs 对照 `restrict-prestep` 的 `25` |
| P7 | 作用域内 MCP 的注册层 | **方向相反的修正**：v1.1–v1.3 用 `dsh-plugin-codegraph-project` 当「Agent 层注册、不可关」的例子是**错的** —— 它在**根 ctx** 注册（`lib/index.js:164`/`:500`、`lib/agent-tools.js:299`），落 GLOBAL 层，**可** `restrict`；`lib/index.js:268` 的 `agent.ctx` 只用于会话记账；`lib/pool.js` 更是纯传输池、不注册工具。因此 §4.3/§4.4/§5.2 的举例全部替换 | findings §13、§14；实测 `dsh-tools/lib/index.js:2957-2978`（`:2962` 排除 own 层、`:2973-2975` own 层只进 `visible`） |
| P7+ | 「Agent 自带层」这一类**存在真实实例** | **新增**：这类不是理论可能性。①ACP 每会话 MCP 挂进未发布的 Agent 作用域（`dsh-acp/lib/index.js:212`、`:216-218`、`:702`、`:721`）；②子 Agent 的结构化输出工具注册进 `childCtx` 且必须被模型调用（`dsh-subagent/lib/index.js:914`）。**同时**得出两条实现要求：可收窄性**逐名探测**（`view(scope).restrictableNames`，或 try/catch 解析 `names unknown global tool`）；不可收窄时退化到 **agent 作用域的 `guard`**（`dsh-tools/lib/index.js:2909-2917` 明说「经 `agent.ctx` 注册只对该 agent 生效」），并在 UI 如实告知「拦调用、不遮列表」 | findings §13、§14；`dsh-tools/lib/index.js:2909-2917`、`:2925-2931` |
| P8 | 「装配后才注册」的窗口 | 通过，**不动正文**：边界是「**下一次装配**」（第 1 次装配 25 个不含迟到工具、第 2 次 26 个含），不需要补偿 | findings §9 |
| P9 | 空白会话的 Agent 创建时机 | **证伪，语义修正**：空白会话**已有** live Agent（`session.create` → `dsh-api-session-controller/lib/index.js:699 ensureSession` → `:414-418` → `:452 agents.create`），且 `agents.list()` 可枚举。因此「会话内锁定」改为「**创建时落地 + 回合边界生效**」（§3.7、不变量 17/18/20）；§7.2 的 chip 恢复为**实时视图**（不再默认只读非实时）（v1.5：`locked` 字段已删除） | findings §12；`dsh-agent/lib/types/index.d.ts:357`、`:365` |
| P10 | 变更驱动是否覆盖所有来源 | 通过，**不动正文**：迟到写文件后 `skills/change` 到达，**下一个 `agent/pre-step`** 的快照已含它；监听器故意抛错被宿主隔离（`statuses:[]`、`agentErrors:[]`、`agent/turn-stopping` 仍到达） | findings §10；对照臂 `throw-on-change` |

**本版新增的一条环境事实（会误导实现）**：`turn/end` **不是** cordis 总线事件，而是 agent-loop 写进会话记录的条目（`dsh-agent-loop/lib/index.js:1029 this.session.append("turn/end", …)`），所以 `ctx.on('turn/end', …)` 永不触发；要观察回合结束应该用 `agent/turn-stopping`（`dsh-agent-loop/lib/index.js:1001`，serial）。同理，挂在 `agent/pre-step`、`system-prompt/assemble` 这些 **waterfall** 事件上的监听器必须 `await next()` 并原样返回结果，否则会否决整条链（v1.3 已记入 §5.2）。

**需要用户确认的一项（唯一）**：P9 的处置改动了用户在 2026-10-12 明确定为「刻意选择」的**会话内锁定**语义。改为「回合边界生效」的理由是：旧语义的前提（空白会话没有 live Agent）已被证伪，而按旧语义执行会得出「在空白会话的 chip 里改本工程策略，对它自己那个会话不生效」——§7.2 的主用法作废。**替代写法（若用户坚持旧语义）**：保守留「快照不可变」，即**不**对活跃 Agent 重新落地，并把 §7.1/§7.3 与 §7.2 的提示统一改成「修改在**新会话**生效」，同时删掉 §7.2 里「本会话即生效」的说法；代价是空白会话的 chip 变成「为下一个会话预设」，与 §7.2 的定位不符，需要在 UI 上改成「新建会话后生效」。

### 13.5 v1.5（删除白名单；模式选择器改为名单视图）

改动来源：用户 2026-10-13 决定删除白名单，并把面板顶部的「模式选择器」改为**名单视图**。

| 项 | v1.4 | v1.5 | 理由 |
| --- | --- | --- | --- |
| `PolicyMode` 合法取值 | `default` \| `blacklist` \| `whitelist` | `blacklist` | 白名单让同一个 `skills` 数组在不同模式下含义相反 |
| `whitelist` 的处置 | 一等语义 | 移除；读到按非法处理 + 迁移 warning | 见 §3.4 |
| `default` 的处置 | 一等语义（忽略列表） | **仅读取兼容**，归一到 `blacklist`（读侧与写侧同口径） | 磁盘上仍可能有本插件早期版本写下的 `"mode":"default"`；归一后「名单 = 要关掉的」在任何文件上都成立 |
| 面板顶部三按钮 | 模式选择器（`default`/`blacklist`/`whitelist`） | **视图过滤器**（全部 / 已启用 / 已禁用） | 旧按钮按下会**重写名单**（真实策略写入）；新按钮只做列表过滤，不触发保存 |
| 工作区层继承 | 全局为白名单时无法枚举「未出现的名字」，只能返回空集合（宁可多显示） | 缺口闭合：名单永远可枚举，`closedByGlobal` 直接返回名单 | 删除白名单的直接收益 |

**删除白名单修掉的具体缺口**：白名单下「被关掉的名字」= 补集，而补集在插件侧**不可枚举**
（清单不完整）。因此该模式只能返回空集合，工作区层面看到的是完整清单 —— 用户以为全局关闭
生效了，其实面板上一项都没少。黑名单下这个缺口不存在。

**未改动的部分**：求值顺序（全局 → 工作区、工作区不得复活全局项）、`hid` 键的计算、
路由面（仍四条）、落盘形状（仍 `{mode, skills, mcps}`）。

### 13.6 v1.6（2026-10-13 实机排查：四条缺陷，全部为实测证伪后落定）

改动来源：用户报「工作区启用了 skill，本会话看不到，要等新会话才生效」。排查在独立端口
（`probe1` profile / 3092）上做，每一步都先用探针量出事实再改代码。**四条独立缺陷**，
前三条各自都足以单独造成「本会话不生效」；第四条造成卡顿与「目录整个消失」。

| 编号 | 缺陷 | 症状 | 修法 | 依据 |
| --- | --- | --- | --- | --- |
| D1 | 订阅的事件名用**点号**（`skills.change` / `tools.change`），宿主发的是**斜杠**（`skills/change` / `tools/change`） | 清单变化后**永不**重新落地；Agent 创建后没有任何重算路径 | 改名 | `dsh-skill/lib/index.js:404`、`dsh-tools/lib/index.js:2688`；`cordis/lib/index.js:212-420`（`on()` 写 `_hooks[name]`、`dispatch()` 读同一键，**无归一化** ⇒ 点号名不报错也永不触发） |
| D2 | 策略保存后**没有任何东西触发重新落地** | 同一会话里改策略，只有新会话才生效（用户原始症状） | 保存成功后由路由**显式调用** `reapplyAfterSave`（`src/routes/handlers.ts` 两处） | 保存走 `Store` 的 `fs.writeFile`，不触碰 Skill/Tool 注册表 ⇒ **不发** `skills/change` / `tools/change`。设计 §5.3（本文档 `:187`）写明的「策略变化由保存驱动」这条边此前**没有实现** |
| D3 | 工作区路由解析会话时**重建**了 agent 对象（而非原样返回 `agents.get()` 的实例） | 面板里改了开关，本会话的 skill 列表**纹丝不动**；工作区层静默退化成未收窄的全局清单 | 只做只读校验，形状对就把原对象**原样返回** | `dsh-scope/lib/index.js:239` 的 `scopeParents` 是**以对象身份为键的 WeakMap**；`:243` 用 `scopeParents.set(key, parent)` 登记，`:278` 的 `scopeChainOf` 用 `scopeParents.get(cursor)` 走链；`:299` 以 live Agent 本体作 key（`dsh-agent-loop/lib/index.js:778` `createScope(loopCtx, this)`）。重建对象 ⇒ 身份不同 ⇒ 查不到父链 ⇒ `dsh-skill/lib/index.js:299` 的 `[global, ...chainLayers(scope)]` 只剩全局层 |
| D4 | 监听 `skills/change` 的同时，遮蔽落地又**发出** `skills/change` ⇒ 自反馈环 | ① 新建会话卡顿；② **第一条消息的 skill 目录整个消失** | 落地期间用计数守卫掐断重入（`src/agent/hooks.ts` 的 `applying`，`onCreated` 与 `onChange` 两路都要置位） | 链路：`scoped.register()`（`src/agent/skills.ts`）→ `dsh-skill/lib/index.js:209` `layers.effect` → `dsh-scope/lib/index.js:191` `notify = options.notify ?? true`（`dsh-skill` 未传）→ `:216` `this.onChange()` → `dsh-skill` 的失效回调（`:123`）→ `invalidateCache()` → `notifyChange()` → 回到本监听器 |

**D4 的量化（probe1 / 3092，一次会话创建）**：`onChange` 触发 **243** 次、遮蔽注册 **127** 次、
`onCreated` 耗时 **3576 ms**；其中 `applyRound` 只有 **1** 次 `keyChanged=true`，其余 138 次
都因 key 未变而空转 —— 说明这串爆发**全部**由环产生，与真实清单变化无关。

**D4 症状②的机制**：`collect()`（`dsh-skill/lib/index.js:266-296`）先记 `const revision = this.revision`，
`await collectFresh()` 之后再比对；不一致就重试，`MAX_COLLECT_ATTEMPTS = 2`（同文件 `:19`）
用尽仍不一致时返回 `cacheable: false` ⇒ `snapshot.complete = false`。宿主
`dsh-tool-skill/lib/index.js:944` 对不完整快照的处理是 `if (!snapshot.complete) return decision;`
—— **整块目录不注入**（全有或全无）。环在注册期间反复把 `revision` +1，第一条消息落在窗口内时
模型就拿到「一个 skill 都没有」。可控复现（8 秒窗口内每 5ms 快照一次）：修复前
`incomplete=39/648` 与 `incomplete=76/80`，修复后 **两轮均 `incomplete=0`**（1292 / 1257 次快照）。

**另修一处纯性能缺陷（不属上述四条）**：`applySkillShadow` 原为「取一个定义 → 注册一个」，
而 `register()` 会**无条件**调用 `invalidateCache()`（`dsh-skill/lib/index.js:377`：`revision += 1`
且 `collectCache.clear()`），`get()` 的收集缓存又**按 revision 做键**，于是每注册一个就让下一个
`get()` 必然缓存未命中、触发一次 `collectFresh()` 全量枚举。实测 127 个隐藏项逐个 `get()` 各约
22–25 ms，合计 **3495 ms / 2913 ms**。改为「先批量取定义、再统一注册」后，`get` 段降到
**34 ms / 28 ms**（约 100×），注册段 254 次合计 4 ms，`onCreated` 由 3588/3047 ms 降到
**126/154 ms**。

**验证**（3092 实机，非单测）：会话 `session-f5fbb334-b47b-409e-9d7f-fe5882e348f7`，
16:23:09 首次提问注入 **14** 条且含 `agent-reach`；把 `agent-reach` 加入工作区黑名单后，
16:24:07 同一会话的下一轮提问注入 **13** 条、`agent-reach` 消失 —— **同一会话、无重启**。

**D4 的取舍（有意为之）**：重入守卫会丢弃「落地期间到达的真实外部 `skills/change`」。
这是可接受的，因为落地结尾会重读清单并按 key 差分，结束时状态已是最新；放行它只会再触发
一轮同环。**未**采用「给 `dsh-skill` 的 `register()` 传 `notify: false`」的方案：那是上游包的
硬编码（`register` 只传 `{ label }`，未暴露 `notify`），不该由本插件越界修改。

**D1 与 D3、D2 的关系**：三条各自独立、都能单独致命，所以只修其中任何一条都不够 ——
D1 让「清单变化」这条路径死掉，D2 让「策略保存」这条路径**根本没接线**，
D3 让「工作区层」在求值时**被静默丢弃**。D3 尤其隐蔽：它不报错、不告警，只是安静地
退回全局清单，因此面板与模型两边看到的都是「合法的但错的」结果。

### 13.7 v1.7（2026-10-13 续查：面板清单口径 + 复验判据 + 一条上游限制）

**一、工作区面板「已关闭项反而消失」（已修，实测 2 → 16 条）**

症状：chat 工作区（全局关 125 项、本工作区关 55 项）的面板**只列 2 项**，而全局未关闭的有 16 项。

根因是两条误伤叠加：

1. **起点用错**：工作区路由原用 `readAgentSkills`（= `skills.snapshot({ cwd, scope: agent })`）当清单来源。
   但要关闭一个 Skill 的手段**就是**把它遮蔽成不可见，所以**被关闭的项天然不在可见清单里** ——
   等于拿「关闭的结果」当「关闭的依据」。
2. **二次过滤**：`invocableOnly(rows)`（`rows.filter(row => row.modelInvocable)`）把本插件自己注册的
   shadow（`modelInvocable: false`）又滤了一遍。

后果：**只在工作区关闭、全局放行**的那些项彻底消失 —— 用户既看不见、也没有入口重新打开。

修法：新增 `composeWorkspaceSkills`（`src/routes/handlers.ts`），两条路由（读 / 保存回读）**共用**，
口径不许分叉。入选集合 = **全局未关闭 ∩（Agent 可见 ∪ 本工作区已关闭）**。
`invocableOnly` 已无调用者，连同导入一并删除。

实测（probe1 / 3095，cwd=`~/proj/chat`）：面板 **2 → 16** 条；
`面板 ∩ 全局黑名单 = 0`（不误放被全局关闭的项）；补回的 13 行都带完整字段
（`source` / `provider` / `group`）。往返验证：移除 `agent-reach` → 保存 → 仍然 16 条且磁盘已持久化。

**二、回读复验的判据（已修，`src/agent/skills.ts`）**

原判据是「**这个名字还在不在 snapshot 里**」。这是**错的**：遮蔽的做法是注册一份**同名副本**
并把 `modelInvocable` 置 false，`snapshot()` **仍会列出这个名字**（`collect()` 只按名字去重）。
于是判据结果恒等于 `input.hidden` 全集 —— 实测 `leaked=137 = hidden 全集`，**区分不出真泄漏**。

正确判据是看读回来的标记：

```js
verified.skills.find((s) => denied.has(s.name) && s.invocation?.modelInvocable !== false)
```

即看**读回来的标记变了没有**。测试替身也一并重写，让它复现「名字还在、标记变了」的真实语义 ——
原替身让名字消失，**正是这个失真的替身放过了错误判据**。新增的承重用例
（`passes verification when the shadow landed, even though the name stays listed`）
在判据退回错误写法时**会失败**，检测力已实测。

**三、一条上游限制：`browser-skill` 关不掉（已写入 §10 风险，不修）**

见 §10「跨插件同层『先到先得』」一条。要点：该 Skill 由本机一个第三方插件
在 `agent/created` 里**同步**注册进 Agent 层，本插件同事件注册但要先 `await` 读策略，必然落后；
`dsh-skill` 同层重名**静默丢弃后来者**。该重名竞争此前**同样漏掉它**（`session-c95beb02`，14:01，
注入 `count 1 ['browser-skill']`）。**不采用**每轮先撕后贴：与 prompt cache 冲突且未真正解决该案例。

---

### 13.8 v1.8（2026-10-17：纠正 v1.2 关于 `engines.dsh` 的结论，并改用 `engines.dsh` 声明兼容性）

**背景**：用户要求「DSH 的版本识别加上用 engine 来识别」。

**一、纠正 v1.2 的错误结论（M4/§8.1/§12 三处）**

v1.2 写下的两处断言被源码证伪：

- §8.1：「`dsh.engines.dsh` … 在已装包里**没有任何消费者**，不采用。」
- §12 参考表：「兼容性只由 peerDependencies 判定 | `<PKG>/dsh-app-boot/lib/index.js:286`」

**错因（定位到行）**：v1.2 引用的是 `:286`，而 `:286` 属于 peer 回退分支的**入口**。真实的控制流是
`unmetRequirements` 先判 `engines.dsh`（`:281-285`），命中即 **return**；只有**没有** `engines.dsh` 时
才走到 `:286` 起的 peer 遍历。v1.2 只读到回退分支，把它误当成唯一分支，于是漏掉了它上面 5 行的提前返回。

**权威依据（本次实测）**：

1. 源码：`<PKG>/dsh-app-boot/lib/index.js:279-299`（`unmetRequirements`）、`:301-304` 的官方 JSDoc 原文
   「An own `engines.dsh` range decides alone and peerDependencies are ignored」。
2. 规范性文档：`<PKG>/dsh-app-boot/README.md:52`（「When the manifest declares `engines.dsh`, that range alone
   decides and `peerDependencies` are ignored … A manifest with neither declaration imposes no constraint;
   empty or invalid ranges, including a `workspace:` value in `engines.dsh`, are incompatible.」）。
3. 官方类型定义：`<PKG>/dsh-package-manifest/lib/types/types.d.ts:54-64`（`DshEnginesManifest`，注释
   「Runtime version requirements under `package.json.engines`」；`:56-57` 定义 `dsh?: string`）。
4. 官方消费者文档：`<PKG>/dsh-plugin-manager/README.md:75`（拒绝记录「keyed `engines.dsh` or by DSH peer
   package name」——两把钥匙都是官方承认的）。

**结论改写**：`engines.dsh` **是被消费的**，且**优先级高于** peerDependencies。§8.1 与 §12 已按此重写。
不采用的只剩 `dsh.compatibility.dshReleases`（该字段在 `DshManifest` 里根本不存在，
`types.d.ts:28-37` 只有 `manifestVersion` / `bundle` / `profile` / `client`）。

**二、本插件改用 `engines.dsh`**

`package.json` 的 `engines` 增加 `"dsh": "^0.2.1-alpha.2"`。

**等价性论证（实测，非推断）**：本插件 5 个 dsh peer 声明的区间**完全相同**，均为 `^0.2.1-alpha.2`
（`@deepseek-ai/dsh-agent`、`-client-connection`、`-host-webserver`、`-skill`、`-tools`）。
因此用单一 `engines.dsh` 覆盖它们，**判定结论完全等价**。用官方 `evaluatePluginCompatibility` 直接对比
（旧形态 = 删掉 `engines.dsh` 的同一份 manifest）在 `0.2.1-alpha.2` / `-alpha.5` / `0.2.1` / `0.2.2` /
`0.2.0` / `0.3.0` 六个运行时版本上**逐版本一致**（前四者 ok，后两者 均 INCOMPAT）。

**这次改动的性质：声明口径统一，不改变任何实际判定结果。** 代价是粒度变粗：今后若某个 dsh peer
需要与其它 peer 不同的区间，单一 `engines.dsh` 表达不了（官方不支持按包分列），届时须回到 peer 形态。

**未受影响**：`peerDependencies` 中**非 dsh** 的项（`@deepseek-ai/cordis`、`react`）不参与该二选一，
仍照常生效；`dsh-app-boot` 只挑名字为 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-` 开头的 peer
（`lib/index.js:291`）。

**三、语义提醒（官方原话）**

`<PKG>/dsh-package-manifest/lib/types/types.d.ts:22`：`engines` 是
「Runtime requirements; **DSH compatibility is declarative until a reader enforces it**」。
即该字段的可执行性取决于消费方（`dsh-app-boot` 在装配边界查、`dsh-plugin-manager` 在安装前查），
**不是**恶意代码的沙箱（`app-boot/README.md:52` 末句明说「These checks are not a sandbox against
malicious package code.」）。

**验证**：`pnpm run test` 234 项全过（本改动不触及运行时代码，`tests/` 与 `src/` 无任何
`engines`/`peerDependencies` 依赖点，已 grep 确认 0 命中）。

**四、2026-10-17 当日随 DSH 升级到 `0.2.1-rc.2` 的复核**

DSH 由 `0.2.1-alpha.5` 升到 `0.2.1-rc.2`（cordis 由 `4.0.5-alpha.2` 升到 `4.0.5`）后重查，结论**全部保持**：

- 源码逐字未变：`<PKG>/dsh-app-boot@0.2.1-rc.2/lib/index.js:279-299` 与 alpha.5 **行号一致、逻辑一致**；
  `:281-285` 仍是 `engines.dsh` 分支并提前 return，`:286` 仍是 peer 回退入口。该版本的函数注释进一步
  简写为「Evaluate plugin dsh requirements (`engines.dsh`, else dsh peers)」（`:252`）。
- 规范文本未变：rc.2 的 `app-boot/README.md:52`、`plugin-manager/README.md:75`、
  `dsh-package-manifest/lib/types/types.d.ts:22/54-64` 三处与 alpha.5 逐字相同。
- **判定实测**：以 rc.2 的官方 `evaluatePluginCompatibility` 测 `^0.2.1-alpha.2`，在
  `0.2.1-alpha.2` / `-alpha.5` / `-rc.1` / `-rc.2` / `0.2.1` / `0.2.2` 六者上均为 **ok**（即预发布段
  `alpha`→`rc` 的推进不破坏该区间）；`0.2.0` / `0.3.0` / `1.0.0` 仍为 INCOMPATIBLE。
- **端到端实测（决定性）**：在真实 profile（`skilldev`）上执行 `dsh plugin --profile skilldev add`
  （走 `dsh-plugin-manager` 的安装前判定），`^0.2.1-alpha.2` **通过**（exit 0）；临时把该区间改成
  `^9.0.0` 后同一命令**被拒**，原文为
  `dsh: installation rejected: Plugin @dotdance/dsh-skill-scope@0.2.0 is incompatible with dsh 0.2.1-rc.2: requirements {"engines.dsh":"^9.0.0"}.`
  —— 既证明该字段在 rc.2 下确实被消费，也证明拒绝记录的键确为 `engines.dsh`。测试后已还原区间，
  `version-exemptions` 仍为空（未留下豁免记录）。

---

### 13.9 v1.9（2026-10-19：`engines.dsh` 放宽为 `>=0.2.0-rc.2`）

**背景**：用户要求「允许的 dsh 版本改成>=v0.2.0-rc.2」。

**一、改动**

`package.json` 的 `engines.dsh` 由 `^0.2.1-alpha.2` 改为 `>=0.2.0-rc.2`。
`dependencies` / `peerDependencies` 里的 `@deepseek-ai/dsh-*` 区间**未改**（仍为 `^0.2.1-alpha.2`），
原因见下面「三、副作用」。

**二、判定实测**（脚本 `tmp/probe-engines-range.mjs`，直接调用 rc.2 安装里的官方
`dsh-app-boot/lib/index.js` → `evaluatePluginCompatibility`）：

| 区间 | `0.2.0-rc.1` | `0.2.0` | `0.2.1-alpha.1` | `0.2.1-alpha.2`→`0.2.2` | `0.3.0-rc.1` / `0.3.0` | `1.0.0` |
| --- | --- | --- | --- | --- | --- | --- |
| `^0.2.1-alpha.2`（原） | NO | NO | NO | ok | NO | NO |
| `>=0.2.0-rc.2`（新） | NO | ok | ok | ok | ok | **ok** |

`>=0.2.0-rc.2` 的语义与用户所说「>=v0.2.0-rc.2」逐字一致，包含 `0.3.x`、`1.0.0` 等**所有**更高版本。
`0.2.0-rc.2` 本身未列入上表（无该运行时可比），按 semver 它满足 `>=0.2.0-rc.2`。

**三、副作用（须知）**

- **去掉上界**：`1.0.0` 这类不兼容的破坏性版本也会被判为兼容。这是「裸 `>=`」的必然结果，
  要保留上界须写成 `>=0.2.0-rc.2 <1.0.0`（用户未要求，未采用）。
- **与 dependencies/peer 区间不再一致**：`dsh-app-boot` 只按 `engines.dsh` 判定、忽略 dsh peer，
  所以装配期不受影响；但 pnpm 安装 `dependencies: "@deepseek-ai/dsh-atomic-write": "^0.2.1-alpha.2"`
  在 `0.2.0` 运行时上会尝试拉 `0.2.1-*`。也就是说：**装上不再被拒，但在 0.2.0.x 运行时上
  能否真正跑起来未经验证**（本机只有 `0.2.1-rc.2`，无法实测）。
- **未做的事**：没有把允许面收窄回 `^0.2.1`，也没有同步改 dependencies/peer 区间——两者都超出用户要求的最小变更。

**验证**：`pnpm run typecheck` / `pnpm run build` / `pnpm run test` 结果见本次会话；`tests/` 与 `src/` 无
`engines`/`peerDependencies` 依赖点（grep 0 命中），改动不影响运行时行为。

---

## 附：设计取舍与迁移提示

| 取舍 | 另一种做法 | 本插件的选择 |
| --- | --- | --- |
| 作用域 | 单一 workspace 层，且不管理作用域内 Tool/MCP | 全局 + 工作区两层，全局提供默认值、工作区逐项覆盖（三态）；作用域内 MCP 并入工作区层 |
| 入口 | 两个入口分属两个插件 | 两个入口同属一个插件，语义明确各管一层 |
| 文件管理 | 可创建/编辑/删除 Skill，启停靠改写 frontmatter | **移除**文件管理；启停靠内存 shadow / restriction，不碰 Skill 文件 |
| 认证围栏 | 自写 loopback/Origin/配对凭据围栏 | 复用官方 `connection` 的登录态与 Host/Origin 闸门 |
| 策略生效时机 | 首次模型请求时锁定工作区策略 | **回合边界生效**（v1.4 修正）：`agent/created` 首次落地，此后每次保存重新落地、下一回合生效；两层一起读，因此运行中会话里改全局策略也从它的下一回合起生效（不再等新会话） |
| 全局清单 | 无 | 新增，取 `snapshot({})`，不含工程技能 |
| preset 层技能 | 明示不覆盖 | 并入工作区层视图（关闭能力待探针 1 确认） |
| MCP 清单 | 只从全局工具名前缀反推，显式排除作用域内 MCP | 工具名前缀（按作用域）∪ loader 行 `serverName`；loader-only 只读；作用域内 MCP 归工作区层 |
| 生效挂点 | 在装配内注册并重跑一次装配 | 前移到装配之前的注入点，不重跑（见 5.2） |

---

### 13.10 v2.0（2026-10-20：工作区层改为三态覆盖，推翻了「工作区只能收窄」）

**背景**：用户提出，纯黑名单方案（全局禁一批、工程再禁一批）只是若干可选方案之一，另外还有纯白名单、
以及「工程层可改全局结果」的混合方案；要求以产品视角比较后选定。结论：采用**混合三态** ——
全局提供默认值，工程层逐项**跟随 / 明令打开 / 明令关闭**。

**为什么不是纯白名单**（v1.5 已删过一次，这次复核后仍不采用）：
① 同一个 `skills` 数组在两种 mode 下含义相反，是「关掉一项反而把其他项打开」这类缺陷的温床；
② 白名单下「被关掉的名字」= 补集，补集在插件侧不可枚举（`SkillInventory.complete` 信号存在缺口），
于是工程层只能返回空集合「宁可多显示」，用户以为全局关闭生效、其实一项没少。
**白名单唯一值得要的，是「逐项能打开」这半件事；三态正好就是这半件事，且不要求整份名单翻转含义。**

**判据（用户否掉了「名单会膨胀」与「动作次数」两条旧论据之后重定的）**：
① **可预测** —— 用户能否说清「为什么这项是关的」；② **出错方向** —— 坏了是少关几项、还是技能全关。
三态在这两条上都优于纯白名单：每一项的状态都能在界面上直接读到（跟随 / 改过），
而白名单一旦 `mode` 字段写错，129 项的含义整体反转。

**一、语义**

```
isOpen(name) = 工程层表里有 name ? 表里的值 : 全局是否启用(name)
```

- 工程层表里没有的名字 = 跟随全局；有 = 工程层的明文决定。
- 因此全局层从「上限」退化为「默认值」。这是本次最要紧的一条：**不变量 1/2/3 与 3.1/3.3/3.4 里
  「工作区只能在全局未关闭的集合里再收窄」的说法全部改写**，不是追加。旧结论连同它当时的理由一起
  留在 13.5/13.7，不删。
- 工作区层**不再有 `mode`**，存储改为逐项表（3.2）。

**二、「面板不显示全局关闭项」与「工程不能打开全局关闭项」是一对，必须一起改**

v1.5~v1.9 期间工作区面板把全局关闭项整条摘除。它当时**是自洽的**：既然工程层打不开，显示出来也只是
一排按不动的死按钮。三态放开「能打开」之后，若还摘除显示，用户就**没有入口**做这件事 ——
所以列表来源改为完整清单（全局清单 ∪ Agent 活清单 ∪ 策略里点名的名字，取并集而不是替换：
`readGlobalSkills` 缺 Agent 层自注册项，例如 `browser-skill`，它关不掉，见 §10 的上游限制）。

**三、写入与迁移**

- 保存时剔除与全局同向的条目 ⇒ 文件恒等于真实差异集，写盘即自愈。
  代价：手写的同向条目会被静默删除（有意取舍：同向条目与「跟随全局」效果完全相同，留着只会在
  全局将来重开某项时变成一条用户解释不出来的覆盖）。
- 旧格式（`default.skills[]`）**只读兼容，分支永久保留**。旧数组每项 → `false`，`mode` 丢弃；
  写回时换成新形状并删掉 `default`。
- **迁移是懒的**：只有该工程真的写盘才发生（面板里改一项并保存）。不做启动批迁移 ——
  插件没有「所有工程」注册表，工程文件路径由会话 `cwd` 算出；批量只能扫盘猜根目录，或从
  `~/.dsh/sessions/--…--/` 反解路径（非契约，目录名把 `/` 换成 `-` 且不可逆，还含已删工程）。
- 用户明确决定**不跑一次性转换脚本**，以便与未跑脚本的用户环境保持一致。因此「不迁移也能正常工作」
  是验收条件，不是便利项：新面板必须能直接打开半年前的旧文件、且首次保存的「瘦身」不能是事故
  （本机实测 418 条 → 保留 54 条）。

**四、界面**

- 完整清单 + 每行开关 + 红色 `Tag`「与全局不同」（仅当该行与全局当前状态不同；同向不标）。
  只有两个视觉通道：**开关位置 = 最终状态**、**红标 = 与全局不同**。不额外给「明令打开/明令关闭」各配色。
- **视图条多一个按钮「与全局不同」**（2026-10-20 追加，推翻了同一天早先「不加过滤器」的决定）。
  理由：改成三态后清单必须完整（否则全局关闭的项永远打不开），技能段会到一百多行、红点散落其中，
  「这个工程我到底动过什么」在原设计里无法回答。这个按钮的判据是 `row.overridden`（跨层差异），
  **不是开关位置** —— 与「已启用/已禁用」不可互换，所以它是独立谓词而不是第四个开关状态。
  只在工作区层渲染：全局层没有上一层，那个列表会永远为空（`WORKSPACE_VIEW_ORDER` 与
  `VIEW_ORDER` 分开正是为了这个）。
- 工作区 `WorkspaceValue` 改为 `{ global, workspace, revision, … }`；客户端只合并 `revision` 与 `workspace`。

**五、实现落点**

| 层 | 改动 |
| --- | --- |
| `src/policy/schema.ts` | 两层策略类型分家：全局 `{mode, skills[], mcps[]}`；工作区 `{skills: StateMap, mcps: StateMap}`。新增旧格式读取转换 + 新格式序列化（键排序） |
| `src/policy/evaluate.ts` | 由「集合做差」改为逐名字求值（`openResolver`）；隐藏集 `key` 仍按排序后名字拼 |
| `src/routes/handlers.ts` | 清单来源改并集；不再摘除全局关闭项；每行带 `globalState` / `localState` / `overridden`；保存按字段合并，防旧客户端清空 |
| `src/client/*` | 行派生改「取值函数」模型（`OpenLookup` / `OverrideLookup`）；两个外壳各自提供 `isOpen` / `toggle` 适配器；红标与文案 |
| 测试 | `tests/policy/` 重写、`tests/routes/handlers.spec.ts` 与 `tests/client/WorkspaceModal.spec.tsx` 改语义；新增「改过就要标红」的正向用例（只测「不标红」在无实现时也会通过） |

**六、不变量变更**

- 不变量 2、3 改写（工作区可启用/关闭全局项；工作区无 `mode`，跟随只能由「无此键」表达）。
- 新增不变量 27（求值公式唯一，服务端与客户端逐字同构）。
- 3.6 的读取宽容口径补上工作区侧：单个值不是布尔 ⇒ 该项按「跟随全局」+ warning，不整份丢弃；
  `default` 与 `workspace` 并存 ⇒ 以 `workspace` 为准 + warning。
