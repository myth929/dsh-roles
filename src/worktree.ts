/**
 * Git worktree isolation lifecycle backed by DSH's official
 * `@deepseek-ai/dsh-experimental-worktree` service.
 *
 * `dsh-roles` strictly delegates worktree creation to `ctx.worktrees.create`
 * inside the local child's `agent/created` hook so the parent session's working
 * directory and event log are never mutated. On settlement, this module
 * inspects the child worktree, cleans up no-op branches automatically, or
 * auto-commits remaining edits onto the isolated branch for parent review and
 * merge via standard Git commands.
 * @module dsh-roles/worktree
 */

import { execFile } from 'node:child_process'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Supported isolation modes for `general-purpose` subagents. */
export const ISOLATION_MODES = ['none', 'worktree'] as const
export type IsolationMode = typeof ISOLATION_MODES[number]

/** Checkout metadata returned by `@deepseek-ai/dsh-experimental-worktree`. */
export interface CreatedWorktree {
  readonly path: string
  readonly branch: string
  readonly baseCommit: string
  readonly repositoryRoot: string
}

/** Minimal structural contract for DSH's optional `ctx.worktrees` service. */
export interface WorktreeServiceLike {
  create(
    agent: Agent,
    request?: { readonly name?: string; readonly from?: string },
    signal?: AbortSignal,
  ): Promise<CreatedWorktree>
}

/** Terminal or active status reported for a worktree-isolated subagent. */
export type WorktreeOutcomeStatus =
  | 'active'
  | 'no-changes'
  | 'ready-to-merge'
  | 'aborted-cleaned'
  | 'partial-retained'
  | 'finalization-failed'

/** Structured worktree summary attached to `orchestrate_subagent` tool output. */
export interface WorktreeOutcome {
  readonly status: WorktreeOutcomeStatus
  readonly branch: string
  readonly path: string
  readonly baseCommit: string
  readonly headCommit?: string
  readonly commitCount?: number
  readonly autoCommitted?: boolean
  readonly cleanedUp: boolean
  readonly changedFiles?: string[]
  readonly diffStat?: string
  readonly note?: string
}

/** Result of running preflight Git checks before launching a worktree child. */
export interface WorktreePreflightResult {
  readonly repositoryRoot: string
}

/** Options for {@link preflightWorktree}. */
export interface WorktreePreflightOptions {
  readonly worktreeService: WorktreeServiceLike | undefined
  readonly isLocal: boolean
  readonly provider: string
  readonly targetCwd: string
  readonly signal?: AbortSignal
}

/** Options for {@link finalizeWorktree}. */
export interface WorktreeFinalizeOptions {
  /** Whether the child finished usefully (`completed` or partial `budget-exhausted`). */
  readonly succeeded: boolean
  /** Short task description used in the auto-commit message. */
  readonly description: string
  /** Optional normalized child name used in the auto-commit message. */
  readonly childName?: string
  readonly signal?: AbortSignal
}

const GIT_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER_BYTES = 4 * 1024 * 1024
const MAX_REPORTED_FILES = 20
const MAX_DIRTY_PREVIEW_FILES = 5
const NULL_HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null'

const SCRUBBED_GIT_ENV_KEYS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE',
  'GIT_ATTR_SOURCE',
])

function scrubbedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SCRUBBED_GIT_ENV_KEYS.has(key)) continue
    env[key] = value
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_LFS_SKIP_SMUDGE = '1'
  env.GIT_NO_LAZY_FETCH = '1'
  return env
}

function runGit(
  cwd: string,
  args: readonly string[],
  options: { readonly allowedExitCodes?: readonly number[]; readonly signal?: AbortSignal } = {},
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> {
  const allowedExitCodes = options.allowedExitCodes ?? [0]
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', `core.hooksPath=${NULL_HOOKS_PATH}`, '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args],
      {
        cwd,
        env: scrubbedGitEnv(),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '')
        const err = String(stderr ?? '')
        if (error === null) {
          if (!allowedExitCodes.includes(0)) {
            reject(new Error(`git ${args[0] ?? ''} exited with unexpected status 0`))
            return
          }
          resolve({ stdout: out, stderr: err, exitCode: 0 })
          return
        }
        const code = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : null
        if (code !== null && allowedExitCodes.includes(code)) {
          resolve({ stdout: out, stderr: err, exitCode: code })
          return
        }
        const detail = err.trim() || error.message
        reject(new Error(`git ${args[0] ?? ''} failed: ${detail}`))
      },
    )
  })
}

