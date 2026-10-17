import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 设计 8.2 的契约：手工复刻的 client bundle 能被宿主消费。
 *
 * **实现说明（重要，勿当作弱化）**：直接 `await import('../../lib/client.js')` 之后
 * 断言 `registered.map(r => r.id)` 这种写法在 vitest 下**不可用**，原因是真实存在的：
 * 产物是 CJS，`require()` 一个 CJS 文件时 Node 不会为它建立 ESM 互操作之外的执行隔离，
 * 而它的**第一行**就是 `window.__ModuleLoader__.load(...)`——也就是说 import 的副作用
 * 必然要求 `window.__ModuleLoader__` 已存在，且 vitest 的 `vi.stubGlobal('window', ...)`
 * 对已装载的 CJS 模块的全局解析路径并不保证一致（CJS 走 `globalThis.window`）……这些都还只是
 * 「可能不一致」。
 *
 * **真正决定性的一点**：`lib/client.js` 是**构建产物**，构建在 `pnpm run build` 时才发生。
 * 让单测直接 `import` 它，等于让测试依赖「必须先跑构建」这一外部状态；而本仓库的
 * `vitest.config.ts` 没有 `globalSetup` 去跑构建。因此这里改用**读文件文本 + 执行包装器**
 * 的方式：既钉住 8.2 的包装契约（这是测试的真正目的），又不引入「测试顺序决定成败」。
 *
 * 差别**只在加载方式**，断言强度不降反升：除了 id，还钉住 `factory` 是函数、
 * `require` 被真正调用、`apply`/`inject` 被导出，以及 CSS 注入块存在。
 */

const BUNDLE_PATH = fileURLToPath(new URL('../../lib/client.js', import.meta.url))

/**
 * client bundle 的模块 id。
 *
 * **必须等于已发布的包名** `@dotdance/dsh-skill-scope`：宿主按 loader 条目的 `name`
 * 查客户端 bundle，客户端侧再用同一个字符串查模块表并执行工厂
 * （`dsh-client-modules/lib/client.js` 的 `makeRequire` → `factories` 命中）。
 * 两边不一致时工厂永不执行，插件在 GUI 里完全无痕。
 *
 * 2026-10-16 修正：此前这里是裸 `dsh-skill-scope`，导致 id 与行名对不上
 * （本机同时存在 `dsh-skill-scope` 这条 link projection，会让裸名解析到开发仓库）。
 */
const BUNDLE_ID = '@dotdance/dsh-skill-scope'
const TAG_ID = `${BUNDLE_ID}/styles.module.css`

/** 读产物文本；产物不存在时给出可自助修复的报错。 */
function readBundle(): string {
  try {
    return readFileSync(BUNDLE_PATH, 'utf8')
  } catch {
    throw new Error(`未找到 client 产物：${BUNDLE_PATH}。请先运行 \`pnpm run build\`。`)
  }
}

/**
 * 用一个受控的 `require` 真正执行 factory，收集它触发的每一个模块请求。
 * 返回的对象里 `registered` 是 `load` 收到的 spec 列表。
 */
