import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import { ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveOrchestrationConfig } from '../src/config.js'
import { WorkerWriteCoordinator } from '../src/scope.js'
import { createOrchestrationTool, formatActivationLabel, normalizeChildName, orchestrationToolVisible } from '../src/tool.js'
import type { PendingChild, ToolEnvironment } from '../src/tool.js'
import type { CreatedWorktree, WorktreeOutcome } from '../src/worktree.js'

function agent(id: string, header: Record<string, unknown> = {}, append?: (type: string, data: unknown) => void): Agent {
  return {
    id,
    options: {},
    session: {
      id,
      header: { version: 4, id, createdAt: 0, isSeeded: false, ...header },
      ...(append === undefined ? {} : { append }),
    },
  } as unknown as Agent
}

function exec(callId: string, parent: Agent, args: unknown): ToolRunContext {
  return {
    callId,
    rootCallId: callId,
    name: 'orchestrate_subagent',
    arguments: args,
    agent: parent,
    signal: new AbortController().signal,
    token: Symbol('execution'),
    deferContext: vi.fn(),
    concludeTurn: vi.fn(),
  } as unknown as ToolRunContext
}

function environment(overrides: Partial<ToolEnvironment> = {}, configOverrides: Parameters<typeof resolveOrchestrationConfig>[0] = {}) {
  const config = resolveOrchestrationConfig(configOverrides, {})
  const registered: Array<{ childId: string; role: string }> = []
  const released: string[] = []
  const retained: Array<{ childId: string; release: () => void }> = []
  const settledExternal: Array<{ childId: string; stopReason: string }> = []
  const env: ToolEnvironment = {
    config,
    coordinator: new WorkerWriteCoordinator(),
    registerChild: (childId, pending) => { registered.push({ childId, role: pending.state.role }) },
    releaseChild: (childId) => { released.push(childId) },
    retainWriteReservation: (childId, release) => { retained.push({ childId, release }) },
    settleExternalChild: (state, stopReason) => {
      state.settled = true
      settledExternal.push({ childId: state.childId, stopReason })
    },
    isVisible: () => true,
    ...overrides,
  }
  return { env, registered, released, retained, settledExternal }
}

function activation(
  result: Awaited<SubagentActivation['result']>,
  childId = 'child' as SubagentActivation['childId'],
): SubagentActivation & { dispose: ReturnType<typeof vi.fn> } {
  return {
    childId,
    name: 'agent-1',
    result: Promise.resolve(result),
    dispose: vi.fn(async () => {}),
  } as unknown as SubagentActivation & { dispose: ReturnType<typeof vi.fn> }
}

describe('orchestration tool visibility', () => {
  it('exposes the tool to a native root and hides it at the depth limit or in Relay', () => {
    expect(orchestrationToolVisible(agent('root'))).toBe(true)
    expect(orchestrationToolVisible(agent('child', { delegationDepth: 1, origin: 'subagent' }))).toBe(false)
    expect(orchestrationToolVisible(agent('relay', { agentPreset: 'relay-codex' }))).toBe(false)
  })

  it('keeps the fork tool list identical to the parent while hiding managed fresh presets', () => {
    const forkChild = agent('fork-child', { delegationDepth: 1, origin: 'subagent', agentPreset: 'standard', isSeeded: true })
    expect(orchestrationToolVisible(forkChild, 'fork')).toBe(true)
    for (const preset of [
      'dsh-roles-explore',
      'dsh-roles-plan',
      'dsh-roles-general-purpose',
      'dsh-roles-guide',
    ]) {
      const child = agent('child', { delegationDepth: 1, origin: 'subagent', agentPreset: preset })
      expect(orchestrationToolVisible(child, 'explore')).toBe(false)
    }
    expect(orchestrationToolVisible(agent('relay-fork', { agentPreset: 'relay-claude' }), 'fork')).toBe(false)
  })

  it('hides the tool after a blank standard session switches to a Relay preset', () => {
    const switched = {
      ...agent('switched', { agentPreset: 'standard' }),
      ctx: { get: (name: string) => name === 'agentPresets' ? { presetForSession: () => 'relay-antigravity' } : undefined },
    } as unknown as Agent
    expect(orchestrationToolVisible(switched)).toBe(false)
  })

  it('exposes the tool when a blank Relay session switches back to standard across live, projected, or event signals', () => {
    const byComposed = {
      ...agent('relay-to-standard-composed', { agentPreset: 'relay-antigravity' }),
      ctx: { get: (name: string) => name === 'agentPresets' ? { composedPreset: () => 'standard', presetForSession: () => 'relay-antigravity' } : undefined },
    } as unknown as Agent
    expect(orchestrationToolVisible(byComposed)).toBe(true)

    const byProjection = {
      ...agent('relay-to-standard-projected', { agentPreset: 'relay-antigravity' }),
      ctx: { get: (name: string) => name === 'agentPresets' ? { presetForSession: () => 'standard' } : undefined },
    } as unknown as Agent
    expect(orchestrationToolVisible(byProjection)).toBe(true)

    const byEvents = {
      id: 'relay-to-standard-events',
      options: {},
      session: {
        id: 'relay-to-standard-events',
        header: { version: 4, id: 'relay-to-standard-events', createdAt: 0, isSeeded: false, agentPreset: 'relay-antigravity' },
        snapshotEvents: () => [{ type: 'agent-preset/selected', data: { agentPreset: 'standard' } }],
      },
    } as unknown as Agent
    expect(orchestrationToolVisible(byEvents)).toBe(true)

    const composedRelayOverridesStaleProjection = {
      ...agent('standard-to-relay', { agentPreset: 'standard' }),
      ctx: { get: (name: string) => name === 'agentPresets' ? { composedPreset: () => 'relay-codex', presetForSession: () => 'standard' } : undefined },
    } as unknown as Agent
    expect(orchestrationToolVisible(composedRelayOverridesStaleProjection)).toBe(false)
  })
})

