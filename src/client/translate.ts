/**
 * 词条函数：给一个 key（与可选参数）返回展示文案。
 *
 * **单独成模块是为了避免循环依赖**：`CapabilityPanel.tsx` 需要这个类型，
 * 而它同时被外壳（`GlobalPanel.tsx` / `WorkspaceModal.tsx`）import。
 * 若把定义放在外壳里，就会形成「外壳 → 内核 → 外壳」的环；
 * 放在内核里又会让「谁定义谁消费」的依赖方向反着读。
 * 一个只有类型的叶子模块同时解决这两点，且不引入任何运行期代码。
 */
export type Translate = (key: string, params?: Record<string, string>) => string
