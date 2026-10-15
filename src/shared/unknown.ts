/**
 * `unknown` 收窄工具。**全仓库唯一一份**。
 *
 * 这三个函数原先在 7 个文件里各写了一份（`assembly.ts`、`routes/handlers.ts`、
 * `routes/session.ts`、`routes/register.ts`、`client/api.ts`、`client/parts.tsx`、
 * `client/CapabilityPanel.tsx`），其中 `CapabilityPanel.tsx` 那份还改名成 `asRecordOf`，
 * 让「同一份实现」看起来像「两份不同的实现」。改名本身就是「该收拢」的信号。
 *
 * 客户端与服务端共用本模块是安全的：这三个函数不依赖任何运行环境
 * （不读 `node:fs`、不碰 DOM），只是类型收窄，因此不会把宿主侧依赖拖进 client bundle。
 */

/**
 * 把 `unknown` 收成可索引记录；数组与非对象拒绝。
 *
 * **数组也必须拒绝**：数组同样能取字符串键（`arr['length']` 合法），
 * 但它不是记录——放行会让下游把「一个列表」当成「一个对象」处理。
 *
 * **不用 `as` 断言直接转型**（如 `value as Record<string, unknown>`）：
 * 断言不做运行时校验，输入是任意 JSON 时会把形状错误一路带到使用点才炸。
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** 读一个字符串字段；缺失、来源非记录、或类型不符一律返回 `null`。 */
export function readString(source: Record<string, unknown> | null, key: string): string | null {
  if (source === null) return null
  const value = source[key]
  return typeof value === 'string' ? value : null
}

/**
 * 读一个函数字段；缺失、来源非记录、或不是函数一律返回 `null`。
 *
 * 返回类型刻意用 `unknown[]` 而不是 `never[]`：`never[]` 会让**任何**带实参的调用
 * 都编译不过（`never` 不接受任何实参），于是每个调用点都要先断言一次。
 * 这里读的是宿主注入的服务方法，实参形状由各调用点自己负责。
 *
 * 参数类型同时接受 `unknown` 与 `Record<string, unknown> | null`：
 * 前一形态用于「拿到的服务是任意值」（`assembly.ts`），
 * 后一形态用于「已经收窄过一次」（`routes/session.ts`），
 * 因为 `asRecord` 的返回类型正好是可赋给前一形态的子集，两处调用点都能直接复用。
 */
export function readFunction(
  source: unknown,
  key: string,
): ((...args: unknown[]) => unknown) | null {
  const record = asRecord(source)
  if (record === null) return null
  const value = record[key]
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : null
}