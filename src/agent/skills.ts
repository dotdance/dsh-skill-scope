import type { SkillsServiceLike } from '../inventory/skills.ts'

/** The skill lookup needed to copy full definitions into an Agent scope. */
export interface ShadowSkillsFace extends SkillsServiceLike {
  get(name: string, options: { scope: unknown; cwd: string }): Promise<Record<string, unknown> | undefined>
}

/** Registers runtime skills in the scope selected by the raw host Agent. */
export interface ScopedSkillsFace {
  register(skill: Record<string, unknown>, agent?: unknown): () => void
}

export interface ApplySkillShadowInput {
  skills: ShadowSkillsFace
  scoped: ScopedSkillsFace
  cwd: string
  agent: unknown
  hidden: readonly string[]
  serial: <T>(operation: () => Promise<T>) => Promise<T>
  logger: { warn(message: string): void }
  previous?: () => void
  verifyStillVisible?: boolean
  /** Raw host Agent identity for all scope-sensitive service calls. */
  scopeOf?: unknown
}

export interface ApplySkillShadowResult {
  release: () => void
  applied: string[]
}

type ShadowDefinition = { name: string; definition: Record<string, unknown> }
type ShadowDisposer = { name: string; dispose: () => void }
interface ShadowHandle {
  definitions: ShadowDefinition[]
  disposers: ShadowDisposer[]
}
const shadowHandles = new WeakMap<() => void, ShadowHandle>()
const pendingDisposers = new WeakMap<object, ShadowDisposer[]>()

/** Installs model-hidden copies while preserving user invocation and full skill content. */
export async function applySkillShadow(input: ApplySkillShadowInput): Promise<ApplySkillShadowResult> {
  return await input.serial(async () => {
    const scope = input.scopeOf ?? input.agent
    const definitions: ShadowDefinition[] = []

    // Fetch the whole replacement before releasing the current shadow.
    for (const name of input.hidden) {
      const definition = await input.skills.get(name, { scope, cwd: input.cwd })
      if (definition === undefined) {
        input.logger.warn(`dsh-skill-scope: 无法遮蔽 skill「${name}」：注册表中找不到它的定义`)
        continue
      }
      definitions.push({ name, definition })
    }

    const scopePending = pendingOf(scope)
    if (scopePending !== undefined && scopePending.length > 0) {
      setPending(scope, releaseAll(scopePending, input.logger))
    }

    const previousHandle = input.previous === undefined ? undefined : shadowHandles.get(input.previous)
    if (previousHandle !== undefined) {
      previousHandle.disposers = releaseAll(previousHandle.disposers, input.logger)
    } else {
      input.previous?.()
    }

    const unresolvedNames = new Set([
      ...pendingOf(scope) ?? [],
      ...previousHandle?.disposers ?? [],
    ].map(({ name }) => name))
    const disposers: ShadowDisposer[] = []
    const applied: string[] = []
    try {
      for (const item of definitions) {
        if (unresolvedNames.has(item.name)) {
          input.logger.warn(`dsh-skill-scope: 暂不注册 skill「${item.name}」：同名注册尚未释放`)
          continue
        }
        disposers.push({ name: item.name, dispose: registerShadow(input.scoped, item, scope) })
        applied.push(item.name)
      }
    } catch (error) {
      const failedDisposers = releaseAll(disposers, input.logger)
      if (previousHandle !== undefined) {
        previousHandle.disposers.push(...failedDisposers)
        for (const { name } of failedDisposers) unresolvedNames.add(name)
        for (const item of previousHandle.definitions) {
          if (unresolvedNames.has(item.name)) {
            input.logger.warn(`dsh-skill-scope: 暂不恢复 skill「${item.name}」：同名部分注册尚未释放`)
            continue
          }
          try {
            previousHandle.disposers.push({
              name: item.name,
              dispose: registerShadow(input.scoped, item, scope),
            })
          } catch (restoreError) {
            input.logger.warn(`dsh-skill-scope: 恢复 skill「${item.name}」失败：${String(restoreError)}`)
          }
        }
      } else {
        setPending(scope, [...pendingOf(scope) ?? [], ...failedDisposers])
      }
      throw error
    }

    if (previousHandle !== undefined && previousHandle.disposers.length > 0) {
      setPending(scope, [...pendingOf(scope) ?? [], ...previousHandle.disposers])
      previousHandle.disposers = []
    }
    const handle: ShadowHandle = { definitions, disposers }
    const release = (): void => {
      const failed = releaseAll(handle.disposers, input.logger)
      handle.disposers = []
      if (failed.length > 0) setPending(scope, [...pendingOf(scope) ?? [], ...failed])
    }
    shadowHandles.set(release, handle)

    if (input.verifyStillVisible === true) {
      try {
        const snapshot = await input.skills.snapshot({ scope, cwd: input.cwd })
        const hidden = new Set(input.hidden)
        const exposed = snapshot.skills
          .filter((row) => hidden.has(row.name) && row.invocation?.['modelInvocable'] !== false)
          .map((row) => row.name)
        if (exposed.length > 0) {
          input.logger.warn(
            `dsh-skill-scope: 以下 skill 遮蔽未生效（疑似被同层先到先得顶掉，已保留其余 ${applied.length} 项）：${exposed.join(', ')}`,
          )
        }
      } catch (error) {
        input.logger.warn(`dsh-skill-scope: skill shadow 复验失败：${String(error)}`)
      }
    }

    return { release, applied }
  })
}

function pendingOf(scope: unknown): ShadowDisposer[] | undefined {
  return scope !== null && (typeof scope === 'object' || typeof scope === 'function')
    ? pendingDisposers.get(scope as object)
    : undefined
}

function setPending(scope: unknown, disposers: ShadowDisposer[]): void {
  if (scope === null || (typeof scope !== 'object' && typeof scope !== 'function')) return
  if (disposers.length === 0) pendingDisposers.delete(scope as object)
  else pendingDisposers.set(scope as object, disposers)
}

function registerShadow(scoped: ScopedSkillsFace, item: ShadowDefinition, scope: unknown): () => void {
  const invocation = readInvocation(item.definition)
  return scoped.register(
    {
      ...item.definition,
      invocation: {
        ...invocation,
        modelInvocable: false,
        userInvocable: invocation?.['userInvocable'] !== false,
      },
    },
    scope,
  )
}

function readInvocation(definition: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = definition['invocation']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

function releaseAll(disposers: readonly ShadowDisposer[], logger: { warn(message: string): void }): ShadowDisposer[] {
  const failed: ShadowDisposer[] = []
  for (const disposer of disposers) {
    try {
      disposer.dispose()
    } catch (error) {
      failed.push(disposer)
      logger.warn(`dsh-skill-scope: 释放 skill shadow 失败：${String(error)}`)
    }
  }
  return failed
}
