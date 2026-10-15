import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    /**
     * `@deepseek-ai/dsh-client-ui-primitives` 是 `dsh.client.external`：
     * 运行期由宿主 client baseline 提供，本仓库不安装它。构建侧（rolldown）把它标成
     * external 是正确的；但**测试环境里没有这个 require**，Vite 的解析比 Node 严格，
     * 直接从 `src/client/parts.tsx` import 会让整个 DOM 用例文件加载失败。
     *
     * 因此测试里把它指到替身（只含真实用到的成员）。
     * **不能** alias 到全局 store 里那份真实实现：那份解析出来的 React 是 19.x，
     * 与仓库钉的 React 18.3.1 冲突，两套 React 会让 hooks 崩掉。
     */
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./tests/support/stubs/dsh-client-ui-primitives.tsx', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    // 默认 node 环境；需要 DOM 的用例在文件首行加 `// @vitest-environment jsdom`。
    environment: 'node',
    /**
     * 只给 DOM 用例补 jest-dom 匹配器（`toHaveAttribute` 等）。
     *
     * 面板用例用了 `toHaveAttribute`，而 vitest 内置的是 chai 的 `toHaveProperty`
     * 语义 —— 名字相近但**不兼容**（chai 会报 `Invalid Chai property: toHaveAttribute`）。
     * 这个 setup 文件把标准匹配器装上。
     *
     * 放在 setupFiles 而不是某个 spec 顶部：DOM 用例分布在多个文件，逐个 import 容易漏；
     * setup 文件在 node 环境里同样安全（只是多注册几个匹配器）。
     */
    setupFiles: ['tests/support/setup-dom.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
    },
  },
})
