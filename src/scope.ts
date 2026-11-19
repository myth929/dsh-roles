/**
 * `writeScope` validation and pre-execution write guards.
 *
 * The guard is deliberately text/path based: it rejects `write`, `edit`, and
 * `apply_patch` targets that resolve outside the declared workspace prefixes,
 * including paths that escape through symlinks. Shell commands are not
 * path-inspected; see the package README for that boundary.
 * @module dsh-orchestration/scope
 */

import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** One validated workspace-relative write prefix. */
export interface NormalizedScope {
  readonly source: string
  readonly prefix: string
}

/** Outcome of reserving one concurrent worker write. */
export type WorkerReservation =
  | { readonly ok: true; release(): void }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate and normalize model-supplied write scopes.
 * @param scopes - raw `writeScope` argument.
 * @returns normalized prefixes, or undefined when the argument was omitted.
 * @throws when a scope is absolute, escapes upward, or is the workspace root.
 */
export function normalizeWriteScopes(scopes: readonly string[] | undefined): NormalizedScope[] | undefined {
  if (scopes === undefined) return undefined
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('writeScope must be a non-empty array of workspace-relative directory prefixes')
  }
  const seen = new Set<string>()
  const normalized: NormalizedScope[] = []
  for (const raw of scopes) {
    if (typeof raw !== 'string') throw new Error('writeScope entries must be strings')
    const source = raw.trim()
    if (source === '') throw new Error('writeScope entries must not be empty')
    if (source.includes('\0')) throw new Error(`writeScope entry ${JSON.stringify(raw)} contains a NUL byte`)
    if (/[*?[\]{}]/.test(source)) {
      throw new Error(`writeScope entry ${JSON.stringify(raw)} must be a directory prefix, not a glob`)
    }
    const slashed = source.replaceAll('\\', '/')
    if (isAbsolute(source) || /^[a-zA-Z]:/.test(slashed) || slashed.startsWith('/')) {
      throw new Error(`writeScope entry ${JSON.stringify(raw)} must be workspace-relative, not absolute`)
    }
    const segments = slashed.split('/').filter(segment => segment !== '' && segment !== '.')
    if (segments.includes('..')) {
      throw new Error(`writeScope entry ${JSON.stringify(raw)} must not escape the workspace with ".."`)
    }
    if (segments.length === 0) {
      throw new Error(`writeScope entry ${JSON.stringify(raw)} must name a subdirectory, not the workspace root`)
    }
    const prefix = segments.join('/')
    if (seen.has(prefix)) continue
    seen.add(prefix)
    normalized.push(Object.freeze({ source, prefix }))
  }
  return normalized
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Resolve a path to its real location even when its leaf or parents do not
 * exist yet, so a symlink on any existing ancestor cannot hide an escape.
 * @param target - absolute path to canonicalize.
 * @returns the canonical absolute path.
 */
export function canonicalPath(target: string): string {
  let current = resolve(target)
  const suffix: string[] = []
  while (true) {
    try {
      const real = realpathSync.native(current)
      return suffix.length === 0 ? real : resolve(real, ...suffix.reverse())
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) return suffix.length === 0 ? current : resolve(current, ...suffix.reverse())
      suffix.push(current.slice(parent.length).replace(/^[/\\]/, ''))
      current = parent
    }
  }
}

/**
 * Resolve the effective working directory for a worker given the parent cwd
 * and optional per-call `cwd` argument.
 * @param parentCwd - effective parent directory.
 * @param childCwd - optional relative or absolute `cwd` argument.
 * @returns canonicalized working directory for the worker.
 */
export function resolveWorkerBaseCwd(parentCwd: string, childCwd?: string): string {
  const parentReal = canonicalPath(parentCwd)
  if (childCwd === undefined) return parentReal
  return canonicalPath(isAbsolute(childCwd) ? childCwd : resolve(parentReal, childCwd))
}

/**
 * Read the most recent effective working directory from a session, honoring
 * `working-directory/change` events after creation.
 * @param session - session object or lightweight test stub.
 * @param fallback - directory to use when the session records none.
 * @returns effective directory string.
 */
export function effectiveSessionCwd(
  session: { readonly header?: { readonly cwd?: string }; readonly snapshotEvents?: () => readonly unknown[] } | undefined,
  fallback: string,
): string {
  if (session === undefined) return fallback
  if (typeof session.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as { type?: unknown; data?: { cwd?: unknown } } | undefined
      if (event?.type === 'working-directory/change' && typeof event.data?.cwd === 'string' && event.data.cwd !== '') {
        return event.data.cwd
      }
    }
  }
  return session.header?.cwd ?? fallback
}

/**
 * Whether one target path stays inside one declared scope.
 * @param cwd - session working directory.
 * @param filePath - model-supplied path, relative to `cwd` or absolute.
 * @param scopes - checked scopes for this worker.
 * @returns true when the canonical target is inside a canonical scope root.
 */
