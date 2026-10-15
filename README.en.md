<div align="center">

# dsh-skill-scope: a Skill and MCP control panel for DSH

[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
&nbsp;
![platform](https://img.shields.io/badge/platform-DSH%20Web%20GUI-4c6ef5?style=flat-square&labelColor=454a54)
&nbsp;
![node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-3c873a?style=flat-square&labelColor=454a54)

**One-click toggles for skills and MCP at both global and project scope**

**English** · [简体中文](README.md)
</div>

---

## 1. The problem it solves

The more you install in DSH, the longer the list your agent has to read every turn.

- Your user-level skill directory accumulates **N+ skills**, of which only a few help the task at hand.
- Every MCP server pushes **all of its tools** into the model's tool table, even when none are used this turn.
- A coding project and a writing workspace need **entirely different** skills and MCP servers.
- You want "this project uses only these capabilities", but there is no switch for that — an installed skill is globally visible.

The cost is not cosmetic. It is real:

| Cost | Why |
| --- | --- |
| **Burned tokens** | The skill list and the MCP tool table re-enter context every turn; the more you install, the higher the fixed per-turn overhead |
| **Diluted attention** | Too many candidates make the model likelier to pick the wrong tool or miss the relevant one |
| **An unclean context** | Unrelated capabilities mixed into the prompt make results harder to predict and harder to debug |
| **Cross-project contamination** | A capability only project A needs keeps occupying space in project B |

**dsh-skill-scope exists for exactly this**: it turns "which skills and MCP servers the model can call" into a set of
visible, clickable switches, managed separately at **global** and **per-workspace** scope.

---

## 2. What it does

### 1. The global panel — switch off everything no project needs

Click **Global Skills** in the left sidebar to open a native main-view page listing everything at the
**global layer**, skills and MCP servers alike. Anything you switch off here **applies to every workspace**, and is a hard ceiling.

![Two entry points: Global Skills in the sidebar and Workspace Skills beside the input box](assets/panel-global.png)

The red circles above mark the two entry points: **Global Skills** in the left sidebar, and **Workspace Skills** at the bottom right of the input box.

- The row at the top is a **view filter** (All / Enabled / Disabled) — it only filters the list, it changes no switch.
- The search box **filters both the Skill and the MCP sections**, live as you type.
- The list groups and collapses by source, so even a long inventory stays navigable.

### 2. The project panel — keep only what this one project needs

In a **new session**, click **Workspace Skills** at the bottom right of the input box to open the project-scoped overlay (it floats above the current view):

![The project capabilities panel](assets/panel-project.png)

The panel title states that it affects `default-workspace` only, and the lower part groups items by source: in this example the `.agents` directory contributes 35 of them.

- Items switched off globally **never reach this list at all**, so a shorter list than the global panel is expected, not lost data.
- Changes **apply only to new sessions in this project** and affect no other project.

### 3. The key rule: global is a hard ceiling, projects can only narrow further

```text
      Every skill and MCP server on disk
                │
                ▼
      ┌─────────────────────┐
      │  Global (hard cap)  │   off = no project can use it
      └─────────────────────┘
                │  what remains
                ▼
      ┌─────────────────────┐
      │  Project (narrow)   │   can only switch more off;
      └─────────────────────┘   cannot re-enable a globally disabled item
                │
                ▼
      The set the model actually sees this turn
```

### 4. Off is not deleted: manual invocation always remains

Switching a skill off only disables its **automatic invocation by the model**. You can still call it by typing `/name` in a session.

---

## 3. Installation

```sh
dsh plugin --profile web add dsh-skill-scope
```

Replace `--profile web` with the name of your own profile.
