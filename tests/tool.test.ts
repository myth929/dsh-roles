import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveOrchestrationConfig } from '../src/config.js'
import { WorkerWriteCoordinator } from '../src/scope.js'
import { createOrchestrationTool, orchestrationToolVisible } from '../src/tool.js'
import type { ToolEnvironment } from '../src/tool.js'

function agent(id: string, header: Record<string, unknown> = {}): Agent {
  return {
    id,
    options: {},
    session: { id, header: { version: 4, id, createdAt: 0, isSeeded: false, ...header } },
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
      'dsh-orchestration-explore',
      'dsh-orchestration-plan',
      'dsh-orchestration-general-purpose',
      'dsh-orchestration-guide',
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
  it('defaults omitted role to general-purpose and mounts dsh-orchestration-general-purpose', async () => {
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
      agentPreset: 'dsh-orchestration-general-purpose',
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
      agentPreset: 'dsh-orchestration-plan',
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
    expect(guideSpec.agentPreset).toBe('dsh-orchestration-guide')
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
      agentPreset: 'dsh-orchestration-plan',
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

    const syncResult = await tool.execute({
      role: 'general-purpose',
      description: 'oar sync work',
      prompt: 'Implement A.',
      name: 'ignored-in-caller',
      writeScope: ['packages/a'],
    }, exec('oar-1', agent('root'), {})) as { kind: string; text: string }

    const firstSpec = startActivation.mock.calls[0]?.[0] as Record<string, unknown>
    expect(firstSpec.provider).toBe('oar-codex')
    expect('childId' in firstSpec).toBe(false)
    expect('agentPreset' in firstSpec).toBe(false)
    expect('maxDepth' in firstSpec).toBe(false)
    expect('agentOptions' in firstSpec).toBe(false)
    expect('name' in firstSpec).toBe(false)
    expect(syncResult.text).toContain('OAR sync done')
    expect(registered[0]?.childId).toBe('oar-child-sync')
    expect(settledExternal).toContainEqual({ childId: 'oar-child-sync', stopReason: 'completed' })

    const bgResult = await tool.execute({
      role: 'general-purpose',
      description: 'oar bg work',
      prompt: 'Implement B.',
      background: true,
      name: 'codex-worker',
      writeScope: ['packages/b'],
    }, exec('oar-2', agent('root'), {})) as { kind: string; name: string }
    expect(bgResult).toEqual({ kind: 'activation', role: 'general-purpose', name: 'agent-1' })
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

    expect(value).toEqual({ kind: 'activation', role: 'general-purpose', name: 'agent-1' })
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
})
