import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isWriteAllowed,
  normalizeWriteScopes,
  patchTargets,
  WorkerWriteCoordinator,
  writeScopeDenial,
} from '../src/scope.js'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-roles-scope-'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('writeScope validation', () => {
  it('normalizes workspace-relative prefixes and removes duplicates', () => {
    expect(normalizeWriteScopes(['./packages/app/', 'packages/app', 'docs'])).toEqual([
      { source: './packages/app/', prefix: 'packages/app' },
      { source: 'docs', prefix: 'docs' },
    ])
  })

  it.each(['/etc', '../outside', 'packages/../..', '.', '', 'packages/*'])('rejects unsafe scope %s', scope => {
    expect(() => normalizeWriteScopes([scope])).toThrow()
  })

  it('treats an omitted scope as unrestricted and an empty list as invalid', () => {
    expect(normalizeWriteScopes(undefined)).toBeUndefined()
    expect(() => normalizeWriteScopes([])).toThrow()
  })
})

describe('write guard', () => {
  it('allows writes inside a declared directory and rejects siblings', () => {
    mkdirSync(join(directory, 'packages/app'), { recursive: true })
    const scopes = normalizeWriteScopes(['packages/app'])
    expect(isWriteAllowed(directory, 'packages/app/src/a.ts', scopes!)).toBe(true)
    expect(isWriteAllowed(directory, join(directory, 'packages/app/src/a.ts'), scopes!)).toBe(true)
    expect(isWriteAllowed(directory, 'packages/other/a.ts', scopes!)).toBe(false)
    expect(writeScopeDenial('write', { file_path: 'packages/other/a.ts' }, directory, scopes!)).toMatch(/outside the allowed write scope/)
    expect(writeScopeDenial('read', { file_path: 'packages/other/a.ts' }, directory, scopes!)).toBeUndefined()
  })

  it('rejects a symlink that points outside the allowed directory', () => {
    mkdirSync(join(directory, 'packages/app'), { recursive: true })
    mkdirSync(join(directory, 'outside'), { recursive: true })
    symlinkSync(join(directory, 'outside'), join(directory, 'packages/app/link'), 'dir')
    const scopes = normalizeWriteScopes(['packages/app'])
    expect(isWriteAllowed(directory, 'packages/app/link/escape.ts', scopes!)).toBe(false)
    expect(writeScopeDenial('edit', { file_path: 'packages/app/link/escape.ts' }, directory, scopes!)).toMatch(/rejected/)
  })

  it('checks every apply_patch target', () => {
    mkdirSync(join(directory, 'packages/app'), { recursive: true })
    mkdirSync(join(directory, 'outside'), { recursive: true })
    writeFileSync(join(directory, 'packages/app/a.ts'), 'a')
    const scopes = normalizeWriteScopes(['packages/app'])
    const patch = [
      '*** Begin Patch',
      '*** Update File: packages/app/a.ts',
      '@@',
      '-a',
      '+b',
      '*** Add File: outside/new.ts',
      '+x',
      '*** End Patch',
    ].join('\n')
    expect(patchTargets(patch)).toEqual(['packages/app/a.ts', 'outside/new.ts'])
    expect(writeScopeDenial('apply_patch', { input: patch }, directory, scopes!)).toMatch(/outside\/new\.ts/)
  })
})

describe('concurrent worker write coordination', () => {
  it('admits disjoint scopes and rejects overlap or missing scopes', () => {
    const coordinator = new WorkerWriteCoordinator()
    const first = coordinator.reserve('parent', 'call-1', normalizeWriteScopes(['packages/a']))
    expect(first.ok).toBe(true)
    const overlap = coordinator.reserve('parent', 'call-2', normalizeWriteScopes(['packages']))
    expect(overlap).toMatchObject({ ok: false })
    const missing = coordinator.reserve('parent', 'call-3', undefined)
    expect(missing).toMatchObject({ ok: false })
    const disjoint = coordinator.reserve('parent', 'call-4', normalizeWriteScopes(['packages/b']))
    expect(disjoint.ok).toBe(true)
    if (first.ok) first.release()
    if (disjoint.ok) disjoint.release()
    expect(coordinator.reserve('parent', 'call-5', normalizeWriteScopes(['packages/a'])).ok).toBe(true)
  })

  it('keeps different parents independent', () => {
    const coordinator = new WorkerWriteCoordinator()
    expect(coordinator.reserve('parent-a', 'call-1', normalizeWriteScopes(['packages'])).ok).toBe(true)
    expect(coordinator.reserve('parent-b', 'call-2', normalizeWriteScopes(['packages'])).ok).toBe(true)
  })

  it('resolves relative writeScope against each worker cwd and symlink aliases', () => {
    mkdirSync(join(directory, 'packages/a/src'), { recursive: true })
    mkdirSync(join(directory, 'packages/b/src'), { recursive: true })
    symlinkSync(join(directory, 'packages/a'), join(directory, 'alias-a'), 'dir')
    const coordinator = new WorkerWriteCoordinator()

    const first = coordinator.reserve('parent', 'call-1', normalizeWriteScopes(['src']), {
      parentCwd: directory,
      childCwd: 'packages/a',
    })
    expect(first.ok).toBe(true)

    const disjointByCwd = coordinator.reserve('parent', 'call-2', normalizeWriteScopes(['src']), {
      parentCwd: directory,
      childCwd: 'packages/b',
    })
    expect(disjointByCwd.ok).toBe(true)

    const overlapAcrossCwd = coordinator.reserve('parent', 'call-3', normalizeWriteScopes(['packages/a/src']), {
      parentCwd: directory,
    })
    expect(overlapAcrossCwd).toMatchObject({ ok: false })

    const overlapViaSymlink = coordinator.reserve('parent', 'call-4', normalizeWriteScopes(['src']), {
      parentCwd: directory,
      childCwd: 'alias-a',
    })
    expect(overlapViaSymlink).toMatchObject({ ok: false })
  })
})
