/**
 * CSS Module 的类型声明。
 *
 * 类名映射在**构建期**由 lightningcss 生成（`pattern: '[hash]_[local]'`，见 `tsdown.config.ts`），
 * 运行期的值是 `{ localName: 'hashedLocalName' }`。TS 编译器看不到那一步，所以这里把
 * 「任意 `.module.css` 的默认导出」声明为「字符串到字符串的只读映射」——
 * 这正是运行期的真实形状，而不是为了通过检查而编一个更宽的类型。
 *
 * 代价：类名写错不会在编译期报错（`Record<string, string>` 的索引返回 `string | undefined`）。
 * 这是有意的取舍：类名集合要到构建期才确定，把它硬编码进 `d.ts` 会立刻与 CSS 文件脱钩。
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
