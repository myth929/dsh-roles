import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildWorktreeBranchName,
  finalizeWorktree,
  formatWorktreeSummary,
  preflightWorktree,
} from '../src/worktree.js'
import type { CreatedWorktree, WorktreeServiceLike } from '../src/worktree.js'

const tempDirs: string[] = []

function makeTempDir(prefix: string, baseDir: string = tmpdir()): string {
  const dir = realpathSync(mkdtempSync(join(baseDir, prefix)))
  tempDirs.push(dir)
  return dir
}

function makeNonGitTempDir(prefix: string): string {
  const candidates = process.platform === 'win32' ? [tmpdir()] : ['/tmp', tmpdir()]
  for (const base of candidates) {
    if (!existsSync(base)) continue
    const dir = makeTempDir(prefix, base)
    try {
      execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, stdio: 'ignore' })
    } catch {
      return dir
    }
  }
  return makeTempDir(prefix)
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test-user',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test-user',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim()
}

function initGitRepo(): { repoRoot: string; baseCommit: string } {
  const repoRoot = makeTempDir('dsh-roles-wt-repo-')
  git(repoRoot, ['init', '-b', 'main'])
  writeFileSync(join(repoRoot, 'README.md'), '# fixture\n')
  writeFileSync(join(repoRoot, 'app.ts'), 'export const value = 1\n')
  git(repoRoot, ['add', '.'])
  git(repoRoot, ['commit', '-m', 'initial commit'])
  const baseCommit = git(repoRoot, ['rev-parse', 'HEAD'])
  return { repoRoot, baseCommit }
}

function addWorktree(repoRoot: string, baseCommit: string, branch: string): CreatedWorktree {
  const path = join(repoRoot, '.agents', 'worktrees', branch)
  git(repoRoot, ['worktree', 'add', '-b', branch, '--', path, baseCommit])
  return { path, branch, baseCommit, repositoryRoot: repoRoot }
}

