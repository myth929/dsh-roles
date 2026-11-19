import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('dsh-orchestration runtime smoke', () => {
  it('mounts onto a plain DSH composition with 5 roles, per-role routing, guide env injection, fork parity, guards, and budgets', () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const stdout = execFileSync(process.execPath, ['tests/fixtures/smoke-runner.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 45000,
    })
    const report = JSON.parse(stdout.trim().split('\n').at(-1)!)
    expect(report).toMatchObject({
      status: 'PASS',
      internalPresetsHidden: true,
      bareDelegationConverged: true,
      clientBundleComposed: true,
      settingsDescriptorMounted: true,
      oarProviderDiscovered: true,
      liveSettingsOarRouting: true,
      keyFilesReturned: true,
      planRoutedToModel: true,
      guideEnvironmentInjected: true,
      forkToolsMatchParent: true,
      forkSystemPromptMatchesParent: true,
      forkInheritedHistory: true,
      forkAllowedBash: true,
      forkBlockedNestedDelegation: true,
      forkColdResumeGuardDenied: true,
      budgetConvergedCleanly: true,
    })
  }, 50000)
})