describe('caller delivery and roles', () => {
  it('defaults omitted role to general-purpose and mounts dsh-roles-general-purpose', async () => {
    const { env, registered } = environment()
    const parent = agent('root')
    const child = activation({ output: [{ type: 'text', text: 'Implemented change.' }], stopReason: 'completed' })
    const startActivation = vi.fn(async (_spec: unknown) => child)
    const ctx = { subagents: { startActivation }, logger: { warn: vi.fn(), info: vi.fn() } } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)
    const value = await tool.execute({
      description: 'default task',
      prompt: 'Do the work.',
    }, exec('gp-1', parent, {})) as { kind: string; role: string; text: string }

    expect(startActivation).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'spawn',
      delivery: 'caller',
      agentPreset: 'dsh-roles-general-purpose',
      maxDepth: 1,
    }))
    expect(value.kind).toBe('result')
    expect(value.role).toBe('general-purpose')
    expect(registered[0]?.role).toBe('general-purpose')
  })

  it('routes plan and dsh-code-guide to their presets and injects # Current DSH Environment into dsh-code-guide', async () => {
    const { env } = environment()
    const parent = agent('root')
    const child = activation({ output: [{ type: 'text', text: 'Plan / Guide answer' }], stopReason: 'completed' })
    const startActivation = vi.fn(async (_spec: unknown) => child)
    const ctx = { subagents: { startActivation }, logger: { warn: vi.fn(), info: vi.fn() } } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)

    await tool.execute({
      role: 'plan',
      description: 'design plan',
      prompt: 'Plan the feature.',
    }, exec('plan-1', parent, {}))
    expect(startActivation).toHaveBeenNthCalledWith(1, expect.objectContaining({
      provider: 'spawn',
      agentPreset: 'dsh-roles-plan',
    }))

    await tool.execute({
      role: 'dsh-code-guide',
      description: 'ask dsh question',
      prompt: 'How do Cordis plugins work?',
    }, exec('guide-1', parent, {}))
    const guideSpec = startActivation.mock.calls[1]?.[0] as unknown as {
      agentPreset: string
      prompt: Array<{ text: string }>
    }
    expect(guideSpec.agentPreset).toBe('dsh-roles-guide')
    expect(guideSpec.prompt[0]?.text).toContain('# Current DSH Environment')
    expect(guideSpec.prompt[0]?.text).toContain('@deepseek-ai/')
  })

  it('passes per-role configured model and reasoningEffort on spawn-backed roles', async () => {
    const { env } = environment({}, {
      models: {
        plan: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'high' },
      },
    })
    const child = activation({ output: [{ type: 'text', text: '### Critical Files for Implementation' }], stopReason: 'completed' })
    const startActivation = vi.fn(async (_spec: unknown) => child)
    const ctx = { subagents: { startActivation }, logger: { warn: vi.fn(), info: vi.fn() } } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)

    await tool.execute({
      role: 'plan',
      description: 'architect design',
      prompt: 'Design module boundaries.',
    }, exec('model-1', agent('root'), {}))

    expect(startActivation).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'spawn',
      agentPreset: 'dsh-roles-plan',
      agentOptions: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'high' },
    }))
  })

  it('supports external subagentProvider (e.g. oar-codex) by omitting unsupported fields and adopting activation.childId', async () => {
    const { env, registered, retained, settledExternal } = environment({}, {
      models: {
        'general-purpose': { subagentProvider: 'oar-codex', provider: 'codex-cli', model: 'gpt-5-codex' },
      },
    })
    const externalProvider = {
      name: 'oar-codex',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      inheritsParentContext: false,
      prepareContinuable: undefined,
    }
    const startActivation = vi.fn()
      .mockResolvedValueOnce(activation({ output: [{ type: 'text', text: 'OAR sync done' }], stopReason: 'completed' }, 'oar-child-sync' as any))
      .mockResolvedValueOnce(activation({ output: [{ type: 'text', text: 'OAR bg done' }], stopReason: 'completed' }, 'oar-child-bg' as any))

    const ctx = {
      subagents: {
        startActivation,
        getProvider: (name: string) => name === 'oar-codex' ? externalProvider : undefined,
      },
      logger: { warn: vi.fn(), info: vi.fn() },
    } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)

    const appendedEvents: Array<{ type: string; data: unknown }> = []
    const rootWithCatalog = agent('root', {}, (type, data) => { appendedEvents.push({ type, data }) })

    const syncResult = await tool.execute({
      role: 'general-purpose',
      description: 'oar sync work',
      prompt: 'Implement A.',
      name: 'ignored-in-caller',
      writeScope: ['packages/a'],
    }, exec('oar-1', rootWithCatalog, {})) as { kind: string; provider: string; text: string }

    const firstSpec = startActivation.mock.calls[0]?.[0] as Record<string, unknown>
    expect(firstSpec.provider).toBe('oar-codex')
    expect(firstSpec.label).toBe('[gp · oar-codex] oar sync work')
    expect('childId' in firstSpec).toBe(false)
    expect('agentPreset' in firstSpec).toBe(false)
    expect('maxDepth' in firstSpec).toBe(false)
    expect('agentOptions' in firstSpec).toBe(false)
    expect('name' in firstSpec).toBe(false)
    expect((firstSpec.prompt as Array<{ text: string }>)[0]?.text).toContain('Step budget guidance: stay within roughly 16 tool steps')
    expect(syncResult.provider).toBe('oar-codex')
    expect(syncResult.text).toContain('[general-purpose/standard · oar-codex] completed')
    expect(syncResult.text).not.toContain('0 step(s)')
    expect(syncResult.text).toContain('OAR sync done')
    expect(appendedEvents).toHaveLength(1)
    expect(appendedEvents[0]).toEqual({
      type: 'subagent/catalog',
      data: expect.objectContaining({
        version: 2,
        childId: 'oar-child-sync',
        mode: 'external',
        label: '[gp · oar-codex] oar sync work',
      }),
    })
    expect(registered[0]?.childId).toBe('oar-child-sync')
    expect(settledExternal).toContainEqual({ childId: 'oar-child-sync', stopReason: 'completed' })

    const bgResult = await tool.execute({
      role: 'general-purpose',
      description: 'oar bg work',
      prompt: 'Implement B.',
      background: true,
      name: 'codex-worker',
      writeScope: ['packages/b'],
    }, exec('oar-2', rootWithCatalog, {})) as { kind: string; provider: string; name: string }
    expect(bgResult).toEqual({ kind: 'activation', role: 'general-purpose', provider: 'oar-codex', name: 'agent-1' })
    // Background (`delivery: 'parent'`) relies on DSH's own `establishExternalCatalogChild` — no duplicate append.
    expect(appendedEvents).toHaveLength(1)
    expect(tool.output.presentationMeta?.({}, bgResult)).toEqual({
      kind: 'activation',
      name: 'agent-1',
      role: 'general-purpose',
      provider: 'oar-codex',
    })
    expect(tool.output.render({}, bgResult)).toEqual([{
      type: 'text',
      text: 'started general-purpose (oar-codex) subagent agent-1',
    }])
    expect(retained.map(item => item.childId)).toEqual(['oar-child-bg'])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settledExternal).toContainEqual({ childId: 'oar-child-bg', stopReason: 'completed' })
  })

  it('rejects invalid role-specific options and nested fork before starting a child', async () => {
    const { env } = environment({ managedRoleOf: target => target.id === 'fork-parent' ? 'fork' : undefined })
    const startActivation = vi.fn()
    const ctx = { subagents: { startActivation }, logger: { warn: vi.fn(), info: vi.fn() } } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)
    for (const role of ['explore', 'plan', 'fork', 'dsh-code-guide'] as const) {
      await expect(tool.execute({
        role,
        description: 'bad',
        prompt: 'x',
        writeScope: ['packages/app'],
      }, exec(`bad-scope-${role}`, agent('other'), {}))).rejects.toThrow(/writeScope is only supported/)
    }
    await expect(tool.execute({
      role: 'fork',
      description: 'nested fork',
      prompt: 'fork again',
    }, exec('bad-fork', agent('fork-parent'), {}))).rejects.toThrow(/Fork is not available/)
    await expect(tool.execute({
      role: 'general-purpose',
      description: 'unsafe scope',
      prompt: 'edit outside',
      writeScope: ['../outside'],
    }, exec('bad-gp-scope', agent('other'), {}))).rejects.toBeInstanceOf(ToolArgsError)
    expect(startActivation).not.toHaveBeenCalled()
  })
})

