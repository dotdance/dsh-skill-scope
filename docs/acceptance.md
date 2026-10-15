# 验收报告（实施计划 Task 17）

- 包：`dsh-skill-scope`
- 仓库：`/Users/go/proj/dsh-skill-scope`
- 结论：`pnpm run check` 退出码 `0`，18 个测试文件 / **228** 条测试全绿。

> **本文件的计数会过时。** 它们只在写下时的那个提交上成立。要当前值就自己跑一遍，
> 不要引用这里的数字：
>
> ```sh
> npx vitest run
> ```
>
> 第 3 节列出的是写下时的逐文件计数，用途是**当时**的核对，不是长期契约。

本文件只记录**实际跑出来的输出**，没有抄自计划文本。

---

## 1. 一键验收：`pnpm run check`

该脚本串联三步（`package.json` scripts 定义）：`pnpm run typecheck && pnpm run build && pnpm run test`，
即 `tsc --noEmit`（类型检查）、`tsdown`（构建）、`vitest run`（测试）。

```sh
pnpm run check; echo "EXIT_CODE=$?"
```

退出码 `0`：三步均通过。

（此处不贴逐字输出：构建产物的字节数、`Start at` 时间与逐文件计数每次运行都变，
贴进来就是下一次过期的来源。计数见第 3 节，且它自带过期声明。）

---

## 2. 构建产物清单

### 命令

```sh
ls -l lib/
```

三个文件都在，与 `package.json` 的 `exports` 对齐：

| 文件 | 对应 `exports` | 形态 |
| --- | --- | --- |
| `lib/index.js` | `"."` | ESM |
| `lib/client.js` | `"./client"` | CJS，browser |
| `lib/client.js.map` | （sourcemap） | — |

（不记字节数与时间戳：它们每次构建都变，写进来只会过时。文件是否存在由
`tests/client/bundle.spec.ts` 与下面的头部契约断言把守。）

### client bundle 头部契约

设计要求产物**必须以 `window.__ModuleLoader__.load({ id: "dsh-skill-scope"` 开头**
（计划「全局约束」；设计 8.2）。

```sh
head -c 200 lib/client.js
```

短横写法的 banner 满足 `tests/client/bundle.spec.ts` 的两条断言：
`head.startsWith('window.__ModuleLoader__.load({')` 与 `head` 含 `id: "dsh-skill-scope"`。

### bundle 真正 `require` 的外部模块

```sh
grep -o 'require("[^"]*")' lib/client.js | sort -u
```

```
require("@deepseek-ai/dsh-client-ui-primitives")
require("react")
require("react/jsx-runtime")
```

**这是一处需要说明的设计-实现差异，已由 lead 裁定并写入测试注释**
（`tests/client/bundle.spec.ts` 中该断言的注释）：