export function isWriteAllowed(cwd: string, filePath: string, scopes: readonly NormalizedScope[]): boolean {
  const cwdReal = canonicalPath(cwd)
  const targetReal = canonicalPath(resolve(cwdReal, filePath))
  return scopes.some((scope) => {
    const scopeReal = canonicalPath(join(cwdReal, scope.prefix))
    return isInside(scopeReal, targetReal)
  })
}

/** Extract every target path from an apply_patch document. */
export function patchTargets(input: string): string[] {
  const paths: string[] = []
  const pattern = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm
  for (const match of input.matchAll(pattern)) {
    const path = match[1]
    if (path !== undefined) paths.push(path)
  }
  return paths
}

function stringField(args: unknown, name: string): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const value = (args as Record<string, unknown>)[name]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Tools whose write targets are inspected by the scope guard. */
export const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'apply_patch'])

/**
 * Produce a model-facing denial when a write call escapes the declared scopes.
 * @param name - executed tool name.
 * @param args - validated tool arguments.
 * @param cwd - effective session directory at execution time.
 * @param scopes - declared worker scopes.
 * @returns the denial reason, or undefined when the call is allowed.
 */
export function writeScopeDenial(
  name: string,
  args: unknown,
  cwd: string,
  scopes: readonly NormalizedScope[],
): string | undefined {
  if (!WRITE_TOOL_NAMES.has(name)) return undefined
  const paths = name === 'apply_patch'
    ? patchTargets(stringField(args, 'input') ?? '')
    : [stringField(args, 'file_path')].filter((value): value is string => value !== undefined)
  if (paths.length === 0) {
    return `\`${name}\` was rejected: its target path could not be verified against the allowed write scope.`
  }
  const outside = paths.filter(path => {
    try {
      return !isWriteAllowed(cwd, path, scopes)
    } catch {
      return true
    }
  })
  if (outside.length === 0) return undefined
  return `\`${name}\` was rejected: ${outside.map(path => JSON.stringify(path)).join(', ')} is outside the allowed write scope `
    + `(${scopes.map(scope => scope.prefix).join(', ')}). Write only inside the declared directories, or ask the delegating agent to widen the scope.`
}

interface CanonicalScope {
  readonly source: string
  readonly realPath: string
}

function canonicalScopesFor(
  scopes: readonly NormalizedScope[] | undefined,
  parentCwd: string,
  childCwd?: string,
): readonly CanonicalScope[] | undefined {
  if (scopes === undefined) return undefined
  const baseCwd = resolveWorkerBaseCwd(parentCwd, childCwd)
  return scopes.map(scope => Object.freeze({
    source: scope.prefix,
    realPath: canonicalPath(join(baseCwd, scope.prefix)),
  }))
}

function canonicalOverlaps(left: CanonicalScope, right: CanonicalScope): boolean {
  return isInside(left.realPath, right.realPath) || isInside(right.realPath, left.realPath)
}

/**
 * Track concurrently running workers per parent and reject overlapping writes.
 * Reservations are synchronous so parallel calls in one tool batch cannot race
 * past each other before awaiting the child start.
 */
export class WorkerWriteCoordinator {
  private readonly active = new Map<string, Map<string, readonly CanonicalScope[] | undefined>>()

  /**
   * Reserve one worker's write space resolved to canonical filesystem paths.
   * @param parentId - delegating agent id.
   * @param callId - tool call id, used only for release identity.
   * @param scopes - declared scopes, or undefined for an unrestricted worker.
   * @param cwd - parent and optional child working directory context.
   * @returns a release handle or a conflict reason.
   */
  reserve(
    parentId: string,
    callId: string,
    scopes: readonly NormalizedScope[] | undefined,
    cwd?: { readonly parentCwd: string; readonly childCwd?: string },
  ): WorkerReservation {
    const resolved = canonicalScopesFor(scopes, cwd?.parentCwd ?? process.cwd(), cwd?.childCwd)
    const current = this.active.get(parentId) ?? new Map<string, readonly CanonicalScope[] | undefined>()
    for (const [otherCall, otherScopes] of current) {
      if (otherScopes === undefined || resolved === undefined) {
        return {
          ok: false,
          reason: `worker ${otherCall} or this call writes without a writeScope; define distinct, non-overlapping writeScope prefixes before running workers concurrently`,
        }
      }
      for (const left of resolved) {
        for (const right of otherScopes) {
          if (canonicalOverlaps(left, right)) {
            return {
              ok: false,
              reason: `worker write scopes overlap (${left.source} -> ${left.realPath} vs ${right.source} -> ${right.realPath}); give every concurrent worker a disjoint writeScope or run them sequentially`,
            }
          }
        }
      }
    }
    current.set(callId, resolved)
    this.active.set(parentId, current)
    return {
      ok: true,
      release: () => {
        const entries = this.active.get(parentId)
        if (entries === undefined) return
        entries.delete(callId)
        if (entries.size === 0) this.active.delete(parentId)
      },
    }
  }
}

/** Whether a path exists; exported for the guard's tests. */
export function pathExists(path: string): boolean {
  return existsSync(path)
}