describe('background delivery', () => {
  it('returns the activation immediately and leaves cleanup to the runtime', async () => {
    const { env, retained } = environment()
    const child = activation({ output: [], stopReason: 'completed' })
    const ctx = {
      subagents: { startActivation: vi.fn(async () => child) },
      logger: { warn: vi.fn(), info: vi.fn() },
    } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)
    const value = await tool.execute({
      role: 'general-purpose',
      description: 'edit module',
      prompt: 'Implement it.',
      background: true,
      writeScope: ['packages/app'],
    }, exec('bg-1', agent('root'), {})) as { kind: string; name: string }

    expect(value).toEqual({ kind: 'activation', role: 'general-purpose', provider: 'spawn', name: 'agent-1' })
    expect(child.dispose).not.toHaveBeenCalled()
    expect(retained).toHaveLength(1)
  })
})

describe('startup failure', () => {
  it('releases the pre-registered child so no stale role mapping remains', async () => {
    const { env, released } = environment()
    const ctx = {
      subagents: { startActivation: vi.fn(async () => { throw new Error('provider unavailable') }) },
      logger: { warn: vi.fn(), info: vi.fn() },
    } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)
    await expect(tool.execute({
      role: 'fork',
      description: 'audit',
      prompt: 'Audit the change.',
    }, exec('fail-1', agent('root'), {}))).rejects.toThrow(/provider unavailable/)
    expect(released).toHaveLength(1)
  })

  it('disposes the activation when the parent request is aborted', async () => {
    const { env } = environment()
    const child = activation({ output: [], stopReason: 'aborted' })
    const ctx = {
      subagents: { startActivation: vi.fn(async () => child) },
      logger: { warn: vi.fn(), info: vi.fn() },
    } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)
    const controller = new AbortController()
    const context = { ...exec('abort-1', agent('root'), {}), signal: controller.signal }
    controller.abort()
    await expect(tool.execute({
      role: 'general-purpose',
      description: 'edit',
      prompt: 'Implement.',
      writeScope: ['packages/app'],
    }, context)).rejects.toThrow(/aborted/)
    expect(child.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('tool result contract', () => {
  it('renders a completed result and marks non-completed runs as errors', async () => {
    const { env } = environment()
    const parent = agent('root')
    const ctx = {
      subagents: {
        startActivation: vi.fn(async () => activation({ output: [{ type: 'text', text: 'partial finding' }], stopReason: 'refusal' })),
      },
      logger: { warn: vi.fn(), info: vi.fn() },
    } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)
    await expect(tool.execute({
      role: 'fork',
      description: 'audit',
      prompt: 'Find defects.',
    }, exec('result-1', parent, {}))).rejects.toThrow(/refusal[\s\S]*partial finding/)
    const rendered = tool.output.render({}, {
      kind: 'result',
      role: 'explore',
      text: 'summary',
    })
    expect(rendered).toEqual([{ type: 'text', text: 'summary' }])
  })

  it('preserves non-empty output when the step budget rejected an extra step', async () => {
    const { env } = environment({
      registerChild: (_childId, pending) => {
        pending.state.budgetExhausted = true
      },
    })
    const ctx = {
      subagents: {
        startActivation: vi.fn(async () => activation({ output: [{ type: 'text', text: 'partial Key Files: src/a.ts:1-9' }], stopReason: 'refusal' })),
      },
      logger: { warn: vi.fn(), info: vi.fn() },
    } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)
    const value = await tool.execute({
      role: 'explore',
      thoroughness: 'quick',
      description: 'search',
      prompt: 'Find a.',
    }, exec('result-2', agent('root'), {})) as { kind: string; stopReason: string; text: string }
    expect(value.kind).toBe('result')
    expect(value.stopReason).toBe('budget-exhausted')
    expect(value.text).toContain('partial Key Files: src/a.ts:1-9')
  })

  it('normalizes benign camelCase/underscore child names before forwarding to startActivation', async () => {
    expect(normalizeChildName(undefined)).toBeUndefined()
    expect(normalizeChildName('sgm-goBack-probe')).toBe('sgm-go-back-probe')
    expect(normalizeChildName('Review_Worker 1')).toBe('review-worker-1')
    expect(normalizeChildName('already-valid-1')).toBe('already-valid-1')
    expect(normalizeChildName('lead')).toBe('lead')
    expect(normalizeChildName('Lead')).toBe('Lead')
    expect(normalizeChildName('123-bad')).toBe('123-bad')
    expect(normalizeChildName('aVeryLongCamelCaseSubagentNameThatExceedsTheLimit')).toBe('a-very-long-camel-case-subagent')

    const { env } = environment()
    const startActivation = vi.fn(async () => activation({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }))
    const ctx = {
      subagents: { startActivation },
      logger: { warn: vi.fn(), info: vi.fn() },
    } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)
    await tool.execute({
      role: 'general-purpose',
      name: 'sgm-goBack-probe',
      description: 'Query SGM errors',
      prompt: 'Check goBack timeout.',
    }, exec('name-norm-1', agent('root'), {}))
    expect(startActivation).toHaveBeenCalledWith(expect.objectContaining({
      name: 'sgm-go-back-probe',
      label: '[gp] Query SGM errors',
    }))
  })

  it('includes implementation delegation examples alongside a trivial-task direct whitelist', () => {
    const { env } = environment()
    const ctx = { subagents: { startActivation: vi.fn() }, logger: { warn: vi.fn(), info: vi.fn() } } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)
    expect(tool.description).toContain('Feature implementation, bug fixes, refactors')
    expect(tool.description).toContain('Add login rate limiting')
    expect(tool.description).toContain('Handle trivial tasks directly without delegating')
  })

  it('prefixes activation labels with compact English role tags without double-prefixing', () => {
    expect(formatActivationLabel('general-purpose', 'Review 3-file diff')).toBe('[gp] Review 3-file diff')
    expect(formatActivationLabel('explore', 'Locate auth middleware')).toBe('[exp] Locate auth middleware')
    expect(formatActivationLabel('plan', 'Design refactor steps')).toBe('[plan] Design refactor steps')
    expect(formatActivationLabel('fork', 'Verify test regressions')).toBe('[fork] Verify test regressions')
    expect(formatActivationLabel('dsh-code-guide', 'Verify DSH MCP lazy loading support')).toBe('[guide] Verify DSH MCP lazy loading support')
    expect(formatActivationLabel('dsh-code-guide', '[guide] Already tagged')).toBe('[guide] Already tagged')
    expect(formatActivationLabel('general-purpose', '[general-purpose] Already tagged')).toBe('[general-purpose] Already tagged')
    expect(formatActivationLabel('general-purpose', 'deep review MR 939 diff', 'oar-antigravity')).toBe('[gp · oar-antigravity] deep review MR 939 diff')
    expect(formatActivationLabel('general-purpose', 'local edit', 'spawn')).toBe('[gp] local edit')
    expect(formatActivationLabel('general-purpose', '[gp · oar-antigravity] Already tagged', 'oar-antigravity')).toBe('[gp · oar-antigravity] Already tagged')
  })
})

