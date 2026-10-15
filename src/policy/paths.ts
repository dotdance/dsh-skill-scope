import { join } from 'node:path'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * 工程目录下的策略文件名。
 *
 * 保留 `.dsh-scope.json`：本机多个老工程（最早 2026-09-11，早于本插件）已存在
 * 同名文件，沿用旧名可零迁移，也不会让新旧文件同时出现在同一工程里造成歧义。
 */
export const WORKSPACE_POLICY_FILE = '.dsh-scope.json'

/** `$DSH_HOME/skill-scope/global.json`。取不到 home 时退回 `resolveDshHome()` 的等价路径。 */
export function globalPolicyPath(): string {
  return dshHomePath('skill-scope', 'global.json')
}

/** 某个工程目录下的策略文件。 */
export function workspacePolicyPath(cwd: string): string {
  return join(cwd, WORKSPACE_POLICY_FILE)
}

/**
 * 文件锁路径：与策略文件同目录，这样锁和被锁对象同处一个文件系统。
 *
 * **返回的就是最终锁路径**，不要再往后加 `.lock`：`withFileLock(filename, …)`
 * 自己会拼 `${filename}.lock`（`dsh-atomic-write` 的 `withFileLock`）。
 * 早期实现把这里返回的值当「被锁对象」传进去，结果锁文件名成了
 * `global.json.lock.lock`（实测报错信息里能看到双后缀）。
 *
 * 传参口径：调用方应当传**策略文件路径**给 `withFileLock`，让库自己加后缀；
 * 这个函数只在需要显式指出锁位置（诊断/测试）时使用。
 */
export function policyLockPath(path: string): string {
  return `${path}.lock`
}

/** 供测试与诊断使用：当前解析出的 `$DSH_HOME`。 */
export function dshHomeDir(): string {
  return resolveDshHome()
}
