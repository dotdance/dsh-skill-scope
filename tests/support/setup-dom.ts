/**
 * Vitest 全局 setup：补上 DOM 匹配器。
 *
 * `@testing-library/jest-dom` 提供 `toHaveAttribute` / `toHaveTextContent` 等断言。
 * 它必须在断言执行前 import 一次以完成注册；装在 `setupFiles` 里可以让全部
 * DOM 用例共享，不必在 4 个 spec 文件里各写一行（漏一个就会得到
 * `Invalid Chai property: toHaveAttribute` 这种令人困惑的报错）。
 *
 * node 环境（非 DOM 的用例）下 import 它同样无害：它只注册匹配器，不碰 DOM。
 *
 * `@testing-library/jest-dom` 7.x 不导出默认对象，所以**不能**写成
 * `import matchers from '...'` 再 `expect.extend(matchers)`；直接 import 副作用即可。
 */
import '@testing-library/jest-dom/vitest'
