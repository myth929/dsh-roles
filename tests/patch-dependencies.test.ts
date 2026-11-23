import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface Manifest {
  name: string
  peerDependencies?: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Manifest

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

/**
 * Every Loader row names the module it mounts with `name:`. Preset display names
 * live under `config.name` and are plain prose, so they never match this pattern
 * (they contain whitespace and are rejected as specifiers below).
 */
const ROW_NAME = /^[ \t]*-?[ \t]*name:[ \t]*(?:'([^']+)'|"([^"]+)"|([^\s#]+))[ \t]*$/gm

/** Bare package specifiers only; `cordis:*` rows are Loader builtins, not packages. */
const PACKAGE_SPECIFIER = /^@?[a-z0-9][\w./-]*$/

function modulesNamedInPatch(): string[] {
  const names = new Set<string>()
  for (const match of patch.matchAll(ROW_NAME)) {
    const name = match[1] ?? match[2] ?? match[3]
    if (name.startsWith('cordis:')) continue
    if (!PACKAGE_SPECIFIER.test(name)) continue
    names.add(name)
  }
  return [...names].sort()
}

describe('bundle dependency contract', () => {
  const named = modulesNamedInPatch()
  const hosted = named.filter(name => name !== manifest.name)
  const peers = Object.keys(manifest.peerDependencies ?? {})

  it('reads the rows the patch contributes to a profile', () => {
    expect(named).toContain(manifest.name)
    expect(named).toContain('@deepseek-ai/dsh-agent-preset')
    expect(hosted.length).toBeGreaterThan(1)
  })

  it('declares every module the patch mounts as a peer dependency', () => {
    // The bundle installs nothing itself: each mounted module is provided by the
    // host profile, so an undeclared one is a silent load failure for consumers.
    expect(hosted.filter(name => !peers.includes(name))).toEqual([])
  })

  it('keeps peer ranges on the DSH release line', () => {
    for (const name of hosted) {
      expect(manifest.peerDependencies?.[name], name).toMatch(/^>=\d+\.\d+\.\d+-rc\.\d+$|^\^\d+\.\d+\.\d+$/)
    }
  })
})
