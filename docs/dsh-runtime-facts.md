# DSH 宿主运行时事实（实测）

本文件记录本插件**依赖的宿主行为**。这些事实不在 DSH 的公开文档里，或与直觉相反，因此每条都
在已装 `0.2.1-alpha.2` 上实测过，并给出可复读的源码位置。它们解释了插件为什么写成现在的样子；
改动本插件前先读本文件，可以避免重新踩一遍这些坑。

基准：DSH `0.2.1-alpha.2`（`@deepseek-ai/cordis` `4.0.5-alpha.1`）。引用格式 `<包>/lib/<文件>:<行号>`。

---

## 1. 文件写入：沙箱围栏只看目标路径

**结论：要写 `$DSH_HOME`，只能用宿主侧 `node:fs`。`ctx.get('fs')` 写不了，传不传 `sandboxPolicy` 都一样。**

`ctx.get('fs')` 是**模型能力缝**，不是宿主自己的文件工具。它的沙箱围栏按**目标路径**判定：

- `dsh-fs-sandbox/lib/index.js:157-166` 的 `checkedTarget`：`policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()`；
  `mode === 'danger-full-access'` 直接放行、`'read-only'` 直接抛错，否则要求目标落在可写根内。
- 可写根集合在 `dsh-sandbox/lib/index.js:166-173` 的 `writableRoots`：
  `[...new Set([policy.workspaceRoot, '/tmp', tmpdir()])]`。

**`$DSH_HOME` 永远不在可写根内**，所以「带不带 `sandboxPolicy`」是无关变量——设计原先以为它是个
可调参数，实际不是。四种组合的实测结果：

| 组合 | 目标 | 结果 |
| --- | --- | --- |
| 带策略 × 工作区内 | 仓库内文件 | 成功 |
| 不带策略 × 工作区内 | 同上 | 成功 |
| 带策略 × `$DSH_HOME` | `$DSH_HOME/skill-scope/…` | `FS_SANDBOX_DENIED` |
| 不带策略 × `$DSH_HOME` | 同上 | `FS_SANDBOX_DENIED` |

错误文本（两种写法完全相同）：

```
FsError code=FS_SANDBOX_DENIED: cannot write "<path>":
file access denied under workspace-write mode
```

**官方包先例同向**：`dsh-plugin-manager`（写 `$DSH_HOME/profiles/**`）与 `dsh-credentials-local`
（写 `~/.dsh/.credentials.yaml`）都走 `node:fs` + `@deepseek-ai/dsh-atomic-write` 的
`writeFileAtomic` / `withFileLock`。**已装官方包里没有一个**用 `ctx.fs` 写自有配置文件。

**一条会误导人的本机事实**：本机 `~/.dsh/profiles/web/cordis.patch.yml` 把
`@deepseek-ai/dsh-permission-presets` 的 `defaultPreset` 配成了 `danger-full-access`，所以在 web 会话里
`ctx.fs` **恰好**能写 `$DSH_HOME`。这是用户本机的 preset 配置，**不是契约**，插件不得依赖它。

**cwd 会改变可写根**：`workspaceRoot` 随 cwd 变，所以换目录可能连带把原本可写的位置移出可写根。

## 2. 工具分层：own 层可见，但不可收窄

**结论：`restrictableNames` 只含继承来的工具名；注册在该 Agent 自己层上的工具进 `visible`，但不进 `restrictableNames`，因此永远遮不住。**

`dsh-tools/lib/index.js` 的 `view(scope)`（约 `:2957-2985`）逐行：

```js
view(scope) {
  const layers = this.layers.chainLayers(scope);
  const own = this.layers.peek(scope);
  const inherited = new Map(this.layers.global.tools.entries());
  for (const layer of layers) {
    if (layer === own) continue;              // :2962  own 层不进继承面
    for (const [name, definition] of layer.tools.entries()) inherited.set(name, definition);
  }
  …
  for (const [name, definition] of inherited) {   // :2968-2971
    knownNames.add(name); restrictableNames.add(name);
    if (layers.every((layer) => layer.admits(name))) visible.set(name, definition);
  }
  if (own !== void 0) for (const [name, definition] of own.tools.entries()) {  // :2973-2975
    knownNames.add(name); visible.set(name, definition);   // ← 只进这两个，不进 restrictableNames
  }
  …
}
```

⇒ **own 层名字 `visible` 却不可 `restrict`。**