- `package.json` 的 `dsh.client.external` 声明了**三项**：
  `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
  `@deepseek-ai/dsh-client-runtime/client`。
- 产物只 `require` 了其中**一项**（`dsh-client-ui-primitives`），外加 client baseline 提供的
  `react` 与 `react/jsx-runtime`。
- 原因：`dsh.client.external` 是**运行期可用性/放行清单**，不是「要合成哪些 `require`」的清单。
  真实证据是官方 `@deepseek-ai/dsh-client-ui-shortcuts/lib/client.js`：它只 `require` 自己源码
  真正 import 的模块，而它的 `package.json` 里**根本没有** `dsh.client.external` 字段。
- 其中 `@deepseek-ai/dsh-client-runtime/client` 在本机 `require.resolve` 直接 MISSING，
  本插件也没有任何用途需要它。为了「让它出现在产物里」而凭空 import 一个不存在的包，会让产物在
  真实宿主里**加载失败** —— 比放宽这条断言严重得多。
- 因此现行断言钉的是「插件真的用到的那个外部依赖必须有 `require`」（`dsh-client-ui-primitives`），
  同时一并断言 baseline 的 `react` / `react/jsx-runtime`。

---

## 3. 每个测试文件的用例计数（来自真实输出）

**写下时的值：18 个文件 / 228 条用例。** 这个数字会随代码变化，别当长期契约用
（要当前值就自己跑 `npx vitest run`）。下表是当时的逐文件计数：

| 测试文件 | 用例数 | 结果 |
| --- | ---: | --- |
| `tests/policy/schema.spec.ts` | 7 | ✓ |
| `tests/policy/store.spec.ts` | 13 | ✓ |
| `tests/policy/evaluate.spec.ts` | 11 | ✓ |
| `tests/inventory/skills.spec.ts` | 29 | ✓ |
| `tests/inventory/mcp.spec.ts` | 12 | ✓ |
| `tests/inventory/official.spec.ts` | 9 | ✓ |
| `tests/agent/state.spec.ts` | 4 | ✓ |
| `tests/agent/skills.spec.ts` | 8 | ✓ |
| `tests/agent/mcp.spec.ts` | 6 | ✓ |
| `tests/agent/hooks.spec.ts` | 9 | ✓ |
| `tests/assembly.spec.ts` | 12 | ✓ |
| `tests/routes/handlers.spec.ts` | 42 | ✓ |
| `tests/routes/session.spec.ts` | 13 | ✓ |
| `tests/client/api.spec.ts` | 4 | ✓ |
| `tests/client/bundle.spec.ts` | 6 | ✓ |
| `tests/client/GlobalPanel.spec.tsx` | 12 | ✓ |
| `tests/client/WorkspaceModal.spec.tsx` | 29 | ✓ |
| `tests/index.spec.ts` | 2 | ✓ |
| **合计（18 个文件）** | **228** | **18/18 通过** |

按层分组（同表数据的另一种切法，便于对照计划的分层叙事）：

| 层 | 文件 | 用例数 |
| --- | ---: | ---: |
| policy | 3 | 31 |
| inventory | 3 | 50 |
| agent | 4 | 27 |
| routes | 2 | 55 |
| client | 4 | 51 |
| 顶层 | 2 | 14 |
| **合计** | **18** | **228** |

---

## 4. 不变量走查（设计第 9 节，1–26）

设计 `docs/design.md` 第 9 节列出 26 条可测不变量。下表逐条给出**强制点**：
源码位置（`src/...:LINE`）与/或**真实存在的测试名**。测试名逐字取自 `vitest` 的 JSON 报告。

**没有一条靠猜。** 26 条里 **25 条有强制点**，第 26 条在后文「未覆盖」小节说明。

| # | 不变量（摘要） | 强制点：源码 / 测试 |
| ---: | --- | --- |
| 1 | 策略按名称取值，与 Skill 来源无关 | `src/policy/evaluate.ts` 的 `allowedNames`（`allowedNames` 只吃名字数组，不看来源元数据）；`src/policy/schema.ts` 的 `toRows`（`toRows` 只留 `mode/skills/mcps`）。测试 `tests/policy/evaluate.spec.ts` → 「removes the listed names and treats a default mode identically」 |
| 2 | 全局层先于工作区层求值；工作区不能启用被全局关闭的名字 | `src/policy/evaluate.ts` 的工作区层套用段：先 `allowedNames(inventories.skills, effective.global)`，**再**对结果套工作区层。测试 `tests/policy/evaluate.spec.ts` → 「never re-enables a globally closed name from the workspace layer」 |
| 3 | 工作区层只能从全局未关闭集合中选（不得复活全局关闭的名字） | 同 L54-55：工作区层作用在**已收窄的** `skillsAllowed` 上，而不是原始清单。测试 `tests/policy/evaluate.spec.ts` → 「workspace layer cannot re-enable a globally blacklisted skill」（另「… blacklisted mcp」） |
| 4 | 全局面板只列 `snapshot({})` 的条目（无 `cwd`、无 `scope`） | `src/inventory/skills.ts` 的全局读取（`skills.snapshot({})` 空对象）。测试 `tests/inventory/skills.spec.ts` → 「reads the global layer with an empty options object」；UI 侧 `tests/client/GlobalPanel.spec.tsx` → 「never renders a project skill, because the global read passes no cwd」 |
| 5 | 工作区面板只列 live Agent 作用域视图，**读取必须显式传 `scope: agent`** | `src/inventory/skills.ts` 的 `snapshot({ cwd, scope: agent })`（`snapshot({ cwd, scope: agent })`，传的是 agent **对象本体**）。测试 `tests/inventory/skills.spec.ts` → 「passes cwd and the live agent as scope」；`tests/client/WorkspaceModal.spec.tsx` → 「reads the workspace inventory with an explicit scope: agent」 |
| 6 | 面板不提供任何文件写入口；只写两个策略文件 | 路由面只有四条且全为 `/api/skill-scope/*`（`src/routes/register.ts` 的 `ROUTES`），没有任何通用文件写路由。测试 `tests/routes/handlers.spec.ts` → 「registers exactly four POST-only buffered routes under /api/skill-scope/」；UI 侧 `tests/client/GlobalPanel.spec.tsx` → 「lists only the names the inventory contains, with no add-by-name input」 |
| 7 | 隐藏 Skill 只改 `modelInvocable`；`userInvocable` 保持原值；`content` 等原值透传 | `src/agent/skills.ts` 的 `applySkillShadow`：`{...definition}` 展开保留全部字段（含 `content`/`path`），只覆写 `invocation.modelInvocable = false`，且 `userInvocable: invocation?.['userInvocable'] !== false` **仅在显式为 `false` 时才关**。测试 `tests/agent/skills.spec.ts` → 「registers a full copy of the definition, changing only modelInvocable」 |
| 8 | shadow 更新前必须先释放上一轮同层注册 | `src/agent/skills.ts` 的 `applySkillShadow`（`input.previous?.()` 在注册循环之前）（`input.previous?.()` 在注册循环之前，整体处于 `serial` 内）。测试 `tests/agent/skills.spec.ts` → 「releases the previous shadow before registering again」 |
| 9 | 隐藏后必须用一次全新 snapshot 复验；失败只记 warning 并保留其余项，**不回滚、不抛错**；**复验必须传宿主 Agent 本体当 `scope`** | `src/agent/skills.ts`：`verifyStillVisible` 时重新 `snapshot({ scope: input.scopeOf ?? input.agent, cwd })`，判据是 `invocation.modelInvocable !== false`（**不能**用「名字在不在」——遮蔽后名字仍在清单里，见 `dsh-skill/lib/index.js:231-237`）；发现泄漏只 `logger.warn`。抛错会冒到 `onCreated` 的 catch 而 fail-open ⇒ 一个 Skill 都关不上，比「少关一个」严重。测试 `tests/agent/skills.spec.ts` → 「warns but keeps the other shadows when one skill cannot be hidden」「passes the host object as the scope, not a freshly built stand-in」 |
| 9b | 读 Agent 层**必须**传宿主原始对象本体，不能传重新构造的 `{id,…}` 替身 | `src/agent/state.ts` 的 `AgentLike.raw`（`asAgentLike` 原样保存宿主对象）+ `src/agent/hooks.ts` 调用点的 `scopeOf: state.agent.raw ?? state.agent`。依据：`dsh-scope` 按**对象身份**索引层（`peek` 用 `scoped.get(scope)`、`scopeChainOf` 用 `scopeParents` WeakMap），替身查不到 Agent 层 ⇒ 退化成全局层 ⇒ 每个已遮蔽项都读回 `modelInvocable:true`。实测（probe1 / 3131-3133，`hidden=137`）：替身 `exposed=69` vs 本体 `exposed=1`。 |
| 10 | 读清单不完整（`complete === false`）时不改变当前生效状态 | `src/agent/hooks.ts` 的 `computeHidden`：`if (inventory.complete !== true) { warn; return null }` —— 返回 `null` 让调用方放弃本轮，**不降级**为按残缺清单执行。测试 `tests/agent/hooks.spec.ts` → 「does not change the effective state when the inventory is incomplete」；另 `tests/inventory/skills.spec.ts` → 「surfaces complete === false instead of pretending the inventory is empty」 |
| 11 | restriction 每次隐藏集变化都重建；deny 先与 `restrictableNames` 取交集；key 未变时**不写** restriction | `src/agent/mcp.ts` 的 `denyFor`（`denyFor` 用 `restrictableNames.has(toolName)` 过滤）；`src/agent/mcp.ts` 的 `applyMcpRestriction`（`previous.key === input.key` 即复用；`deny.length === 0` 直接返回 `null`、**绝不**空数组调 `restrict`）。测试 `tests/agent/mcp.spec.ts` 四条：「expands server names into tool names and keeps only restrictable ones」「never emits a name that is not in restrictableNames」「reuses the previous restriction when the hidden key is unchanged」「never calls restrict with an empty deny array」 |
| 12 | 无 `connection` 服务时插件正常工作、不注册路由、不报错 | `src/index.ts` 的 `ctx.inject(['connection'], …)`（`ctx.inject(['connection'], …)` 可选注入，缺则整块跳过）。测试 `tests/index.spec.ts` → 「applies without a connection service」；`tests/agent/hooks.spec.ts` → 「keeps working without a connection service」 |
| 13 | 无 live Agent 时工作区路由返回只读视图，不抛错，并标记为非实时 | `src/routes/handlers.ts` 的工作区读取处理（「live Agent 优先」，退化时 `live: false` 但仍返回策略）；`src/routes/handlers.ts` 响应信封里的 `live` 字段（`live` 字段）。测试 `tests/routes/handlers.spec.ts` → 「marks a workspace read with no live agent as live:false and still returns a policy」 |
| 14 | `revision` 不匹配时拒绝保存并回 `409`，不写入 | `src/policy/store.ts` 的 `save`：文件锁临界区内比对 `sha256Hex(current)`，不符即 `code: 'stale-revision'`（含「省略 `revision` 但文件已存在」的分支）。测试 `tests/policy/store.spec.ts` → 「rejects a save whose expected revision does not match」「rejects a null-expected save when the file already exists」；路由侧 `tests/routes/handlers.spec.ts` → 「maps a stale revision to stale-revision」 |
| 15 | 插件卸载与 `agent/disposed` 后不留 shadow 与 restriction | `src/agent/hooks.ts` 的事件订阅段（订阅 `agent/created` / `agent/disposed` / `skills/change` / `tools/change`）与 `src/agent/hooks.ts` 的 `ctx.effect(() => stopAll)`（`ctx.effect(() => stopAll)`）。测试 `tests/agent/hooks.spec.ts` → 「releases shadows and restrictions on agent/disposed」「releases everything when the plugin unloads」 |
| 16 | 所有策略文件写入是原子的，且不会在解析失败时覆盖原文件 | `src/policy/store.ts` 的 `writeFile`（`writeFileAtomic(path, text, { mode: 0o600, dirMode: 0o700 })`）；「不覆盖坏文件」在 `src/policy/store.ts` 的 revision 守卫注释 + 读侧宽容解析（`src/policy/schema.ts` 的宽容解析 永不抛错）。测试 `tests/policy/store.spec.ts` → 「does not overwrite a broken file and reports a warning」；另 `tests/policy/schema.spec.ts` → 「treats a broken document as an empty policy with a warning and never throws」 |
| 17 | 收窄面在 `agent/created` 首次落地；`agent/created` 监听器**绝不抛错** | `src/agent/hooks.ts` 的 `onCreated`：`onCreated` 整个函数体包 `try/catch`，`catch` 只 `ctx.logger.warn` 并降级为「本会话按空策略运行」。测试 `tests/agent/hooks.spec.ts` → 「applies the shadow and the restriction at creation, before the first assembly」「never throws out of agent/created, so session creation cannot fail」 |
| 18 | 策略在**回合边界**生效：保存后对活跃 Agent 重新落地，当前回合不受影响 | `src/agent/hooks.ts` 文件头的「关键时序（勿改）」：收窄**不挂** `agent/pre-step` / `system-prompt/assemble`，只在 `agent/created` 与清单变化时执行；实现见 `src/agent/hooks.ts` 的 `regroundAndApply`（每次重新 `evaluate` + `reground`）。测试 `tests/agent/hooks.spec.ts` → 「re-grounds to the saved policy on skills/change and re-derives the hidden set」。**UI 侧不再显示任何回合边界提示**：`tests/client/GlobalPanel.spec.tsx` → 「renders neither the revision string nor the turn-boundary notice」断言该提示**不存在**（守卫它不再回来） |
| 19 | 清单变化时按**当时最新读到的策略**重算隐藏集：策略**不冻结** | `src/agent/hooks.ts` 的 `regroundAndApply`：`regroundAndApply` 每次调用都先 `await evaluate(deps, state.agent)`（重读两层策略）再 `reground(state, effective)`；`src/agent/state.ts` 的 `reground` 的 `reground` 直接覆写。测试 `tests/agent/state.spec.ts` → 「re-grounds to the newest policy on every call」 |
| 20 | 策略保存一律在**回合边界**生效（服务端行为） | `src/agent/hooks.ts` 的 `regroundAndApply` 每次重新 `evaluate` + `reground`（不挂 `agent/pre-step`，见文件头「关键时序」）。测试 `tests/agent/hooks.spec.ts` → 「re-grounds to the saved policy on skills/change and re-derives the hidden set」。UI 侧不显示任何回合边界提示，且由 `tests/client/GlobalPanel.spec.tsx` → 「renders neither the revision string nor the turn-boundary notice」断言它不再出现 |
| 21 | 面板只操作清单中已出现的名字，无任何按名称写入的入口 | UI 开关只由清单行渲染（`src/client/parts.tsx` 的 `rows`/`visible` 映射），面板无文本输入型写入口。测试 `tests/client/GlobalPanel.spec.tsx` → 「lists only the names the inventory contains, with no add-by-name input」 |
| 22 | loader-only MCP server 不进 deny 集，只在 UI 只读展示 | `src/inventory/mcp.ts` 的 `classifyMcp`（loader-only 补 `restrictable: false`、`loaded: false` 行）；`src/agent/mcp.ts` 的 `denyFor`（`denyFor` 只收 `restrictableNames` 内的名字，loader-only 的不在其中）。测试 `tests/inventory/mcp.spec.ts` → 「lists a loader server with no tools as read-only and not loaded」；`tests/client/GlobalPanel.spec.tsx` → 「shows a read-only row with no switch for a loader-only MCP server」 |
| 23 | Skill shadow 按**最新策略**与实际可见集合**差分**更新；MCP restriction 按隐藏集 key 比较决定是否重建 | Skill 侧：`src/agent/hooks.ts` 的 `regroundAndApply` 每次重新求值；调用方仅在目标集变化时调 `applySkillShadow`（`src/agent/skills.ts` 的 `applySkillShadow` 注释）。MCP 侧：`src/agent/mcp.ts` 的 `applyMcpRestriction`（`previous.key === input.key` 复用）。测试 `tests/agent/mcp.spec.ts` → 「reuses the previous restriction when the hidden key is unchanged」「disposes the old restriction and registers the new one when the key changes」 |
| 24 | 「非实时」标记由**数据来源**驱动（`live` 标志） | `src/routes/handlers.ts` 响应信封里的 `live` 字段 与 `:50` 返回 `live`；`src/client/WorkspaceModal.tsx`（`value.live ? …workspace-live : …workspace-not-live`）（非实时时额外给出理由 `state.notLiveHint`）。测试 `tests/client/WorkspaceModal.spec.tsx` → 「marks the view as not live when the route says live:false」「renders a live view for a blank session」 |
| 25 | 策略文件读写走宿主侧 `node:fs`：`writeFileAtomic(file, text, {mode: 0o600})` + `withFileLock`；**不得**经 `ctx.get('fs')` | `src/policy/store.ts` 从 `@deepseek-ai/dsh-atomic-write` 导入 `writeFileAtomic` / `withFileLock`；`src/policy/store.ts` 的 `writeFile`（原子写 + `0o600`/`0o700`）；`src/policy/store.ts` 的 `this.lock` 缺省值 `withFileLock`。测试 `tests/policy/store.spec.ts` → 「runs every save inside the file lock」 |
| 26 | 只有 global 层与祖先层的工具可被 `restrict`；Agent 自带层工具不进 `restrictableNames` | **部分强制**：`src/agent/mcp.ts` 只在注释里声明这条硬约束，真正取 `restrictableNames` 的调用方在 `src/agent/hooks.ts`（`computeHidden` 取 `deps.tools.schemas(agent)` 并在 `denyFor` 处与 `restrictableNames` 求交）。**注意**：实测 `denyFor` 的入参 `restrictableNames` 来自调用方，`denyFor` 的形参。详见下一节的「未覆盖」说明 —— 该条**没有**端到端钉住「Agent 自带层工具不可收窄」的测试。 |

### 4.1 关于计划里「PINNED (N 条)」的核对

计划正文多处把测试条数写死在描述里。按要求核对**真实文件里实际存在的 `it(...)` 数量**，
结果与本次 `vitest` 报告一致（见第 3 节）。计划文本中的计数**不作为证据**。

---

## 5. 未覆盖（真实发现，不编造映射）

### 5.1 不变量 26：一条已失效的设计条文

**结论：本条描述的能力**从未实现**，且设计正文没有跟着改。这是文档问题，不是测试缺口。**

设计正文的该条要求：「直接注册在 Agent 自带层上的工具不进 `restrictableNames`，
因此不提供开关、只提供 `guard` 降级」。

拆成两句看，两句的处置不同：

- **前半句（不可收窄）是真实的，且已强制。** `tools.restrict()` 对任何未知名字都会抛
  `tools.restrict() names unknown global tool(s) ...`，于是整轮收窄失败、一条工具都关不掉。
  因此 `src/agent/mcp.ts` 的 `denyFor` 用 `if (!restrictableNames.has(toolName)) continue` 与
  `restrictableNames` 求交。有两条单元测试钉住相邻语义
  （`tests/inventory/mcp.spec.ts` → 「never marks a tool owned only by the agent layer as
  restrictable」「marks a server restrictable only when one of its tools is inherited」）。
  未被测的是「**宿主**确实不会把 Agent 自带层工具放进 `restrictableNames`」——
  那属插件边界之外的宿主事实，需要集成探针才能确认，本仓库的单元测试无法覆盖。
- **后半句（`guard` 降级）从未实现。** `guard` 在 `src/` 与 `tests/` 中**零命中**：
  既没有实现，也没有测试。本插件对不可收窄的工具**不做**任何降级拦截，
  只是在列表里不给开关。

**处置建议（属文档修订，不属本验收任务范围）**：把设计 §9 不变量 26 里的 `guard` 子句删掉，
只留「不可收窄的工具不提供开关」；该条不应被读作「本该有 guard、只是缺测试」。

---

## 6. 残余风险

（本节只列**至今仍有效**的风险。验收当时的一次性过程事件 —— 并发编辑导致的失败运行、
当时改动过的文件 —— 已不再影响读者，故不保留。）

1. **`dsh.client.external` 与产物 `require` 集合不一致**（第 2 节）。已由 lead 裁定并写进
   `tests/client/bundle.spec.ts` 的注释；这里记录为**已知的、有意的差异**，
   不是缺陷。风险点：若将来宿主改为「按 `external` 清单合成 `require`」，
   本产物的行为会变 —— 但当前官方机制不支持该读法。
2. **测试环境为 `dsh-client-ui-primitives` 引入了别名**（`vitest.config.ts` 的
   `resolve.alias` 与 `tsconfig.json` 的 `paths`）。该包是 `dsh.client.external` 的成员，
   由宿主 client baseline 在**运行期**提供，本仓库**刻意不安装**它；
   只有测试/类型检查环境需要这层映射。不能改指向全局 pnpm 副本：
   实测其 React 是 19.2.8，而本仓库钉的是 18.3.1。**构建产物里它仍是 external**，
   别名不影响 `lib/client.js`。
3. **`@testing-library/jest-dom` 是新增 devDependency**（随
   `tests/support/setup-dom.ts` 的接入，见 `vitest.config.ts` 的 `setupFiles`）。
   这使 `package.json` 的 devDependencies 比计划的依赖白名单多出一项 —— 属**获批的偏离**。
4. **未验证的探针**：设计第 10 节自陈「探针 3（手工复刻 client bundle 能否被宿主消费）
   本轮**未跑**，是本设计唯一没有实测支撑的探针」。
   `tests/client/bundle.spec.ts` 用 `new Function` 在 Node 里模拟了 `__ModuleLoader__`
   并对产物做了解析（`registers itself through window.__ModuleLoader__.load with the exact id`
   等 5 条），但这**不等于**在真实浏览器宿主里加载过。
   风险：CSS Module 注入与槽位注册在真实宿主中的表现仍未经端到端确认。
5. **不变量 18（回合边界生效）在真实宿主中的时序未被端到端观测。**
   本仓库的测试全部是单元/组件级（`tests/agent/hooks.spec.ts` 用替身驱动事件）。
   「保存后当前回合不受影响」在真实 `dsh-agent-loop` 上的表现，依赖探针 8 的结论，
   本轮未重跑。
6. **不变量 26 仍未端到端钉住**（第 5.1 节）。lead 已裁定：属测试覆盖缺口，不是代码缺陷，
   且**有意不补测试**（不让表格看起来完整而去写一个测试）。这是**已知的、被接受的**残余风险。
7. **`browser-skill` 无法被关闭 —— 上游机制限制，非本插件缺陷。**
   `dsh-skill` 的 `register()` 在**同一层**遇到重名时静默丢弃后来者（`logger.warn(...)` +
   `return () => {}`）。
   `browser-skill` 由本机一个第三方插件在 `agent/created` 里**同步**注册进
   Agent 层；本插件同在该事件注册，但要先 `await` 读两层策略，**必然落后** ⇒ 遮蔽副本被丢弃。

   **证据①（不是本插件引入）**：该重名竞争此前同样漏掉它 ——
   历史会话 `session-c95beb02-588d-40bc-a7a7-23c6629dc3ff`（2026-10-13 14:01）
   注入目录为 `count 1 ['browser-skill']`，当时策略几乎全关，唯独它存活。
   **证据②（复验判据能识别它）**：按 `invocation.modelInvocable !== false` 复验时，
   该 Skill 读回仍是 `{"modelInvocable":true,"userInvocable":true}`（probe1 / 3101，
   cwd=`/Users/go/proj/chat`），而同一批里其余项都已是 `false`。

   **不做每轮先撕后贴**：每轮在 `agent/pre-step` 重建，代价是 `revision += 2N` 且
   `collectCache.clear()` —— **与 prompt cache 直接冲突**，而证据①表明它**并未真正解决**
   这个案例。
   本插件的 `verifyStillVisible` 复验开关**已在生产路径启用**（`src/agent/hooks.ts` 调用点传
   `verifyStillVisible: true`），且失败语义已从「回滚 + 抛错」改为「记警告 + 保留其余生效项」：
   抛错会落到 `onCreated` 的 catch 即 fail-open ⇒ **一个 Skill 都关不上**，比「少关一个」严重。

   **复验判据必须同时满足两条**（缺一条就会整批误报）：
   ① 看 `invocation.modelInvocable !== false`，**不是**看名字在不在（遮蔽后名字仍在）；
   ② `scope` 必须传**宿主原始 Agent 对象本体**，不能传 `asAgentLike` 造的替身
      （`dsh-scope` 按对象身份索引层，替身查不到 Agent 层）。
   实测：同时修正两条后 `hidden=137 → exposed=1`（只剩 `browser-skill`）；
   任缺一条都会得到 `exposed=69` 或 `exposed=137` 的假象。

---

*本文件由验收任务（Task 17）依据真实命令输出编写。所有命令均在
`/Users/go/proj/dsh-skill-scope` 下执行，输出逐字复制。*
