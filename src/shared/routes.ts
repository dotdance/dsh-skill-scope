/**
 * 插件自有四条路由的**路径段**（不含前导斜杠）。
 *
 * 宿主侧注册与客户端请求必须逐字符一致，否则**静默落 404**：
 * - 宿主：`HostConnectionFetch.register({ path })` 的键是完整 pathname
 *   （`fetchRoutes.get(url.pathname)`），所以注册时要补 `/`，得到 `/api/skill-scope/global`；
 * - 客户端：`post()` 内部同样补 `/`（`fetch('/' + route, …)`），所以这里存不带斜杠的形式。
 *
 * 两处共用同一张表，改一条路径只有一处可改。
 */
export const API_PATH = {
  global: 'api/skill-scope/global',
  globalSave: 'api/skill-scope/global/save',
  workspace: 'api/skill-scope/workspace',
  workspaceSave: 'api/skill-scope/workspace/save',
} as const
