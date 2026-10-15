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
const TAG_ID = 'dsh-skill-scope/styles.module.css'

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

    expect(registered.map((r) => r.id)).toEqual(['dsh-skill-scope'])
  })

  it('starts with the pinned wrapper banner', () => {
    const head = readBundle().slice(0, 200)

    expect(head.startsWith('window.__ModuleLoader__.load({')).toBe(true)
    expect(head).toContain('id: "dsh-skill-scope"')
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
     * **这条断言为什么要改（2026-10-12 由 lead 裁定，证据如下）**
     *
     * 它原来要求产物同时 require `dsh.client.external` 里那**三项**。那是把
     * `external` 当成了「要合成的 require 清单」，而它实际是**运行期可用性/放行清单**。
     * 真实证据：官方 `@deepseek-ai/dsh-client-ui-shortcuts/lib/client.js` 只 require 自己
     * 源码真正用到的模块（`dsh-client-store`、`dsh-client-ui-primitives`、`react`、
     * `react/jsx-runtime`），而它的 `package.json` **根本没有 `dsh.client.external` 字段**。
     * 即：**require 集合由源码的 import 决定，不由 external 清单决定。**
     *
     * 因此原写法有一条**无法满足**的分支：`@deepseek-ai/dsh-client-runtime/client` 在本机
     * `require.resolve` 直接 MISSING（哪都没有这个包），本插件也没有任何用途需要它。
     * 要让它出现在产物里，只能凭空 import 一个不存在的包——那会让产物在真实宿主里**加载失败**，
     * 远比放宽这条断言糟糕。`neverBundle` 保留三项：清单里多一个未用项无害，
     * 合成一个取不到的 require 有害。
     *
     * 现在钉的是「插件真的用到的那个外部依赖必须有 require」——符合官方机制，
     * 也正是 `dsh.client.external` 声明该包的意义（声明为外部 + 真的 require 它，
     * 才说明这份声明不是空话）。react / react/jsx-runtime 由 client baseline 提供，一并断言。
     */
    expect(requested).toContain('@deepseek-ai/dsh-client-ui-primitives')
    expect(requested).toContain('react')
    expect(requested).toContain('react/jsx-runtime')
  })

  it('injects the compiled CSS module with both pinned data attributes', () => {
    const source = readBundle()

    expect(source).toContain('data-plugin-css')
    expect(source).toContain(TAG_ID)
    expect(source).toContain('"dsh-skill-scope"')
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
     * **哈希段必须是 `[A-Za-z0-9]+`，不能写成 `[a-z0-9]+`**（2026-10-15 实测修正）。
     * lightningcss 的 `[hash]` 是 **base62 大小写混合**的，本机实测产物给出的是
     * `p4Fk8G`、`EcQGha` 这类值，含大写 `F`/`G`。写死小写会让这条正则**一个都匹配不到**，
     * 于是 `defined` 为空、第 180 行断言失败——而失败信息只说「expected 0 to be greater than 0」，
     * 完全不指向真正的原因（大小写假设错了）。
     */
    const defined = new Set<string>()
    for (const match of source.matchAll(/"([A-Za-z0-9]+)_([A-Za-z_$][\w$]*)"/g)) {
      if (match[2] !== undefined) defined.add(match[2])
    }

    // 两个集合都非空，否则正则会静默失配、这条用例变成永远通过的假绿。
    expect(used.size).toBeGreaterThan(0)
    expect(defined.size).toBeGreaterThan(0)

    const missing = [...used].filter((name) => !defined.has(name)).sort()
    expect(missing).toEqual([])
  })
})