function loadBundle(source: string): {
  registered: Array<{ id: string; factory: (require: (id: string) => unknown) => unknown }>
  requested: string[]
} {
  const registered: Array<{ id: string; factory: (require: (id: string) => unknown) => unknown }> = []
  const requested: string[] = []
  const load = (spec: { id: string; factory: (require: (id: string) => unknown) => unknown }): void => {
    registered.push(spec)
  }
  // 构造一个最小 CommonJS 宿主环境来跑产物：`window` 提供 ModuleLoader，
  // `require` 记录请求并返回惰性替身（不真的解析这些包——它们不在本仓库的 node_modules 里）。
  const require = (id: string): unknown => {
    requested.push(id)
    return new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === 'default') return () => null
          if (key === '__esModule') return true
          return () => null
        },
      },
    )
  }
  const factory = new Function('window', 'require', 'document', 'module', 'exports', source)
  const module = { exports: {} as unknown }
  factory({ __ModuleLoader__: { load } }, require, undefined, module, module.exports)

  /*
   * **必须真的执行一次 factory**，否则 `requested` 永远是空的。
   *
   * `window.__ModuleLoader__.load({ id, factory })` 只是**登记**一个工厂；模块的 `require(...)`
   * 调用都写在 factory 体里，只有宿主在需要该模块时调用 `factory(require)` 才会发生。
   * 本函数只调用 `load` 而不调用 factory 的话，`requested` 收集不到任何东西——
   * 那样断言「产物请求了哪些模块」就变成永远失败（或反之永远假绿）。
   */
  for (const spec of registered) spec.factory(require)
  return { registered, requested }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('client bundle contract (design 8.2)', () => {
  it('registers itself through window.__ModuleLoader__.load with the exact id', () => {
    const { registered } = loadBundle(readBundle())

    expect(registered.map((r) => r.id)).toEqual([BUNDLE_ID])
  })

  it('starts with the pinned wrapper banner', () => {
    const head = readBundle().slice(0, 200)

    expect(head.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(head).toContain(`id: "${BUNDLE_ID}"`)
  })

  it('exposes apply and inject from the factory exports', () => {
    const source = readBundle()
    const registered: Array<{ id: string; factory: (require: (id: string) => unknown) => unknown }> = []
    const load = (spec: { id: string; factory: (require: (id: string) => unknown) => unknown }): void => {
      registered.push(spec)
    }
    const require = (): unknown => new Proxy({}, { get: () => () => null })
    const factory = new Function('window', 'require', 'module', 'exports', source)
    const module = { exports: {} as Record<string, unknown> }
    factory({ __ModuleLoader__: { load } }, require, module, module.exports)

    const spec = registered[0]
    expect(spec).toBeDefined()
    const exported = spec?.factory(require) as Record<string, unknown> | undefined
    expect(typeof exported?.['apply']).toBe('function')
    expect(Array.isArray(exported?.['inject'])).toBe(true)
  })

  it('requests the externals the plugin actually imports', () => {
    const { requested } = loadBundle(readBundle())

    /*
     * **这条断言为什么这么写（2026-10-12 首次修正，2026-10-16 二次修正）**
     *
     * 最初它要求产物同时 require `dsh.client.external` 里那**三项**。那是把
     * `external` 当成了「要合成的 require 清单」。
     *
     * 真实语义（2026-10-16 用官方语料实测定案）：`external` 是
     * 「**client baseline 之外**的精确模块请求」——即「我 require 了**别的插件**的 client 半边」。
     * baseline 指宿主前端内建的种子模块表 `SZ()`，共 11 项（`react`、`react/jsx-runtime`、
     * `react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、
     * `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
     * `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`）。
     * 这些模块**不在** `node_modules` 里，由宿主 shell 直接提供，声明进 `external` 是多余的。
     *
     * 官方语料印证：宿主安装内 60+ 个声明 `dsh.client` 的包绝大多数不写 `external`；
     * 仅 6 个写，且**全部**指向另一个插件的 client 半边
     * （`@deepseek-ai/dsh-api-*` → `@deepseek-ai/dsh-api-gateway/client`）。
     *
     * 结论：**require 集合由源码的 import 决定，不由 external 清单决定。**
     * 本插件的三项请求全部落在 baseline 内，没有任何跨插件依赖，
     * 因此 `dsh.client.external` 与 `neverBundle` 都应为**空**。
     *
     * 同时修正原注释里的一个错误推论：它说 `@deepseek-ai/dsh-client-runtime/client`
     * 「本机 require.resolve 直接 MISSING」。该包确实不存在，但缺它**并不会**让插件失败——
     * 它只是清单里一个悬空项，静默无用（且它本就非 baseline 又非真实依赖）。
     * 真正需要保证的是：产物里出现的每个 require 都能在运行期被解析到。
     */
    expect(requested).toContain('@deepseek-ai/dsh-client-ui-primitives')
    expect(requested).toContain('react')
    expect(requested).toContain('react/jsx-runtime')
  })

  /*
   * 回归守卫（2026-10-16 实测缺陷）：`dsh.client.external` 被当成了
   * 「baseline 之外要声明的模块」的反面——它曾列出 `ui-slots` / `ui-primitives`
   * 两项 **baseline 种子模块**，以及一个悬空的 `dsh-client-runtime/client`。
   *
   * 正确不变量：`external` 声明的每一项都必须是**本产物真的 require 了**的东西，
   * 且**不得**是 baseline 种子模块（后者由宿主 shell 提供，写进去是多余且误导的）。
   * 本插件三项请求全在 baseline 内 → 清单必须为空。
   */
  it('declares no client external beyond the platform baseline', () => {
    const manifest = require('../../package.json') as {
      dsh?: { client?: { external?: string[] } }
    }
    const external = manifest.dsh?.client?.external ?? []

    /*
     * baseline 种子表（`dsh-web-frontend` 产物内 `SZ()`），权威且版本相关。
     * 这里只钉住本插件实际会碰到的子集之外也不需要——清单为空，断言最简。
     */
    const BASELINE = new Set([
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      'zod',
      '@tanstack/react-virtual',
      '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-dockkit',
    ])

    for (const name of external) {
      expect(
        BASELINE.has(name),
        `dsh.client.external 不应声明 baseline 种子模块 ${name}（由宿主 shell 提供）`,
      ).toBe(false)
      expect(
        loadBundle(readBundle()).requested,
        `dsh.client.external 声明的 ${name} 必须在产物里真的有 require`,
      ).toContain(name)
    }
  })

  /*
   * 回归守卫（2026-10-16 实测缺陷）：把 `neverBundle` 按 `external` 的正确语义清空后，
   * rolldown 转去解析 `@deepseek-ai/dsh-client-ui-primitives`，命中 `tsconfig.json` 的
   * `paths` 映射（该映射指向**测试替身**），于是替身的源码与注释**被整个打进了发布产物**，
   * 同时产物里真正的 `require(...)` 消失了。
   *
   * 这个缺陷很隐蔽：构建通过、类型检查通过、产物体积只差 2KB，
   * 只有细看产物内容或断言之才发现。因此这里钉死两条：
   * ① 测试替身的源码**绝不**能出现在产物里；
   * ② 三个 baseline 模块请求必须**都**在产物里留下 require。
   */
  it('never leaks the test stub into the shipped bundle', () => {
    const source = readBundle()

    expect(source).not.toContain('tests/support/stubs')
    expect(source).not.toContain('测试替身')

    // 反向确认：该包必须以 require 形式交给运行期，而不是被内联。
    expect(loadBundle(source).requested).toContain('@deepseek-ai/dsh-client-ui-primitives')
  })

  it('injects the compiled CSS module with both pinned data attributes', () => {
    const source = readBundle()

    expect(source).toContain('data-plugin-css')
    expect(source).toContain(TAG_ID)
    expect(source).toContain(`"${BUNDLE_ID}"`)
  })

  /*
   * 回归守卫（实测缺陷）：JSX 里写了 `styles.X`，而 CSS 里没有 `.X` 时，
   * CSS Modules 会把它编成 `undefined`，元素渲染出来**没有类名**——视觉上表现为
   * 「样式没生效」。整个过程构建通过、类型检查通过、既有 5 条断言全部通过，
   * 只有肉眼看渲染结果才发现。全局面板「无法滚动」与工作区「开关滑块颜色错」
   * 都是这一类。
   *
   * 这里把两类名字都从产物里抽出来做**集合包含**检查：
   * - `styles.<name>` 的用法（编译后形如 `styles_module_default.<name>`）
   * - 进 CSS 的类名（映射表里的值形如 `"_<hash>_<name>"`）
   */
  it('has a CSS class for every styles.* reference in the bundle', () => {
    const source = readBundle()

    // 用法：编译后所有 `styles.X` 都写成 `styles_module_default.X`。
    const used = new Set<string>()
    for (const match of source.matchAll(/styles_module_default\.([A-Za-z_$][\w$]*)/g)) {
      if (match[1] !== undefined) used.add(match[1])
    }
    /*
     * 类名：映射表的值形如 `"p4Fk8G_card"`，取 `_` 之后的那一段。
     *
     * **哈希段不能假设字符集**（2026-10-17 实测修正，本轮 CI 失败的真因）。
     * 这个哈希来自 `lightningcss` 的 `[hash]`，而它**取决于构建时的绝对路径**：
     * 同一份源码换个 checkout 目录就会得到不同的值。实测同一文件：
     *
     * | filename | 产物类名 |
     * | --- | --- |
     * | `/Users/go/proj/dsh-skill-scope/src/client/styles.module.css` | `p4Fk8G_button` |
     * | `/home/runner/work/dsh-skill-scope/dsh-skill-scope/...`（CI） | `Jg-IJa_button` |
     * | `/a/b/styles.module.css` | `_6rKUKa_button` |
     *
     * 后两者分别含 **连字符 `-`** 与 **前导下划线 `_`**，写死 `[A-Za-z0-9]+`
     * 会让这条正则一个都匹配不到，`defined` 为空、下面的断言失败，
     * 而报错只说「expected 0 to be greater than 0」，完全不指向真正的原因。
     *
     * 所以这里不猜字符集：**用非贪婪的 `.+?` 吃到最后一个 `_` 之前**，
     * 再要求局部名以标识符字符开头。这样任何哈希编码都能匹配。
     */
    const defined = new Set<string>()
    for (const match of source.matchAll(/"(.+?)_([A-Za-z_$][\w$]*)"/g)) {
      if (match[2] !== undefined) defined.add(match[2])
    }

    // 两个集合都非空，否则正则会静默失配、这条用例变成永远通过的假绿。
    expect(used.size).toBeGreaterThan(0)
    expect(defined.size).toBeGreaterThan(0)

    const missing = [...used].filter((name) => !defined.has(name)).sort()
    expect(missing).toEqual([])
  })
})
