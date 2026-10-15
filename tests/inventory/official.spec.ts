import { describe, expect, it } from 'vitest'
import { isOfficialSkillPath } from '../../src/inventory/official.ts'

/**
 * 官方包在磁盘上的真实路径，取自 web profile 上的实测输出（2026-10-14），
 * **不是**手捏的字面量——含 pnpm 版本目录与哈希。
 */
const REAL_PNPM_PATH =
  '/Users/go/Library/pnpm/global/v11/5bd1-18dcdf5fdc96fa80-0/node_modules/.pnpm/' +
  '@deepseek-ai+dsh-agent-preset@0.2.1-alpha.2_@deepseek-ai+cordis-plugin-loader@1.0.6-alp_6be3b213f89423fda16ba09f3790f3ac/' +
  'node_modules/@deepseek-ai/dsh-agent-preset/skills/agent-experience/SKILL.md'

describe('isOfficialSkillPath', () => {
  it('recognizes the real pnpm-store path of an official preset skill', () => {
    expect(isOfficialSkillPath(REAL_PNPM_PATH)).toBe(true)
  })

  it('recognizes the profile symlink copy (same rule, no pnpm segment)', () => {
    // 软链副本：`realpath` 会解析回 pnpm store，但规则本身也不该依赖那一段。
    expect(
      isOfficialSkillPath('/Users/go/.dsh/profiles/probe1/node_modules/@deepseek-ai/dsh-agent-preset/skills/agent-experience/SKILL.md'),
    ).toBe(true)
  })

  it('recognizes the skill directory form, which carries no SKILL.md suffix', () => {
    expect(
      isOfficialSkillPath('/Users/go/node_modules/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions'),
    ).toBe(true)
  })

  it('recognizes any package under the scope, not only the agent-preset one', () => {
    /*
     * 口径（用户 2026-10-14 选择「完全放宽」）：整个 `@deepseek-ai` 作用域都算官方。
     * 官方将来新增的包无需再改规则——这三条钉住这一点。
     */
    for (const path of [
      '/g/node_modules/@deepseek-ai/dsh-web-app/skills/y/SKILL.md',
      '/g/node_modules/@deepseek-ai/dsh-skill-scope/skills/foo/SKILL.md',
      '/g/node_modules/@deepseek-ai/some-future-pkg/skills/z/SKILL.md',
    ]) {
      expect(isOfficialSkillPath(path)).toBe(true)
    }
  })

  it('recognizes the pnpm store form, where the scope uses `+` instead of `/`', () => {
    // `.pnpm/@deepseek-ai+dsh-agent-preset@<版本>_<hash>/` —— 子串匹配天然覆盖。
    expect(isOfficialSkillPath('/g/node_modules/.pnpm/@deepseek-ai+dsh-web-app@1.0_abc/node_modules/x/SKILL.md')).toBe(
      true,
    )
  })

  it('rejects the user’s own skill roots, which share the same provider and source', () => {
    /*
     * **这是本规则存在的理由**：实测这四个 skill 的 (provider, source) 与用户自己的
     * custom skill 完全相同（都是 filesystem/custom），只有 path 能区分。
     * 这三条是用户磁盘上的真实根目录，必须全部放行。
     */
    for (const path of [
      '/Users/go/proj/sand/skills/academic-verify/SKILL.md',
      '/Users/go/node_modules/gbrain/skills/academic-verify/SKILL.md',
      '/Users/go/.agents/skills/agent-reach/SKILL.md',
    ]) {
      expect(isOfficialSkillPath(path)).toBe(false)
    }
  })

  it('returns false when path is absent, since absence is not evidence of being official', () => {
    // runtime 注入的 skill 没有 path；不能因为「判不出」就把它藏起来。
    expect(isOfficialSkillPath(undefined)).toBe(false)
  })

  describe('已知代价：子串匹配不区分目录层级', () => {
    /*
     * 这组用例**不是**在断言「正确行为」，而是把用户 2026-10-14 明确接受的
     * 取舍固化成文档：放宽口径会误伤路径里恰好含 `@deepseek-ai` 的**自建** skill，
     * 且面板上没有任何提示。
     *
     * 若日后决定收窄（例如限定 `node_modules` 内），**这组用例会失败**，
     * 那时应连同 `src/inventory/official.ts` 的注释一起改——这正是它存在的目的。
     */
    it('hides a user’s own skill placed under a @deepseek-ai directory', () => {
      expect(isOfficialSkillPath('/Users/go/proj/sand/@deepseek-ai/my-own/SKILL.md')).toBe(true)
    })

    it('hides a user’s own skill whose project name merely contains the scope string', () => {
      expect(isOfficialSkillPath('/Users/go/proj/@deepseek-ai-tools/skills/x/SKILL.md')).toBe(true)
    })
  })
})
