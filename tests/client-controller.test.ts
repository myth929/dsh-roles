import { describe, expect, it, vi } from 'vitest'
import type { SettingsFormPathOp, SettingsFormScope, SettingsFormScopeSnapshot } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  OrchestrationSettingsController,
  decodeRoleSelection,
  encodeLlmSelection,
  encodeSubagentSelection,
  partitionExternalProviders,
  shortPluginName,
} from '../src/client/controller.js'
import type {
  HostOptionsView,
  ModelCatalogView,
  OrchestrationFormValues,
} from '../src/client/controller.js'

function createMockScope(initial?: Partial<SettingsFormScopeSnapshot<OrchestrationFormValues>>) {
  let snapshot: SettingsFormScopeSnapshot<OrchestrationFormValues> = {
    status: 'ready',
    value: {},
    base: {},
    user: {},
    writable: true,
    revision: 1,
    ...initial,
  }
  const listeners = new Set<() => void>()
  const recordedOps: Array<{ ops: readonly SettingsFormPathOp[]; expectedRevision: number | undefined }> = []

  const applyLocally = (ops: readonly SettingsFormPathOp[]): void => {
    const nextUser = { ...((snapshot.user as Record<string, unknown> | undefined) ?? {}) }
    for (const op of ops) {
      if (op.path.length !== 1) continue
      const key = op.path[0]
      if (op.op === 'set') nextUser[key] = op.value
      else delete nextUser[key]
    }
    const base = { ...((snapshot.base as Record<string, unknown> | undefined) ?? {}) }
    snapshot = {
      ...snapshot,
      user: nextUser,
      value: { ...base, ...nextUser } as OrchestrationFormValues,
      revision: (snapshot.revision ?? 0) + 1,
    }
  }

  let acceptNext = true
  const scope: SettingsFormScope<OrchestrationFormValues> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate: async (ops, expectedRevision) => {
      recordedOps.push({ ops, expectedRevision })
      if (!acceptNext) return false
      applyLocally(ops)
      for (const listener of [...listeners]) listener()
      return true
    },
  }

  return {
    scope,
    recordedOps,
    setAccept: (value: boolean) => { acceptNext = value },
    pushSnapshot: (next: Partial<SettingsFormScopeSnapshot<OrchestrationFormValues>>) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}

const CATALOG: ModelCatalogView = {
  default: { provider: 'deepseek', model: 'deepseek-chat' },
  groups: [
    {
      id: 'relay-codex',
      name: 'Relay Codex (session-only)',
      models: [{ id: 'gpt-5', name: 'Relay GPT-5' }],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      models: [
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          reasoning: {
            efforts: [
              { id: 'medium', name: 'Medium' },
              { id: 'high', name: 'High' },
            ],
          },
        },
      ],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    },
  ],
  failures: [],
}