/**
 * Build a collision-resistant relative branch name when a child `name` was supplied.
 * Returns `undefined` when no explicit name was provided so `WorktreeService` uses its
 * own configured `namePrefix` and generated naming scheme.
 */
export function buildWorktreeBranchName(childId: string, normalizedName?: string): string | undefined {
  if (normalizedName === undefined) return undefined
  const suffix = childId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 6) || 'wt'
  return `dsh-roles-${normalizedName}-${suffix}`
}

function parsePorcelainPaths(stdout: string): string[] {
  const files: string[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (rawLine.length < 4) continue
    const pathPart = rawLine.slice(3).trim()
    if (pathPart === '') continue
    const renameArrow = pathPart.indexOf(' -> ')
    files.push(renameArrow >= 0 ? pathPart.slice(renameArrow + 4) : pathPart)
  }
  return files
}

/**
 * Validate prerequisites before starting a worktree-isolated subagent.
 * Strictly requires DSH's official `@deepseek-ai/dsh-experimental-worktree`
 * service, a local DSH subagent provider, a Git checkout, and a clean tracked
 * main working tree so worktrees never silently diverge from uncommitted edits.
 */
export async function preflightWorktree(options: WorktreePreflightOptions): Promise<WorktreePreflightResult> {
  if (options.worktreeService === undefined) {
    throw new Error(
      'isolation "worktree" requires the official @deepseek-ai/dsh-experimental-worktree plugin to be installed and enabled in your DSH profile. Install @deepseek-ai/dsh-experimental-worktree, or use disjoint writeScope prefixes / sequential calls instead.',
    )
  }
  if (!options.isLocal) {
    throw new Error(
      `isolation "worktree" requires a local DSH subagent runtime (not external provider "${options.provider}"), because @deepseek-ai/dsh-experimental-worktree binds to a local DSH Agent. Route general-purpose to a local model, or use writeScope / sequential calls instead.`,
    )
  }

  let repositoryRoot: string
  try {
    const top = await runGit(options.targetCwd, ['rev-parse', '--show-toplevel'], { signal: options.signal })
    repositoryRoot = top.stdout.trim()
  } catch {
    throw new Error(
      'isolation "worktree" requires a Git repository; use disjoint writeScope prefixes or sequential calls instead.',
    )
  }
  if (repositoryRoot === '') {
    throw new Error(
      'isolation "worktree" requires a Git repository; use disjoint writeScope prefixes or sequential calls instead.',
    )
  }

  const status = await runGit(
    repositoryRoot,
    ['status', '--porcelain=v1', '--untracked-files=no'],
    { signal: options.signal },
  )
  const dirtyTracked = parsePorcelainPaths(status.stdout)
  if (dirtyTracked.length > 0) {
    const preview = dirtyTracked.slice(0, MAX_DIRTY_PREVIEW_FILES).join(', ')
    const extra = dirtyTracked.length > MAX_DIRTY_PREVIEW_FILES
      ? ` (+${dirtyTracked.length - MAX_DIRTY_PREVIEW_FILES} more)`
      : ''
    throw new Error(
      `isolation "worktree" cannot start while the main checkout has uncommitted tracked changes (${dirtyTracked.length} file(s): ${preview}${extra}). Worktrees branch from HEAD and exclude uncommitted edits. Commit or stash your changes first, or use disjoint writeScope prefixes / sequential calls instead.`,
    )
  }

  return { repositoryRoot }
}

async function removeWorktreeAndBranch(worktree: CreatedWorktree, signal?: AbortSignal): Promise<void> {
  await runGit(worktree.repositoryRoot, ['worktree', 'remove', '--', worktree.path], { signal })
  await runGit(worktree.repositoryRoot, ['branch', '-d', '--', worktree.branch], { signal })
}

async function resolveCommitAuthorArgs(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const args: string[] = []
  const name = await runGit(cwd, ['config', '--get', 'user.name'], { allowedExitCodes: [0, 1], signal })
  if (name.exitCode !== 0 || name.stdout.trim() === '') {
    args.push('-c', 'user.name=dsh-roles')
  }
  const email = await runGit(cwd, ['config', '--get', 'user.email'], { allowedExitCodes: [0, 1], signal })
  if (email.exitCode !== 0 || email.stdout.trim() === '') {
    args.push('-c', 'user.email=dsh-roles@local')
  }
  return args
}

