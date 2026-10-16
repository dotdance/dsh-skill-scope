import { readFile } from 'node:fs/promises'
import { transform } from 'lightningcss'
import { defineConfig, type UserConfig } from 'tsdown'

/**
 * 两个构建目标：
 * - **hostTarget**：`src/index.ts` → `lib/index.js`（ESM，node）。
 * - **clientTarget**：`src/client/index.tsx` → `lib/client.js`（CJS，browser，`__ModuleLoader__` 包装）。
 *
 * ## clientTarget 的形状是被**验证过**的，不是猜的
 *
 * 参照真实上线的 `@deepseek-ai/dsh-client-ui-shortcuts/lib/client.js`（本机
 * `~/Library/pnpm/global/.../dsh-client-ui-shortcuts/lib/client.js`）。它的首行是
 * `window.__ModuleLoader__.load({`、第二行 `id: "@deepseek-ai/dsh-client-ui-shortcuts",`、
 * 第三行 `factory: (require) => {`，内部前三行是
 * `var module = { exports: {} }; var exports = module.exports;` 与
 * `Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`，
 * 末两行是 `return module.exports;` 与 `});`。
 * banner / intro / footer 正是把这层包装**拼**出来的三个位置（rolldown 没有内建的
 * module-loader 包装）。
 *
 * `Object.defineProperty(exports, Symbol.toStringTag, ...)` 由 rolldown 自己为 CJS 输出加上，
 * **不要**手写：重复写一次会让它在产物里出现两遍，而真实产物只有一遍。
 *
 * ## `neverBundle` 与 `dsh.client.external` 是**两个不同的集合**，不要合并
 *
 * 二者曾被写成「逐项一致」，那是错的（2026-10-16 实测纠正）：
 * - `neverBundle` = **构建期**指令：命中的模块不解析、不内联，产物里留下 `require(...)`。
 * - `external` = **运行期**声明：只列 baseline **之外**的模块请求（即「我 require 了别的插件的
 *   client 半边」）。本插件没有这类依赖，所以为空。
 *
 * baseline 指宿主前端内建的种子模块表 `SZ()`（`dsh-web-frontend` 产物内），本版共 11 项：
 * `react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` / `@deepseek-ai/cordis` /
 * `zod` / `@tanstack/react-virtual` / `@deepseek-ai/dsh-client-store` /
 * `@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-primitives` /
 * `@deepseek-ai/dsh-client-ui-dockkit`。
 *
 * 这些模块**不在** `node_modules` 里（直接解析会报 MODULE_NOT_FOUND），由宿主 shell 提供。
 * 但**构建期仍必须把它们列进 `neverBundle`**，否则 rolldown 会去解析它们——
 * 而 `tsconfig.json` 的 `paths` 把 `@deepseek-ai/dsh-client-ui-primitives` 指向测试替身，
 * 结果就是**测试替身被打进发布产物**（详见下方 `CLIENT_NEVER_BUNDLE` 注释的实测记录）。
 *
 * 官方语料印证 `external` 的语义：宿主安装内 60+ 个声明 `dsh.client` 的包绝大多数不写
 * `external`（如 `dsh-client-ui-shortcuts`，它的产物照样有 `require`）；
 * 仅 6 个写，且**全部**指向另一个插件的 client 半边
 * （`@deepseek-ai/dsh-api-*` → `@deepseek-ai/dsh-api-gateway/client`）。
 */

const PLUGIN_ID = '@dotdance/dsh-skill-scope'

