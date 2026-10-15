<div align="center">

# dsh-skill-scope: DSH Skill 与 MCP 管控面板

[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
&nbsp;
![platform](https://img.shields.io/badge/platform-DSH%20Web%20GUI-4c6ef5?style=flat-square&labelColor=454a54)
&nbsp;
![node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-3c873a?style=flat-square&labelColor=454a54)

**全局 + 项目粒度 skill/mcp 一键启停**

[English](README.en.md) · **简体中文**
</div>

---

## 一、它解决什么问题

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

## 二、它能做什么

### 1. 全局面板——一次收掉所有工程都不需要的能力

点左侧栏的「**全局 Skills**」，打开一个原生主界面页面，列出**全局层**的全部 Skill 与 MCP server。
在这里关掉的名字，**对所有工作区生效**，是硬上限。

![两个入口：侧栏的 Global Skills 与输入框右侧的 Workspace Skills](assets/panel-global.png)

上图红圈标出两个入口：左侧栏的 **Global Skills**，和输入框右下角的 **Workspace Skills**。

- 顶部一排是**视图切换**（全部 / 已启用 / 已禁用）——它只筛列表，不改任何开关。
- 搜索框**同时筛 Skill 与 MCP 两段**，输入即过滤。
- 列表按来源分组折叠，长清单也能快速定位。

### 2. 本工程面板——只给这一个项目留要用的能力

在**新会话**的输入框右下角点「**工作区 Skills**」，打开本工程弹层（浮动在当前界面之上）：

![本工程面板](assets/panel-project.png)

图中列表标题写明「只影响 default-workspace」，下半部分按来源分组：本例里 `.agents` 目录贡献 35 项。

- 被全局关掉的项**根本不进这个列表**，所以列表比全局面板短是正常的，不是丢数据。
- 改动**只对本工程的新会话生效**，不影响别的项目。

### 3. 关键规则：全局是硬上限，工程只能往下收

```text
      磁盘上的全部 Skill 与 MCP
                │
                ▼
      ┌─────────────────────┐
      │  全局层（硬上限）    │   关掉 = 任何工程都用不了
      └─────────────────────┘
                │  剩下的
                ▼
      ┌─────────────────────┐
      │  工程层（再收窄）    │   只能继续关，不能把全局关掉的打开
      └─────────────────────┘
                │
                ▼
         这一轮模型真正看得见的集合
```

### 4. 关掉 ≠ 删掉：手动调用永远还在

关掉一个 Skill 只把它的**模型自动调用**关掉。你仍然可以在会话里手敲 `/名字` 调用它。

---

## 三、安装

```sh
dsh plugin --profile web add dsh-skill-scope
```

`--profile web` 换成你自己的 profile 名即可。