const stubWorktreeService: WorktreeServiceLike = {
  create: vi.fn(),
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('worktree naming and preflight', () => {
  it('generates collision-resistant relative branch names only when an explicit name is supplied', () => {
    expect(buildWorktreeBranchName('12345678-abcd-ef00', undefined)).toBeUndefined()
    expect(buildWorktreeBranchName('12345678-abcd-ef00', 'auth-worker')).toBe('dsh-roles-auth-worker-123456')
  })

  it('rejects when official @deepseek-ai/dsh-experimental-worktree is not installed', async () => {
    const { repoRoot } = initGitRepo()
    await expect(preflightWorktree({
      worktreeService: undefined,
      isLocal: true,
      provider: 'spawn',
      targetCwd: repoRoot,
    })).rejects.toThrow(/@deepseek-ai\/dsh-experimental-worktree/)
  })

  it('rejects external OAR providers when worktree isolation is requested', async () => {
    const { repoRoot } = initGitRepo()
    await expect(preflightWorktree({
      worktreeService: stubWorktreeService,
      isLocal: false,
      provider: 'oar-codex',
      targetCwd: repoRoot,
    })).rejects.toThrow(/local DSH subagent runtime.*oar-codex/)
  })

  it('rejects non-Git directories and dirty tracked checkouts, while allowing untracked files', async () => {
    const plainDir = makeNonGitTempDir('dsh-roles-wt-nongit-')
    await expect(preflightWorktree({
      worktreeService: stubWorktreeService,
      isLocal: true,
      provider: 'spawn',
      targetCwd: plainDir,
    })).rejects.toThrow(/requires a Git repository/)

    const { repoRoot } = initGitRepo()
    // Untracked notes do not block worktree creation.
    writeFileSync(join(repoRoot, 'scratch.txt'), 'temp\n')
    const ok = await preflightWorktree({
      worktreeService: stubWorktreeService,
      isLocal: true,
      provider: 'spawn',
      targetCwd: repoRoot,
    })
    expect(ok.repositoryRoot).toBe(repoRoot)

    // Uncommitted tracked modifications fail fast with file details.
    writeFileSync(join(repoRoot, 'app.ts'), 'export const value = 2\n')
    await expect(preflightWorktree({
      worktreeService: stubWorktreeService,
      isLocal: true,
      provider: 'spawn',
      targetCwd: repoRoot,
    })).rejects.toThrow(/uncommitted tracked changes.*app\.ts/)
  })
})

describe('worktree finalization', () => {
  it('automatically removes the worktree and deletes the branch on no-op completion', async () => {
    const { repoRoot, baseCommit } = initGitRepo()
    const wt = addWorktree(repoRoot, baseCommit, 'dsh-roles-noop-1')

    const outcome = await finalizeWorktree(wt, {
      succeeded: true,
      description: 'check module',
      childName: 'checker',
    })

    expect(outcome).toMatchObject({
      status: 'no-changes',
      branch: 'dsh-roles-noop-1',
      cleanedUp: true,
      commitCount: 0,
      autoCommitted: false,
    })
    expect(existsSync(wt.path)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', 'dsh-roles-noop-1'])).toBe('')
    expect(formatWorktreeSummary(outcome)).toContain('no changes made; automatically removed')
  })

  it('auto-commits dirty tracked and untracked changes onto the isolated branch for parent merge', async () => {
    const { repoRoot, baseCommit } = initGitRepo()
    const wt = addWorktree(repoRoot, baseCommit, 'dsh-roles-feat-a')
    writeFileSync(join(wt.path, 'app.ts'), 'export const value = 42\n')
    writeFileSync(join(wt.path, 'feature.ts'), 'export const feature = true\n')

    const outcome = await finalizeWorktree(wt, {
      succeeded: true,
      description: 'implement feature a',
      childName: 'worker-a',
    })

    expect(outcome.status).toBe('ready-to-merge')
    expect(outcome.autoCommitted).toBe(true)
    expect(outcome.cleanedUp).toBe(false)
    expect(outcome.commitCount).toBe(1)
    expect(outcome.headCommit).toBeTruthy()
    expect(outcome.headCommit).not.toBe(baseCommit)
    expect(outcome.changedFiles?.sort()).toEqual(['app.ts', 'feature.ts'])
    expect(outcome.diffStat).toContain('2 files changed')
    expect(git(wt.path, ['status', '--porcelain=v1'])).toBe('')
    expect(git(wt.path, ['log', '-1', '--pretty=%s'])).toBe('dsh-roles(worker-a): implement feature a')

    const summary = formatWorktreeSummary(outcome)
    expect(summary).toContain('Worktree: ready-to-merge')
    expect(summary).toContain('auto-committed')
    expect(summary).toContain(`git merge --squash ${wt.branch}`)

    // Confirm the main checkout can cleanly squash-merge the child branch.
    git(repoRoot, ['merge', '--squash', wt.branch])
    expect(git(repoRoot, ['diff', '--cached', '--name-only']).split('\n').sort()).toEqual(['app.ts', 'feature.ts'])
  })

  it('preserves child-authored commits when the worktree is already clean', async () => {
    const { repoRoot, baseCommit } = initGitRepo()
    const wt = addWorktree(repoRoot, baseCommit, 'dsh-roles-committed-1')
    writeFileSync(join(wt.path, 'app.ts'), 'export const value = 99\n')
    git(wt.path, ['add', 'app.ts'])
    git(wt.path, ['commit', '-m', 'feat: update value to 99'])

    const outcome = await finalizeWorktree(wt, {
      succeeded: true,
      description: 'update value',
    })

    expect(outcome).toMatchObject({
      status: 'ready-to-merge',
      autoCommitted: false,
      cleanedUp: false,
      commitCount: 1,
      changedFiles: ['app.ts'],
    })
    expect(git(wt.path, ['log', '-1', '--pretty=%s'])).toBe('feat: update value to 99')
  })

  it('cleans up aborted no-op runs and preserves aborted runs that have partial changes', async () => {
    const { repoRoot, baseCommit } = initGitRepo()

    const emptyAborted = addWorktree(repoRoot, baseCommit, 'dsh-roles-abort-empty')
    const emptyOutcome = await finalizeWorktree(emptyAborted, {
      succeeded: false,
      description: 'aborted empty',
    })
    expect(emptyOutcome.status).toBe('aborted-cleaned')
    expect(emptyOutcome.cleanedUp).toBe(true)
    expect(existsSync(emptyAborted.path)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', 'dsh-roles-abort-empty'])).toBe('')

    const dirtyAborted = addWorktree(repoRoot, baseCommit, 'dsh-roles-abort-dirty')
    writeFileSync(join(dirtyAborted.path, 'app.ts'), 'export const value = -1\n')
    const dirtyOutcome = await finalizeWorktree(dirtyAborted, {
      succeeded: false,
      description: 'aborted dirty',
    })
    expect(dirtyOutcome.status).toBe('partial-retained')
    expect(dirtyOutcome.cleanedUp).toBe(false)
    expect(dirtyOutcome.changedFiles).toEqual(['app.ts'])
    expect(existsSync(dirtyAborted.path)).toBe(true)
    expect(git(dirtyAborted.path, ['rev-parse', 'HEAD'])).toBe(baseCommit)
    expect(formatWorktreeSummary(dirtyOutcome)).toContain('partial-retained')
  })
})