function buildAutoCommitMessage(description: string, childName?: string): string {
  const cleanDescription = description.replace(/\s+/g, ' ').trim() || 'subagent changes'
  const scope = childName === undefined ? 'dsh-roles' : `dsh-roles(${childName})`
  return `${scope}: ${cleanDescription}`
}

/**
 * Finalize a child worktree after the subagent run settles:
 * - No-op runs (no commits and clean working tree) are automatically removed
 *   together with their temporary branch.
 * - Failed/aborted runs with partial edits are preserved on disk without
 *   auto-committing so the parent can inspect or discard them safely.
 * - Completed runs with uncommitted edits are auto-committed onto the child's
 *   branch so the parent can immediately review (`git diff`) and merge.
 */
export async function finalizeWorktree(
  worktree: CreatedWorktree,
  options: WorktreeFinalizeOptions,
): Promise<WorktreeOutcome> {
  try {
    const status = await runGit(
      worktree.path,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { signal: options.signal },
    )
    const dirtyFiles = parsePorcelainPaths(status.stdout)
    const hasDirty = dirtyFiles.length > 0
    let headCommit = (await runGit(worktree.path, ['rev-parse', 'HEAD'], { signal: options.signal })).stdout.trim()
    let hasNewCommits = headCommit !== worktree.baseCommit

    if (!hasDirty && !hasNewCommits) {
      await removeWorktreeAndBranch(worktree, options.signal)
      return {
        status: options.succeeded ? 'no-changes' : 'aborted-cleaned',
        branch: worktree.branch,
        path: worktree.path,
        baseCommit: worktree.baseCommit,
        headCommit,
        commitCount: 0,
        autoCommitted: false,
        cleanedUp: true,
      }
    }

    if (!options.succeeded) {
      const committedFiles = hasNewCommits
        ? (await runGit(worktree.path, ['diff', '--name-only', `${worktree.baseCommit}..${headCommit}`], { signal: options.signal }))
          .stdout.split(/\r?\n/).filter(Boolean)
        : []
      const changedFiles = [...new Set([...committedFiles, ...dirtyFiles])]
      return {
        status: 'partial-retained',
        branch: worktree.branch,
        path: worktree.path,
        baseCommit: worktree.baseCommit,
        headCommit,
        autoCommitted: false,
        cleanedUp: false,
        ...(changedFiles.length === 0 ? {} : { changedFiles }),
        note: 'Subagent did not complete cleanly; partial worktree changes were preserved for manual inspection or cleanup.',
      }
    }

    let autoCommitted = false
    if (hasDirty) {
      await runGit(worktree.path, ['add', '-A'], { signal: options.signal })
      const cached = await runGit(
        worktree.path,
        ['diff', '--cached', '--quiet'],
        { allowedExitCodes: [0, 1], signal: options.signal },
      )
      if (cached.exitCode === 1) {
        const authorArgs = await resolveCommitAuthorArgs(worktree.path, options.signal)
        const message = buildAutoCommitMessage(options.description, options.childName)
        await runGit(
          worktree.path,
          [...authorArgs, 'commit', '--no-verify', '-m', message],
          { signal: options.signal },
        )
        headCommit = (await runGit(worktree.path, ['rev-parse', 'HEAD'], { signal: options.signal })).stdout.trim()
        hasNewCommits = headCommit !== worktree.baseCommit
        autoCommitted = true
      }
    }

    if (!hasNewCommits) {
      await removeWorktreeAndBranch(worktree, options.signal)
      return {
        status: 'no-changes',
        branch: worktree.branch,
        path: worktree.path,
        baseCommit: worktree.baseCommit,
        headCommit,
        commitCount: 0,
        autoCommitted: false,
        cleanedUp: true,
      }
    }

    const commitCountRaw = (await runGit(
      worktree.path,
      ['rev-list', '--count', `${worktree.baseCommit}..${headCommit}`],
      { signal: options.signal },
    )).stdout.trim()
    const commitCount = Number.parseInt(commitCountRaw, 10)
    const changedFiles = (await runGit(
      worktree.path,
      ['diff', '--name-only', `${worktree.baseCommit}..${headCommit}`],
      { signal: options.signal },
    )).stdout.split(/\r?\n/).filter(Boolean)
    const diffStat = (await runGit(
      worktree.path,
      ['diff', '--stat', `${worktree.baseCommit}..${headCommit}`],
      { signal: options.signal },
    )).stdout.trim()

    return {
      status: 'ready-to-merge',
      branch: worktree.branch,
      path: worktree.path,
      baseCommit: worktree.baseCommit,
      headCommit,
      commitCount: Number.isFinite(commitCount) ? commitCount : 1,
      autoCommitted,
      cleanedUp: false,
      changedFiles,
      ...(diffStat === '' ? {} : { diffStat }),
    }
  } catch (error) {
    return {
      status: 'finalization-failed',
      branch: worktree.branch,
      path: worktree.path,
      baseCommit: worktree.baseCommit,
      cleanedUp: false,
      note: error instanceof Error ? error.message : String(error),
    }
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** Format a compact, actionable worktree summary block appended to tool text output. */
export function formatWorktreeSummary(outcome: WorktreeOutcome): string {
  const shortBase = shortSha(outcome.baseCommit)
  switch (outcome.status) {
    case 'active':
      return `Worktree: active (\`${outcome.branch}\` at \`${outcome.path}\`, base \`${shortBase}\`).`
    case 'no-changes':
      return `Worktree: no changes made; automatically removed worktree \`${outcome.path}\` and deleted branch \`${outcome.branch}\`.`
    case 'aborted-cleaned':
      return `Worktree: no changes made before termination; automatically removed worktree \`${outcome.path}\` and deleted branch \`${outcome.branch}\`.`
    case 'ready-to-merge': {
      const shortHead = outcome.headCommit === undefined ? outcome.branch : shortSha(outcome.headCommit)
      const count = outcome.commitCount ?? 1
      const commitNote = outcome.autoCommitted ? ', auto-committed' : ''
      const files = outcome.changedFiles ?? []
      const previewFiles = files.slice(0, MAX_REPORTED_FILES).join(', ')
      const more = files.length > MAX_REPORTED_FILES ? ` (+${files.length - MAX_REPORTED_FILES} more)` : ''
      const lines = [
        'Worktree: ready-to-merge',
        `- Branch: \`${outcome.branch}\` (base \`${shortBase}\` -> head \`${shortHead}\`, ${count} commit(s)${commitNote})`,
        `- Path: \`${outcome.path}\``,
        ...(files.length === 0 ? [] : [`- Changed files (${files.length}): ${previewFiles}${more}`]),
        ...(outcome.diffStat === undefined ? [] : ['- Diff stat:', outcome.diffStat]),
        `- Next steps: review with \`git diff ${shortBase}..${outcome.branch}\`, merge with \`git merge --squash ${outcome.branch}\` (or \`git cherry-pick ${shortBase}..${outcome.branch}\`), then clean up with \`git worktree remove -- ${JSON.stringify(outcome.path)} && git branch -D ${outcome.branch}\`.`,
      ]
      return lines.join('\n')
    }
    case 'partial-retained': {
      const files = outcome.changedFiles ?? []
      const previewFiles = files.slice(0, MAX_REPORTED_FILES).join(', ')
      const more = files.length > MAX_REPORTED_FILES ? ` (+${files.length - MAX_REPORTED_FILES} more)` : ''
      return [
        'Worktree: partial-retained (subagent did not complete cleanly; partial changes were preserved)',
        `- Branch: \`${outcome.branch}\` (base \`${shortBase}\`)`,
        `- Path: \`${outcome.path}\``,
        ...(files.length === 0 ? [] : [`- Touched files (${files.length}): ${previewFiles}${more}`]),
        `- Inspect or discard manually with \`git worktree remove --force -- ${JSON.stringify(outcome.path)} && git branch -D ${outcome.branch}\`.`,
      ].join('\n')
    }
    case 'finalization-failed':
      return [
        `Worktree: finalization-failed (${outcome.note ?? 'unknown error'})`,
        `- Branch: \`${outcome.branch}\``,
        `- Path: \`${outcome.path}\``,
      ].join('\n')
  }
}
