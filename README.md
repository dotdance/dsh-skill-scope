<div align="center">

# dsh-skill-scope: DSH Skill 与 MCP 管控面板

[![许可证：MIT](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-blue.svg)](LICENSE)
[![npm package](https://img.shields.io/npm/v/%40dotdance%2Fdsh-skill-scope.svg?label=npm%20package)](https://www.npmjs.com/package/@dotdance/dsh-skill-scope)
[![npm 下载量](https://img.shields.io/npm/dt/%40dotdance%2Fdsh-skill-scope.svg?label=npm%20%E4%B8%8B%E8%BD%BD%E9%87%8F)](https://www.npmjs.com/package/@dotdance/dsh-skill-scope)
[![DSH Web Plugin](https://img.shields.io/badge/DSH%20Web-Plugin-0f766e.svg)](https://github.com/dotdance/dsh-skill-scope)
[![DSH >= 0.2.0-rc.2](https://img.shields.io/badge/DSH-%3E%3D%200.2.0--rc.2-2563eb.svg)](#安装)
![node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-3c873a.svg)

**全局 + 项目粒度 skill/mcp 一键启停**

[English](README.en.md) · **简体中文**
</div>

---

## 安装

```sh
dsh plugin --profile web add @dotdance/dsh-skill-scope
```

`--profile web` 换成你自己的 profile 名即可。


## 它解决什么问题

你在 DSH 里装得越多，Agent 每一轮要读的清单就越长。

- 用户级 Skill 目录里堆了 **N+ Skill**，其中能帮到当前这个任务的只有几个。
- 每个 MCP server 都会把它的**全部工具**塞进模型的工具表，哪怕这一轮一个都用不上。
- 写代码的工程和写文章的工作区，需要的 Skill 和 MCP **根本不是同一套**。
- 你想「这个项目就用这几个能力」，但官方没有给任何开关——Skill 装上就是全局可见。

后果不是"不好看"，而是实打实的成本：

| 代价 | 说明 |
| --- | --- |
| **烧 Token** | Skill 目录与 MCP 工具表每一轮都要重新进上下文，装的越多，每一轮固定开销越大 |
| **注意力被稀释** | 候选太多，模型更容易选错工具、漏掉真正相关的那个 |
| **上下文不干净** | 无关能力混进提示词，结果更难预测，调试更难 |
| **工程之间互相污染** | A 项目的专用能力，在 B 项目里也一直占着位置 |

**dsh-skill-scope 就是为这件事做的**：把「模型能调用哪些 Skill 与 MCP」变成一组
看得见、点得动的开关，并按**全局**和**本工作区**两个粒度分别管理。

---

## 它能做什么

### 1. 全局面板——一次收掉所有工程都不需要的能力

点左侧栏的「**全局 Skills**」，打开一个原生主界面页面，列出**全局层**的全部 Skill 与 MCP server。
在这里关掉的名字**默认对所有工作区生效**；某个工程确实需要时，可以在本工程里单独把它打开（见下文第 3 条）。

![两个入口：侧栏的 Global Skills 与输入框右侧的 Workspace Skills](assets/panel-global.png)

上图红圈标出两个入口：左侧栏的 **Global Skills**，和输入框右下角的 **Workspace Skills**。

- 顶部一排是**视图切换**（全部 / 已启用 / 已禁用）——它只筛列表，不改任何开关。
- 搜索框**同时筛 Skill 与 MCP 两段**，输入即过滤。
- 列表按来源分组折叠，长清单也能快速定位。

**官方 Skill 默认不列**：`@deepseek-ai` 官方包自带的 Skill（`cordis-*` 预设、`office-*` 等）
默认不出现在面板上，模型仍可自动调用它们。想看见、想关掉它们时，打开视图条右端的
「**显示官方 Skill**」开关：这些行会回到清单，与普通行一样可以逐项关闭。
这个开关是**单机级**的（存在 `$DSH_HOME/skill-scope/global.json`），全局与本工程两个面板
都展示它、值永远一致；在工作区面板里打开它，效果同样对所有工程生效。

### 2. 本工程面板——只给这一个项目留要用的能力

在**新会话**的输入框右下角点「**工作区 Skills**」，打开本工程弹层（浮动在当前界面之上）：

![本工程面板](assets/panel-project.png)

图中列表标题写明「只影响 default-workspace」，下半部分按来源分组：本例里 `.agents` 目录贡献 35 项。

- 列表与全局面板**同一份清单**：全局关掉的项也在里面（开关是关的），你可以直接在这里把它打开。
- 与全局设置不同的行带一个红色标记「**与全局不同**」，一眼看出这个工程动过什么。
- 视图条除「全部 / 已启用 / 已禁用」外多一个「**与全局不同**」：点它只剩本工程改过的项（清单长时好用）。
- 改动**只对本工程的新会话生效**，不影响别的项目。

### 3. 关键规则：全局给默认值，工程可以逐项改

```text
      磁盘上的全部 Skill 与 MCP
                │
                ▼
      ┌─────────────────────┐
      │  全局层（默认值）    │   关掉 = 默认任何工程都用不了
      └─────────────────────┘
                │  逐项：跟随 / 打开 / 关闭
                ▼
      ┌─────────────────────┐
      │  工程层（可覆盖）    │   全局关的能打开，全局开的也能关掉
      └─────────────────────┘
                │
                ▼
          这一轮模型真正看得见的集合
```

每一项在本工程里有三种状态。界面上只有开关一种动作，因为「跟随全局」用**不记这条**来表达：

| 状态 | 含义 | 界面上怎么看出来 |
| --- | --- | --- |
| 跟随全局 | 本工程对这项没有主张 | 开关位置与全局一致，没有红标 |
| 本工程打开 | 全局关着，这个工程要用 | 开关是开的 + 红标「与全局不同」 |
| 本工程关闭 | 全局开着，这个工程不要 | 开关是关的 + 红标「与全局不同」 |

想改回「跟随全局」：把开关拨回全局的样子即可，红标消失，这条决定也随之删除。

### 关掉 ≠ 删掉：手动调用永远还在

关掉一个 Skill 只把它的**模型自动调用**关掉。你仍然可以在会话里手敲 `/名字` 调用它。

---