const CLIENT_NEVER_BUNDLE = [
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/**
 * CSS Module → 虚拟模块插件。
 *
 * **为什么自己写而不是用 `@tsdown/css`**：那个包不在本仓库的依赖白名单里。
 * 而这里要做的事很小：读文件 → `lightningcss.transform` → 拼两段 JS。
 *
 * 产出的形状（与真实产物逐字对齐）：
 * ```js
 * const css = "...";                       // 压缩后的 CSS 文本
 * const tagId = "@dotdance/dsh-skill-scope/styles.module.css";
 * if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
 *   const tag = document.createElement("style");
 *   tag.dataset.plugin = "@dotdance/dsh-skill-scope";
 *   tag.dataset.pluginCss = tagId;
 *   tag.textContent = css;
 *   document.head.appendChild(tag);
 * }
 * export default { "button": "nhfO0a_button", ... };
 * ```
 *
 * **两个 data 属性都要写**：`data-plugin-css` 是宿主卸载插件时回收样式的**唯一**依据
 * （`dsh-client-modules` 按它 find + remove），`data-plugin` 让宿主知道这堆样式属于谁。
 * 少写一个，插件卸载后样式会永久留在页面里并污染其他插件。
 *
 * **虚拟 id 必须以 `.css` 之外的字符结尾。** tsdown 在没有装 `@tsdown/css` 时会挂一个
 * `tsdown:css-guard` 插件，它的 transform 过滤器是 `/\.(?:css|less|sass|scss|styl|stylus)$/`，
 * 命中就**无条件抛错**（`build-KEepWO_k.mjs:639-650`）。这个过滤器只看**模块 id**，不看内容，
 * 所以哪怕我们的 `load` 已经返回了 JS，只要 id 还以 `.module.css` 结尾，构建就会失败。
 * 解决办法是给虚拟 id 的末尾补一个 `?dsh-css-module` 查询串，让过滤器失配。
 */
function cssModulesPlugin(): {
  name: string
  resolveId(source: string, importer: string | undefined): string | null
  load(id: string): Promise<string | null>
} {
  /** 虚拟 id 前缀；用它区分「我们的虚拟模块」与真实文件。 */
  const VIRTUAL_PREFIX = '\0dsh-css-module:'

  /** 虚拟 id 的后缀查询串，用途见上：让 tsdown 的 css-guard 过滤器失配。 */
  const VIRTUAL_SUFFIX = '?dsh-css-module'

  /** 路径归一化：只取 basename，用它拼出注入标签 id 里的文件名部分。 */
  function baseNameOf(id: string): string {
    const clean = id.split('?')[0] ?? id
    const parts = clean.split('/')
    return parts[parts.length - 1] ?? clean
  }

  return {
    name: 'dsh-skill-scope:css-modules',
    resolveId(source, importer) {
      // 任何 `*.module.css` 都接（组件目前只 import `./styles.module.css`，
      // 但把条件放宽到后缀可以避免以后加文件时忘记改这里）。
      if (!source.endsWith('.module.css')) return null
      if (!source.startsWith('.') || importer === undefined) {
        return `${VIRTUAL_PREFIX}${source}${VIRTUAL_SUFFIX}`
      }
      const base = importer.split('/').slice(0, -1).join('/')
      return `${VIRTUAL_PREFIX}${base}/${source.slice(2)}${VIRTUAL_SUFFIX}`
    },
    async load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null
      const rawPath = id.slice(VIRTUAL_PREFIX.length)
      const filePath = rawPath.endsWith(VIRTUAL_SUFFIX)
        ? rawPath.slice(0, -VIRTUAL_SUFFIX.length)
        : rawPath
      const code = await readFile(filePath)
      const result = transform({
        filename: filePath,
        code,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      // `transform()` 的返回类型把 `exports` 声明成 `void | CSSModuleExports`：lightningcss 的
      // .d.ts 是为「只有开了 cssModules 才有 exports」这层语义留的余地，却没有用重载表达它。
      // 我们**确实**开了 `cssModules`，所以运行期必然是对象。这里显式收窄并抛错，
      // 而不是用类型断言把它按下去——这样类型系统还能守住 `entry.name` 这一层。
      const moduleExports = result.exports
      if (moduleExports === undefined) {
        throw new Error(`lightningcss 没有为 ${filePath} 生成 CSS Module exports`)
      }
      // 每个值是 `{ name, composes, isReferenced }`；只取 `name`。
      const classes: Record<string, string> = {}
      for (const [local, entry] of Object.entries(moduleExports)) {
        classes[local] = entry.name
      }
      const css = result.code.toString()
      const tagId = `${PLUGIN_ID}/${baseNameOf(filePath)}`
      return [
        `const css = ${JSON.stringify(css)};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
        '\tconst tag = document.createElement("style");',
        `\ttag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
        '\ttag.dataset.pluginCss = tagId;',
        '\ttag.textContent = css;',
        '\tdocument.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }
}

/**
 * Host 目标。**保持 Phase A/B 的原样**（entry/outDir/format/platform 一字未改），
 * 只把它从默认导出挪进数组——两个目标必须一起返回，否则 `pnpm run build` 只会出一个产物。
 */
const hostTarget: UserConfig = {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

/**
 * Client 目标。
 *
 * `entry` 用 `{ client: 'src/client/index.tsx' }`（对象形式）而不是数组：
 * `outputOptions.entryFileNames` 固定成 `client.js`，而 `package.json` 的
 * `exports["./client"] = "./lib/client.js"` 必须**逐字**命中它。
 *
 * `fixedExtension: false` 是必须的：默认行为会给 CJS 产物加 `.cjs` 后缀，
 * 那样产物会变成 `lib/client.cjs`，与 `exports` 和 `dsh.client` 的期望都不符。
 */
const clientTarget: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  fixedExtension: false,
  // 必须用 CLIENT_NEVER_BUNDLE（构建期指令），不要拿 package.json 的 external 来推。
  deps: { neverBundle: [...CLIENT_NEVER_BUNDLE] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: "${PLUGIN_ID}", factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
  plugins: [cssModulesPlugin()],
}

export default defineConfig([hostTarget, clientTarget])
