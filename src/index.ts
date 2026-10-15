import type { Context } from '@deepseek-ai/cordis'
import { assemble, type AssemblyContext } from './assembly.ts'

/** 插件名，同时是 client bundle 的 id 与 `dsh.client` 的包 id。 */
export const name = 'dsh-skill-scope'

/**
 * 需要的宿主服务。
 *
 * `skills` / `tools` / `agents` 是**硬依赖**：清单读取与收窄动作都取不到替代（设计 5.1）。
 *
 * 刻意**不**注入的服务，各有理由：
 * - 不含 `systemPrompt`：本插件不接管装配瀑布（设计 5.1 / 5.2）。收窄在 `agent/created`
 *   一次性落地，`agent/created` 是 serial 派发，因此必然早于该 Agent 首次装配。
 * - 不含 `fs`：策略读写走宿主侧 `node:fs` + `writeFileAtomic` + `withFileLock`，
 *   不经过 `ctx.fs`；`sandboxPolicy` 服务同样作废（见 `docs/dsh-runtime-facts.md` §1）。
 * - 不含 `connection`：无连接服务的 profile（headless）也必须能装配（不变量 12）。
 *   路由用 `ctx.inject(['connection'], …)` 做**可选嵌套注入**，缺了只跳过路由。
 * - 不含 `sessionQuery` / `agents` 之外的会话相关服务：`/workspace` 路由用 `ctx.get()`
 *   按需读（可选依赖）。**不能写进 `inject`**：headless profile 没有 `sessionQuery`，
 *   写进去会让插件停在 waiting 状态而整个加载不出来。
 */
export const inject = ['skills', 'tools', 'agents'] as const

/**
 * 组装 Host 半边：建策略存储与 Agent 状态 → 装事件钩子 → 注册四条 API 路由。
 *
 * 顺序有依赖，且每一步都要 fail-open：**任何可选的缺失只降级对应功能并记 warning，
 * 绝不让插件加载失败**。硬依赖由 `inject` 保证到场，因此这里不做抛错式校验。
 *
 * `connection` 走 `ctx.inject` 嵌套注入而不是顶层 `inject`，理由见 `inject` 的注释。
 */
export function apply(ctx: Context): void {
  const assembly = assemble(ctx as unknown as AssemblyContext)
  ctx.effect(() => assembly.disposeHooks)
  ctx.effect(() => assembly.disposeRoutes)
  ctx.logger.info(`${name}: applied`)
}