同函数上方 `:2948-2952` 的注释解释历史原因：preset 移入 agent 平面后算**祖先贡献**，所以 preset 的
MCP **可** `restrict`；只有**该 Agent 自己那一层**不可。

**判据是「该名字注册在哪一层」，不是「它是不是 MCP」，也不是「哪个插件装的」。**

### 两个 own 层实例（不是理论可能性）

1. **ACP 每会话 MCP**：`dsh-acp/lib/index.js:212` 文档写 `@param agentCtx - unpublished Agent scope that
   owns the MCP clients and tools.`；`:216` `mountAcpMcpServers(agentCtx, …)`；`:218`
   `await agentCtx.plugin(McpClient, config)`。调用点 `:702` / `:721`，在 Agent 发布**之前**。
2. **子 Agent 的结构化输出工具**：`dsh-subagent/lib/index.js:914`
   `childCtx.tools.register({ … STRUCTURED_OUTPUT_TOOL … })`。该工具描述是
   `"Report your final structured result. Call this exactly once…"`，**必须**出现在模型工具表里 ——
   这也是「own 层注册对模型可见」的直接证据。

**不要拿 `dsh-plugin-codegraph-project` 当 own 层实例**：它的 MCP 注册在**根 ctx**（`lib/index.js:164`、
`:165`、`:500`；`lib/agent-tools.js:299` 用的是文档写明的 root `ctx.tools`），落 GLOBAL 层，**可**被
`restrict`。它 `lib/index.js:268` 的 `agent.ctx` 只用于会话记账；`lib/pool.js` 是**传输层客户端池**
（每个 `projectRoot` 一个 `Client`，缓存 `this.toolList`，`:202` 发 `tools/list`），**不注册任何工具**。

### `restrict` 的四条错误面（实测可复现）

| 情形 | 错误文本 |
| --- | --- |
| filter 全空 | `tools.restrict({}) is a no-op: pass \`allow\` and/or \`deny\` …`（`:2898`） |
| 命名保留的 PTC 传输名 | `tools.restrict() cannot name reserved PTC mode presentation transport "run_code" …` |
| 名字不在可收窄集 | `tools.restrict() names unknown global tool "X"; known global tools: <排序全集>`（`:2905-2906`） |
| 非 scoped context | `tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead` |

`restrict` 成功时返回**精确的 disposer**。**绝不用空数组调 `restrict`**：隐藏集为空时的正确表达是
「没有任何限制」。

## 3. `guard` 与 `restrict` 的能力差异

`restrict` **遮模型可见列表**；`guard` **只拦调用、不遮列表**。两者都可在 agent 作用域注册：

- `dsh-tools/lib/index.js:2909-2917` 文档原文：「A plain-context guard applies globally;
  **one registered through `agent.ctx` applies only to that agent.** Any matching guard may deny by
  returning a reason, while no guard can force-allow a call another guard denied.」
- `:2925-2931` 的 `guardReason(exec)` 先查 `this.layers.global`，再按 `chainLayers` **从最远祖先到本层**
  逐层查 guard。
- `:2919-2921` 的 `guard(guard)` 走 `this.layers.effect(this.ctx, …)`，即注册进**当前 ctx 所在层**。

⇒ `agent.ctx.get('tools')` 上挂 `guard` 或调 `restrict` **都可行**（`agent.ctx.get('tools')` 是可达的；
属性式 `ctx.tools` 才要求 `inject`）。

**本插件只用 `restrict`**，不实现 `guard` 降级：对不可收窄的工具它只是不给开关。注意
`dsh-plugin-codegraph-project/lib/agent-tools.js:362-369` 的注释称「经 `agent.ctx` 挂 guard 在 DSH 里
不可达」，该说法**不成立**——它引用的症状是属性式 `ctx.tools` 缺 `inject` 时的报错。该插件用根 guard
是**自选**，不是平台所迫。

## 4. 事件与生效时刻

### `agent/created` 早于该 Agent 的首次装配

`agent/created` 是 **serial** 派发、监听器被逐个 `await`（`dsh-agent/lib/index.js:579`），注册时刻早于
任何 agent 创建。事件时序实测为：

```
agent/created → system-prompt/assemble → agent/pre-step
```

`dsh-agent-loop/lib/index.js:907` 先 `assemble()`，`:909` 才 `dispatch.waterfall("agent/pre-step", …)`。

因此**在该事件里落地收窄，该 Agent 的第一次装配就不含被禁工具**；挪到 `agent/pre-step` 只能影响下一次
装配（实测：`agent/created` 臂首次装配 24 个工具且不含被拒工具，`agent/pre-step` 臂为 25 个且含它）。