describe('readOnly and worktree isolation', () => {
  function initRepo(): { repoRoot: string; baseCommit: string; cleanup: () => void } {
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-roles-tool-wt-')))
    const run = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test-user',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test-user',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim()
    run(['init', '-b', 'main'])
    writeFileSync(join(repoRoot, 'index.ts'), 'export const v = 1\n')
    run(['add', '.'])
    run(['commit', '-m', 'init'])
    return {
      repoRoot,
      baseCommit: run(['rev-parse', 'HEAD']),
      cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
    }
  }

  it('rejects readOnly/isolation on non-general-purpose roles and conflicting combinations on general-purpose', async () => {
    const { env } = environment()
    const startActivation = vi.fn()
    const ctx = { subagents: { startActivation }, logger: { warn: vi.fn(), info: vi.fn() } } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)

    for (const role of ['explore', 'plan', 'fork', 'dsh-code-guide'] as const) {
      await expect(tool.execute({
        role,
        description: 'bad ro',
        prompt: 'x',
        readOnly: true,
      }, exec(`bad-ro-${role}`, agent('root'), {}))).rejects.toThrow(/readOnly is only supported/)

      await expect(tool.execute({
        role,
        description: 'bad iso',
        prompt: 'x',
        isolation: 'worktree',
      }, exec(`bad-iso-${role}`, agent('root'), {}))).rejects.toThrow(/isolation is only supported/)
    }

    await expect(tool.execute({
      role: 'general-purpose',
      description: 'conflict scope',
      prompt: 'x',
      readOnly: true,
      writeScope: ['src'],
    }, exec('ro-scope', agent('root'), {}))).rejects.toThrow(/readOnly cannot be combined with writeScope/)

    await expect(tool.execute({
      role: 'general-purpose',
      description: 'conflict wt',
      prompt: 'x',
      readOnly: true,
      isolation: 'worktree',
    }, exec('ro-wt', agent('root'), {}))).rejects.toThrow(/readOnly cannot be combined with isolation/)

    expect(startActivation).not.toHaveBeenCalled()
  })

  it('allows concurrent readOnly general-purpose calls without blocking on the write coordinator', async () => {
    const pendingChildren = new Map<string, PendingChild>()
    const { env } = environment({
      registerChild: (childId, child) => { pendingChildren.set(childId, child) },
    })
    const parent = agent('root')
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })

    const startActivation = vi.fn(async (spec: { childId: string; prompt: Array<{ text: string }> }) => {
      if (startActivation.mock.calls.length === 1) {
        return {
          childId: spec.childId,
          name: 'ro-1',
          result: firstGate.then(() => ({ output: [{ type: 'text', text: 'review 1' }], stopReason: 'completed' as const })),
          dispose: vi.fn(async () => {}),
        }
      }
      return activation({ output: [{ type: 'text', text: 'review 2' }], stopReason: 'completed' }, spec.childId as any)
    })
    const ctx = { subagents: { startActivation }, logger: { warn: vi.fn(), info: vi.fn() } } as unknown as Context
    const tool = createOrchestrationTool(ctx, env)

    const firstPromise = tool.execute({
      role: 'general-purpose',
      readOnly: true,
      description: 'security review',
      prompt: 'Audit auth.',
    }, exec('ro-1', parent, {}))
    const secondPromise = tool.execute({
      role: 'general-purpose',
      readOnly: true,
      description: 'perf review',
      prompt: 'Audit queries.',
    }, exec('ro-2', parent, {}))

    // Even a mutating general-purpose call can run alongside readOnly workers.
    const thirdPromise = tool.execute({
      role: 'general-purpose',
      description: 'edit docs',
      prompt: 'Update docs.',
    }, exec('mut-1', parent, {}))

    releaseFirst()
    const [first, second, third] = await Promise.all([firstPromise, secondPromise, thirdPromise]) as Array<{ kind: string; text: string }>
    expect(first.kind).toBe('result')
    expect(second.kind).toBe('result')
    expect(third.kind).toBe('result')
    const firstPrompt = (startActivation.mock.calls[0]?.[0] as { prompt: Array<{ text: string }> }).prompt[0]?.text
    expect(firstPrompt).toContain('Read-only mode is active')
    expect([...pendingChildren.values()].filter(c => c.readOnly).length).toBe(2)
  })

  it('requires official @deepseek-ai/dsh-experimental-worktree and rejects external OAR for isolation="worktree"', async () => {
    const repo = initRepo()
    try {
      const parent = agent('root', { cwd: repo.repoRoot })
      const { env: noServiceEnv } = environment({ getWorktreeService: () => undefined })
      const ctx = { subagents: { startActivation: vi.fn() }, logger: { warn: vi.fn(), info: vi.fn() } } as unknown as Context
      const noServiceTool = createOrchestrationTool(ctx, noServiceEnv)
      await expect(noServiceTool.execute({
        role: 'general-purpose',
        isolation: 'worktree',
        description: 'wt without plugin',
        prompt: 'Implement A.',
      }, exec('wt-missing', parent, {}))).rejects.toThrow(/@deepseek-ai\/dsh-experimental-worktree/)

      const { env: oarEnv } = environment(
        { getWorktreeService: () => ({ create: vi.fn() }) },
        { models: { 'general-purpose': { subagentProvider: 'oar-codex' } } },
      )
      const oarCtx = {
        subagents: {
          startActivation: vi.fn(),
          getProvider: () => ({
            name: 'oar-codex',
            capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
            inheritsParentContext: false,
          }),
        },
        logger: { warn: vi.fn(), info: vi.fn() },
      } as unknown as Context
      const oarTool = createOrchestrationTool(oarCtx, oarEnv)
      await expect(oarTool.execute({
        role: 'general-purpose',
        isolation: 'worktree',
        description: 'wt on oar',
        prompt: 'Implement A.',
      }, exec('wt-oar', parent, {}))).rejects.toThrow(/local DSH subagent runtime/)
    } finally {
      repo.cleanup()
    }
  })

  it('runs concurrent worktree workers without write-lock collision, auto-commits changes, and returns structured merge coordinates', async () => {
    const repo = initRepo()
    try {
      const parent = agent('root', { cwd: repo.repoRoot })
      const pendingChildren = new Map<string, PendingChild>()
      const { env } = environment({
        getWorktreeService: () => ({ create: vi.fn() }),
        registerChild: (childId, child) => { pendingChildren.set(childId, child) },
      })

      let releaseA!: () => void
      const gateA = new Promise<void>(resolve => { releaseA = resolve })

      const startActivation = vi.fn(async (spec: { childId: string; name?: string; prompt: Array<{ text: string }> }) => {
        const pending = pendingChildren.get(spec.childId)!
        const branch = pending.worktreeRequest?.branchName ?? `dsh-wt-${spec.childId.slice(0, 6)}`
        const wtPath = join(repo.repoRoot, '.agents', 'worktrees', branch)
        execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-b', branch, '--', wtPath, repo.baseCommit], {
          cwd: repo.repoRoot,
        })
        const created: CreatedWorktree = { path: wtPath, branch, baseCommit: repo.baseCommit, repositoryRoot: repo.repoRoot }
        pending.worktree = created

        if (spec.name === 'worker-a') {
          writeFileSync(join(wtPath, 'index.ts'), 'export const v = 10\n')
          return {
            childId: spec.childId,
            name: 'worker-a',
            result: gateA.then(() => ({ output: [{ type: 'text', text: 'Worker A edited index.ts' }], stopReason: 'completed' as const })),
            dispose: vi.fn(async () => {}),
          }
        }
        // Worker B leaves no changes -> should auto-clean.
        return activation({ output: [{ type: 'text', text: 'Worker B found nothing to change' }], stopReason: 'completed' }, spec.childId as any)
      })

      const ctx = { subagents: { startActivation }, logger: { warn: vi.fn(), info: vi.fn() } } as unknown as Context
      const tool = createOrchestrationTool(ctx, env)

      const aPromise = tool.execute({
        role: 'general-purpose',
        isolation: 'worktree',
        name: 'worker-a',
        description: 'update index value',
        prompt: 'Update index.ts.',
      }, exec('wt-a', parent, {}))

      const bPromise = tool.execute({
        role: 'general-purpose',
        isolation: 'worktree',
        name: 'worker-b',
        description: 'check index value',
        prompt: 'Verify index.ts.',
      }, exec('wt-b', parent, {}))

      releaseA()
      const [resA, resB] = await Promise.all([aPromise, bPromise]) as Array<{ kind: string; text: string; worktree?: WorktreeOutcome }>

      expect(resA.kind).toBe('result')
      expect(resA.worktree?.status).toBe('ready-to-merge')
      expect(resA.worktree?.autoCommitted).toBe(true)
      expect(resA.worktree?.changedFiles).toEqual(['index.ts'])
      expect(resA.text).toContain('Worktree: ready-to-merge')
      expect(resA.text).toContain('git merge --squash')

      expect(resB.kind).toBe('result')
      expect(resB.worktree?.status).toBe('no-changes')
      expect(resB.worktree?.cleanedUp).toBe(true)
      expect(existsSync(resB.worktree!.path)).toBe(false)
      expect(resB.text).toContain('no changes made; automatically removed')

      const promptA = (startActivation.mock.calls[0]?.[0] as { prompt: Array<{ text: string }> }).prompt[0]?.text
      expect(promptA).toContain('Worktree isolation is active')
    } finally {
      repo.cleanup()
    }
  })

  it('reports active worktree metadata for background runs and cleans up on startup failure', async () => {
    const repo = initRepo()
    try {
      const parent = agent('root', { cwd: repo.repoRoot })
      const pendingChildren = new Map<string, PendingChild>()
      const { env } = environment({
        getWorktreeService: () => ({ create: vi.fn() }),
        registerChild: (childId, child) => { pendingChildren.set(childId, child) },
      })

      let createdFailedPath = ''
      const startActivation = vi.fn()
        .mockImplementationOnce(async (spec: { childId: string }) => {
          const pending = pendingChildren.get(spec.childId)!
          const branch = pending.worktreeRequest?.branchName ?? 'dsh-bg-wt'
          const wtPath = join(repo.repoRoot, '.agents', 'worktrees', branch)
          execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-b', branch, '--', wtPath, repo.baseCommit], {
            cwd: repo.repoRoot,
          })
          pending.worktree = { path: wtPath, branch, baseCommit: repo.baseCommit, repositoryRoot: repo.repoRoot }
          return activation({ output: [], stopReason: 'completed' }, spec.childId as any)
        })
        .mockImplementationOnce(async (spec: { childId: string }) => {
          const pending = pendingChildren.get(spec.childId)!
          const branch = pending.worktreeRequest?.branchName ?? 'dsh-fail-wt'
          const wtPath = join(repo.repoRoot, '.agents', 'worktrees', branch)
          createdFailedPath = wtPath
          execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-b', branch, '--', wtPath, repo.baseCommit], {
            cwd: repo.repoRoot,
          })
          pending.worktree = { path: wtPath, branch, baseCommit: repo.baseCommit, repositoryRoot: repo.repoRoot }
          throw new Error('startup exploded')
        })

      const ctx = { subagents: { startActivation }, logger: { warn: vi.fn(), info: vi.fn() } } as unknown as Context
      const tool = createOrchestrationTool(ctx, env)

      const bg = await tool.execute({
        role: 'general-purpose',
        isolation: 'worktree',
        background: true,
        name: 'bg-worker',
        description: 'background worktree',
        prompt: 'Work in bg.',
      }, exec('wt-bg', parent, {})) as { kind: string; worktree?: WorktreeOutcome; name?: string }

      expect(bg.kind).toBe('activation')
      expect(bg.worktree?.status).toBe('active')
      expect(bg.worktree?.cleanedUp).toBe(false)
      expect(tool.output.render({}, bg as any)).toEqual([{
        type: 'text',
        text: `started general-purpose subagent agent-1 (worktree branch ${bg.worktree!.branch} at ${bg.worktree!.path})`,
      }])

      await expect(tool.execute({
        role: 'general-purpose',
        isolation: 'worktree',
        name: 'fail-worker',
        description: 'startup failure cleanup',
        prompt: 'Should fail.',
      }, exec('wt-fail', parent, {}))).rejects.toThrow(/startup exploded/)
      expect(existsSync(createdFailedPath)).toBe(false)
    } finally {
      repo.cleanup()
    }
  })
})
