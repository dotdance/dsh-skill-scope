import { describe, expect, it } from 'vitest'
import { isOfficialSkill, isOfficialSkillPath } from '../../src/inventory/official.ts'

/**
 * 官方包在磁盘上的真实路径，取自 web profile 上的实测输出（2026-10-14），
 * **不是**手捏的字面量——含 pnpm 版本目录与哈希。
 */
const REAL_PNPM_PATH =
  '/home/user/Library/pnpm/global/v11/5bd1-18dcdf5fdc96fa80-0/node_modules/.pnpm/' +
  '@deepseek-ai+dsh-agent-preset@0.2.1-alpha.2_@deepseek-ai+cordis-plugin-loader@1.0.6-alp_6be3b213f89423fda16ba09f3790f3ac/' +
  'node_modules/@deepseek-ai/dsh-agent-preset/skills/agent-experience/SKILL.md'

describe('isOfficialSkillPath', () => {
  it('recognizes the real pnpm-store path of an official preset skill', () => {
    expect(isOfficialSkillPath(REAL_PNPM_PATH)).toBe(true)
  })

  it('recognizes the profile symlink copy (same rule, no pnpm segment)', () => {
    // 软链副本：`realpath` 会解析回 pnpm store，但规则本身也不该依赖那一段。
    expect(
      isOfficialSkillPath('/home/user/.dsh/profiles/probe1/node_modules/@deepseek-ai/dsh-agent-preset/skills/agent-experience/SKILL.md'),
    ).toBe(true)
  })

  it('recognizes the skill directory form, which carries no SKILL.md suffix', () => {
    expect(
      isOfficialSkillPath('/home/user/node_modules/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions'),
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
      '/home/user/proj/sand/skills/academic-verify/SKILL.md',
      '/home/user/node_modules/gbrain/skills/academic-verify/SKILL.md',
      '/home/user/.agents/skills/agent-reach/SKILL.md',
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
      expect(isOfficialSkillPath('/home/user/proj/sand/@deepseek-ai/my-own/SKILL.md')).toBe(true)
    })

    it('hides a user’s own skill whose project name merely contains the scope string', () => {
      expect(isOfficialSkillPath('/home/user/proj/@deepseek-ai-tools/skills/x/SKILL.md')).toBe(true)
    })
  })
})

describe('isOfficialSkill', () => {
  it('recognizes the real path-less `dsh-office` row (measured 2026-10-21)', () => {
    /*
     * 实测的原始行（`POST /api/skill-scope/global`）：
     * `{ name:'office-export-pdf', provider:'dsh-office', source:'bundled', path: undefined }`。
     * 路径规则对它返回 false（没有 path 可判），provider 白名单是唯一能盖住它的信号。
     * 注意判定**不看 source**：`filesystem` provider 的 `DSH_BUNDLED_SKILL_DIR`
     * 也会把用户目录标成 `bundled`，按 source 判会误伤。
     */
    expect(isOfficialSkill({ provider: 'dsh-office' })).toBe(true)
  })

  it('keeps host runtime skills visible, because the user must be able to switch them off', () => {
    // `browser-skill` / `memory-recall` 是宿主自注册的 runtime skill，**不是**本次要隐藏的对象。
    expect(isOfficialSkill({ provider: 'runtime' })).toBe(false)
    expect(isOfficialSkill({ provider: 'runtime', path: '/g/whatever/SKILL.md' })).toBe(false)
  })

  it('keeps a third-party plugin provider visible, even without a path', () => {
    // `superpowers-dsh` 也注册自己的 provider；它的来源标签正是「插件名」，必须仍可开关。
    expect(isOfficialSkill({ provider: 'superpowers-dsh' })).toBe(false)
  })

  it('treats an undetermined provider as non-official', () => {
    // `toRow` 把缺失 provider 收敛成 `'unknown'`；判不出时不能藏。
    expect(isOfficialSkill({})).toBe(false)
    expect(isOfficialSkill({ provider: 'unknown' })).toBe(false)
  })

  it('still hides a filesystem skill whose path lies in the official scope', () => {
    // 两条信号是或关系：provider 不是白名单成员，但路径规则命中 ⇒ 官方。
    expect(
      isOfficialSkill({ provider: 'filesystem', path: '/g/node_modules/@deepseek-ai/dsh-agent-preset/skills/x/SKILL.md' }),
    ).toBe(true)
  })

  it('leaves a user’s filesystem skill visible', () => {
    expect(isOfficialSkill({ provider: 'filesystem', path: '/home/user/proj/sand/skills/mine/SKILL.md' })).toBe(false)
  })
})