代价：这里的监听器**绝不许抛错**（`api-catalog.js` 事件描述：会让会话创建失败），一律 fail-open。

### waterfall 事件必须 `next()` 透传

- `EventsService.dispatch(type, args)`（`@deepseek-ai/cordis/lib/index.js:258-264`）**完全不按 `type`
  过滤**监听器 —— `type` 只用于广播 `internal/dispatch`。所以 `ctx.on(name, fn)` 注册的回调会参与该名字
  的**每一种**派发模式，包括 `waterfall`。
- `waterfall`（`:307-325`）文档原文：「不调用 `next()` 的监听器**否决链的其余部分，包括内建行为**」。

实测代价：一个只观察、既不 `next()` 也不返回值的 `system-prompt/assemble` 监听器会让宿主在
`step_start` **之前**崩于 `Cannot read properties of undefined (reading 'contexts')`。

⇒ 任何挂在 `agent/pre-step` / `system-prompt/assemble` 上的监听器**必须** `await next()` 并把返回值
原样透传（要改就在返回值上改）。「只看不改」**没有豁免**。本插件不注册这两个事件。

### 装配是冻结快照；装配后注册的工具在下一次装配可见

实测：装配完成后在 Agent 层注册一个新工具，**第 1 次装配不含它、第 2 次装配含它**。

⇒ 不存在「会漏的工具集窗口」。插件新增工具后**不必**忙着踢一次重装配；若要求「本轮就生效」，插入点
必须早于该次装配。

### 空白会话已有 live Agent

`session.create` 时就建 Agent，`agents.list()`（`dsh-agent/lib/types/index.d.ts:357`）可枚举活跃 Agent：

- `dsh-api-session-controller/lib/index.js:688` 的 `create(request)`（注释 `Create or idempotently adopt one
  ordinary Session`）在建会话时就调 `this.agents.ensureSession(sessionId, cwd, …)`（`:704`）；
- `ensureSession`（`:255`）→ `createOrAdopt`（`:414`）→ `this.ctx.agents.create({…})`（`:452`）；
- 工厂侧 `dsh-agent-loop/lib/index.js:1841` `await prepared.publish("startup")`，`publish`（`:1779-1796`）
  先 `agents.enter(agent, parentAgent)` 再 `await loopCtx.agents.announce(agent, source, …)` —— 新 Agent
  一建就发布。

⇒ 空白会话**不必等新会话**即可生效。因此本插件用「保存即重新落地、下一回合装配起生效」，而不是
「新会话生效」。

### `turn/end` 不是总线事件

`turn/end` 是 agent-loop 写进**会话记录**的条目（`dsh-agent-loop/lib/index.js:1029`
`this.session.append("turn/end", …)`），`ctx.on('turn/end', …)` **永不触发**。要在总线上观察「一轮结束」
用 `agent/turn-stopping`（`:1001`，serial）。

### `skills/change` 的监听器失败被隔离

实测：在 `skills/change` 监听器里故意抛错，会话**不受影响** —— `agent/turn-stopping` 仍到达、不产生
`agent/error`、不改变 stop reason。

⇒ 插件可以在 `skills/change` 里做较重的重算；但仍应自己兜住异常，避免半更新的内部状态。

### 清单变化同步可见

宿主侧写入 Skill 文件后，`skills/change` **同步可见**；下一个 `agent/pre-step` 的快照已含新 Skill。
因此活动中新增的、名字在关闭集里的 Skill 会**在下一次请求前**被补上 shadow。

## 5. Skill 登记表的层序与重名

- `register` 落在**本 Agent 层**（`dsh-skill/lib/index.js:195` 的 `scopeOf(this.ctx)`）。
- 层内**同名 first-wins**：`dsh-skill/lib/index.js:195-198` 遇到同层重名时静默丢弃后来者，只记一条
  warning，并返回 **no-op disposer**：

  ```js
  const existingLayer = scope === void 0 ? this.layers.global : this.layers.peek(scope)
  if (existingLayer !== void 0 && existingLayer.runtime.has(skill.name)) {
    this.ctx.logger.warn(`runtime skill "${skill.name}" ignored because it is already registered`)
    return () => {}
  }
  ```

- `collectFresh`（`:299`）的层序是 `[layers.global, ...chainLayers(options.scope)]`，**agent 层压 global 层**，
  所以 shadow 能覆盖上游那一条。

