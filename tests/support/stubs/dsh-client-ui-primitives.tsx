import type { ReactNode } from 'react'

/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的**测试替身**（仅用于 vitest，不参与构建）。
 *
 * ## 为什么需要它
 *
 * 这个包是 `dsh.client.external` 的一项：官方语义是「由宿主 client baseline 在**运行期**
 * 提供，插件不安装它、也不打包它」。构建侧（rolldown）把它标成 external，产物里留下
 * `require("@deepseek-ai/dsh-client-ui-primitives")`，这是对的。
 *
 * 但**测试环境里没有这个 require**。实测：
 * - 本仓库的 `node_modules/@deepseek-ai/` 下**没有**这个包（它只出现在全局 pnpm store）；
 * - Vite 的解析比 Node 严格，直接从 `src/client/parts.tsx` import 它会报
 *   `Failed to resolve import "@deepseek-ai/dsh-client-ui-primitives"`，整个 DOM 用例文件无法加载；
 * - 就算把它 alias 到全局 store 里那份真实实现也不可行：那份解析出来的 **React 是 19.x**，
 *   而本仓库钉的是 React 18.3.1 —— 两套 React 同时加载会让 hooks 直接崩。
 *
 * 所以替身是正解：只提供本插件真正用到的成员（目前只有 `Tag`），保持 DOM 结构最小，
 * 让面板用例测的是**我们自己的**渲染逻辑（「来源标签」文案与位置），而不是第三方组件的内部分支。
 *
 * ## 维护约束
 *
 * 本文件只允许声明 `src/client/` 里**真实 import 过**的成员。新增一个 import 就补一个替身，
 * 否则 vitest 会因为找不到具名导出而报错（这正是期望行为：它逼着替身跟上真实用法）。
 */
export function Tag({
  tone = 'outline',
  className,
  children,
}: {
  tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
  className?: string
  children?: ReactNode
}): ReactNode {
  /*
   * 与真实基元保持**同一份签名**（`lib/types/Tag.d.ts`）：真实实现把 tone 落成
   * `data-tone` 属性并由 CSS 上色。替身必须照样把 tone 暴露在 DOM 上，否则
   * 「启用=green / 禁用=neutral」这条断言就只能测到文案、测不到语气，
   * 而语气正是这次 UI 重做要保证的东西。
   */
  return (
    <span data-testid="tag" data-tone={tone} {...(className === undefined ? {} : { className })}>
      {children}
    </span>
  )
}