const HOST_OPTIONS: HostOptionsView = {
  externalProviders: [
    { id: 'oar-antigravity', label: 'OAR · Antigravity', runtime: 'antigravity', isOar: true },
    { id: 'oar-codex', label: 'OAR · Codex · gpt-5.4', runtime: 'codex', model: 'gpt-5.4', plugin: '@deepseek-ai/dsh-experimental-subagent-oar', isOar: true },
    { id: 'oar-claude', label: 'OAR · Claude', runtime: 'claude', plugin: '@deepseek-ai/dsh-experimental-subagent-oar', isOar: true },
    { id: 'codex', label: 'Codex', runtime: 'codex', plugin: '@deepseek-ai/dsh-subagent-codex', isOar: false },
  ],
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('OrchestrationSettingsController', () => {
  it('encodes/decodes OAR subagent and LLM routes cleanly', () => {
    expect(encodeSubagentSelection('oar-codex')).toBe('subagent:oar-codex')
    expect(encodeLlmSelection('openai', 'gpt-5.4')).toBe('llm:openai\0gpt-5.4')
    expect(decodeRoleSelection('')).toEqual({ kind: 'inherit' })
    expect(decodeRoleSelection('subagent:oar-codex')).toEqual({ kind: 'subagent', subagentProvider: 'oar-codex' })
    expect(decodeRoleSelection('llm:openai\0gpt-5.4')).toEqual({ kind: 'llm', provider: 'openai', model: 'gpt-5.4' })
    expect(shortPluginName('@deepseek-ai/dsh-subagent-codex')).toBe('dsh-subagent-codex')
    expect(shortPluginName('@acme/custom-subagent')).toBe('@acme/custom-subagent')
    expect(shortPluginName('   ')).toBeUndefined()
    expect(shortPluginName(undefined)).toBeUndefined()
  })

  it('always lists Codex & Claude Code under native plugins with installed status and hides duplicate OAR codex/claude', () => {
    const partial = partitionExternalProviders([
      { id: 'oar-antigravity', label: 'OAR · Antigravity', runtime: 'antigravity', isOar: true },
      { id: 'oar-codex', label: 'OAR · Codex', runtime: 'codex', plugin: '@deepseek-ai/dsh-experimental-subagent-oar', isOar: true },
      { id: 'oar-claude', label: 'OAR · Claude', runtime: 'claude', plugin: '@deepseek-ai/dsh-experimental-subagent-oar', isOar: true },
      { id: 'codex', label: 'Codex', runtime: 'codex', plugin: '@deepseek-ai/dsh-subagent-codex', isOar: false },
    ])
    expect(partial.nativePlugins).toEqual([
      {
        id: 'codex',
        plugin: '@deepseek-ai/dsh-subagent-codex',
        installed: true,
        provider: { id: 'codex', label: 'Codex', runtime: 'codex', plugin: '@deepseek-ai/dsh-subagent-codex', isOar: false },
      },
      {
        id: 'claude-code',
        plugin: '@deepseek-ai/dsh-subagent-claude-code',
        installed: false,
      },
    ])
    expect(partial.oarProviders.map(p => p.id)).toEqual(['oar-antigravity'])

    const noneInstalled = partitionExternalProviders([])
    expect(noneInstalled.nativePlugins).toEqual([
      { id: 'codex', plugin: '@deepseek-ai/dsh-subagent-codex', installed: false },
      { id: 'claude-code', plugin: '@deepseek-ai/dsh-subagent-claude-code', installed: false },
    ])
    expect(noneInstalled.oarProviders).toEqual([])
  })

  it('filters relay-* groups, selects OAR + LLM models with effort, and mutates only volatile fields', async () => {
    const mock = createMockScope()
    const controller = new OrchestrationSettingsController(mock.scope, {
      loadCatalog: async () => CATALOG,
      loadHostOptions: async () => HOST_OPTIONS,
    })
    await flushMicrotasks()

    let state = controller.card.getSnapshot()
    expect(state.catalogStatus).toBe('ready')
    expect(state.llmGroups.map(g => g.id)).toEqual(['openai', 'deepseek'])
    expect(state.externalProviders.map(p => p.id)).toEqual(['oar-antigravity', 'oar-codex', 'oar-claude', 'codex'])
    expect(state.dirty).toBe(false)

    controller.selectRoleRoute('general-purpose', encodeSubagentSelection('oar-antigravity'))
    controller.selectRoleRoute('explore', encodeSubagentSelection('oar-codex'))
    controller.selectRoleRoute('plan', encodeLlmSelection('openai', 'gpt-5.4'))
    controller.selectRoleEffort('plan', 'high')

    state = controller.card.getSnapshot()
    expect(state.dirty).toBe(true)
    expect(state.invalid).toBe(false)
    expect(state.roles['general-purpose'].overridden).toBe(true)
    expect(state.roles.explore.overridden).toBe(true)
    expect(state.roles.plan.efforts.map(e => e.id)).toEqual(['medium', 'high'])
    expect(state.roles.plan.reasoningEffort).toBe('high')

    await controller.save()
    expect(mock.recordedOps).toHaveLength(1)
    expect(mock.recordedOps[0].expectedRevision).toBe(1)
    expect(mock.recordedOps[0].ops).toEqual([
      {
        op: 'set',
        path: ['models'],
        value: {
          'general-purpose': { subagentProvider: 'oar-antigravity' },
          explore: { subagentProvider: 'oar-codex' },
          plan: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'high' },
        },
      },
    ])
    expect(controller.card.getSnapshot().dirty).toBe(false)

    // Resetting all overridden roles unsets `models`.
    controller.resetRole('general-purpose')
    controller.resetRole('explore')
    controller.resetRole('plan')
    await controller.save()
    expect(mock.recordedOps[1].ops).toEqual([{ op: 'unset', path: ['models'] }])
    controller.dispose()
  })

  it('retains unavailable saved routes and flags external revision conflicts', async () => {
    const mock = createMockScope({
      value: {
        models: {
          explore: { subagentProvider: 'oar-missing' },
          plan: 'gone/model',
        },
      },
      user: {
        models: {
          explore: { subagentProvider: 'oar-missing' },
          plan: 'gone/model',
        },
      },
      revision: 5,
    })
    const controller = new OrchestrationSettingsController(mock.scope, {
      loadCatalog: async () => CATALOG,
      loadHostOptions: async () => HOST_OPTIONS,
    })
    await flushMicrotasks()

    let state = controller.card.getSnapshot()
    expect(state.roles.explore.available).toBe(false)
    expect(state.roles.explore.unavailableLabel).toBe('oar-missing')
    expect(state.roles.plan.available).toBe(false)
    expect(state.roles.plan.unavailableLabel).toBe('gone/model')

    // External revision update while draft is dirty marks conflict until discarded.
    controller.selectRoleRoute('explore', encodeSubagentSelection('oar-codex'))
    mock.pushSnapshot({ revision: 6 })
    state = controller.card.getSnapshot()
    expect(state.conflicted).toBe(true)
    expect(state.invalid).toBe(true)
    await controller.save()
    expect(mock.recordedOps).toHaveLength(0)

    controller.discard()
    state = controller.card.getSnapshot()
    expect(state.conflicted).toBe(false)
    expect(state.dirty).toBe(false)
    controller.dispose()
  })

  it('marks error when both catalog and host options fail and recovers on retry', async () => {
    const mock = createMockScope()
    const loadCatalog = vi.fn<() => Promise<ModelCatalogView>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(CATALOG)
    const loadHostOptions = vi.fn<() => Promise<HostOptionsView>>()
      .mockRejectedValueOnce(new Error('rpc fail'))
      .mockResolvedValueOnce(HOST_OPTIONS)

    const controller = new OrchestrationSettingsController(mock.scope, {
      loadCatalog,
      loadHostOptions,
    })
    await flushMicrotasks()
    expect(controller.card.getSnapshot().catalogStatus).toBe('error')

    controller.retryCatalog()
    await flushMicrotasks()
    expect(controller.card.getSnapshot().catalogStatus).toBe('ready')
    controller.dispose()
  })

  it('clears legacy exploreProvider and exploreModel when explore is reset or updated', async () => {
    const mock = createMockScope({
      value: { exploreProvider: 'deepseek', exploreModel: 'deepseek-chat' },
      user: { exploreProvider: 'deepseek', exploreModel: 'deepseek-chat' },
      revision: 2,
    })
    const controller = new OrchestrationSettingsController(mock.scope, {
      loadCatalog: async () => CATALOG,
      loadHostOptions: async () => HOST_OPTIONS,
    })
    await flushMicrotasks()

    expect(controller.card.getSnapshot().roles.explore.overridden).toBe(true)
    controller.resetRole('explore')
    await controller.save()
    expect(mock.recordedOps[0]?.ops).toEqual([
      { op: 'unset', path: ['models'] },
      { op: 'unset', path: ['exploreProvider'] },
      { op: 'unset', path: ['exploreModel'] },
    ])
    expect(controller.card.getSnapshot().roles.explore.overridden).toBe(false)
    controller.dispose()
  })
})