⇒ **若别的插件在本插件之前把同名 Skill 注册进同一个 Agent 层，本插件的遮蔽副本会被丢弃，该 Skill 关不掉。**
实测案例：`browser-skill` 由本机一个第三方插件在自身的 `agent/created` 里**同步**注册进 Agent 层；本插件
同在该事件里注册但要先 `await` 读两层策略，必然落后 ⇒ 该 Skill 始终关不掉。**这不是本插件引入的回归**，
该重名竞争此前同样漏掉它。

### 遮蔽的正确判据：看 `invocation`，不看名字在不在

`dsh-skill` 的 `collectFresh` 把全局层**永远先并入**，所以**名字集合不随 `scope` 变**，变的只有
`invocation` 标记。遮蔽后**名字仍在清单里**，只是标记变了。

⇒ 复验判据必须是读回的 `invocation.modelInvocable !== false`，**不能**看名字还在不在。
`applySkillShadow` 的 `verifyStillVisible` 用的就是这个判据，生产路径已传 `true`。

### 不要用「每轮先撕后贴」硬碰

用「每轮 `agent/pre-step` 先撕后贴 + 回读复验 + 失败抛错」硬碰的代价是每轮 `revision += 2N`、
`collectCache.clear()`（`dsh-skill/lib/index.js:376-380`）——**与 prompt cache 直接冲突**，且**并未真正
解决**上面 `browser-skill` 的案例。本插件**不采用**每轮重装。

复验失败的语义是**只记 warning 并保留其余生效项**，**不回滚、不抛错**：早先的「回滚 + 抛错」设计会落到
`onCreated` 的 catch 即 fail-open ⇒ **一个 Skill 都关不上**，比「少关一个」严重得多。

## 6. 依赖装配时刻

无 `connection` 的 headless profile 能正常装配。但 `apply()` 执行时**所有**待查服务都还没就绪
（实测 `services.ready` 等了约 142 ms）：

```
apply: {"fs":"absent","skills":"absent","tools":"absent","agents":"absent",
        "sandboxPolicy":"absent","connection":"absent","systemPrompt":"absent"}
services.ready: {"ready":true,"waitedMs":142}
```

⇒ 插件**必须**在 `inject` 里声明依赖，不能在 `apply()` 里直接读服务。`apply()` 里只能挂监听器、
`ctx.get()` 探测与注册 disposer。

## 7. 全局清单口径

`snapshot({})`（无 `cwd`、无 `scope`）确实不含任何工程 Skill。在带 `.dsh/skills/probe-demo` 的工程里，
`snapshot({})` 与 `snapshot({ cwd })` 的差集**恰好**是 fixture 里的那个 Skill，反向差集为空。

⇒ 「全局层清单 = `snapshot({})`」成立，**不需要**中性 cwd、也不需要自建扫描。

**一条实现前提**：`dsh-skill-filesystem/lib/index.js:810-817` 的 `findProjectRoot` 靠**从 cwd 向上找存在
`.git` 的祖先**判定工程根（只判存在，不判是否合法仓库），找不到就返回原 cwd。所以测试 fixture 若要有
工程层 Skill，必须自带一个 `.git` 标记目录。

## 8. 名称解析

MCP 工具名形如 `mcp__<server>__<raw>`。解析必须**去掉前导 `mcp__` 后取到下一个 `__` 之前**；
写成「第一个 `__` 之前」会得到 `mcp`。`serverName` 的官方正则是 `^[A-Za-z0-9_-]{1,32}$`（不允许 `__`）。
用 loader 行做交叉校验即可拿到权威 server 名集合。

---

## 附：实测方法

上述结论由两组探针在真实 headless profile 上取得，驱动命令：

```
dsh --profile headless --patch <绝对路径>/probe.patch.yml "…"
```

注意 `--patch` 接受绝对路径，不需要新建 profile。

证据面有三层，缺一不可：

1. **插件侧** `report.json` —— 状态快照 + 每条结论的 `{probe, ok, detail}`；
2. **模型面** `fake-llm-calls.json` —— 假 LLM 适配器把 `stream()` 收到的 `options` 原样落盘，含每次请求的
   `toolCount` / `toolNames` / `messages`。这是「模型到底看见什么」的**唯一**直接证据；只看插件侧状态会把
   「注册成功」误当「模型可见」；
3. **会话记录** `*.jsonl` —— `agent/turn-stopping`、`agent/status`、`agent/error` 的实际到达情况。

探针脚本与原始产物是开发期临时文件（`tmp/`，不受版本控制），未随仓库保留；本文件是它们的结论摘要。
