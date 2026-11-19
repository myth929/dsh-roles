import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import { resolveOrchestrationConfig } from '../src/config.js'
import { GUIDE_TOOL_NAMES } from '../src/guide.js'
import {
  CHILD_POLICY_RECORD_TYPE,
  enforceWriteScope,
  installStepBudget,
  isolateRoleTools,
  READ_ONLY_TOOL_NAMES,
  readChildPolicy,
  stripExplorationInstructions,
} from '../src/runtime.js'
import { normalizeWriteScopes } from '../src/scope.js'

interface Harness {
  agent: Agent
  restrict: ReturnType<typeof vi.fn>
  guard: ReturnType<typeof vi.fn>
  listeners: Array<{ event: string; listener: (...args: any[]) => any; options?: unknown }>
  definitions: string[]
}

function harness(
  definitions = ['read', 'glob', 'grep', 'bash', 'write', 'web_fetch', 'web_search', 'cordis_inspect_list', 'cordis_inspect_query', 'mcp__jira'],
  headerOverrides: Record<string, unknown> = {},
): Harness {
  const listeners: Harness['listeners'] = []
  const restrict = vi.fn(() => () => {})
  const guard = vi.fn(() => () => {})
  const agent = {
    id: 'child',
    options: {},
    session: { id: 'child', header: { version: 4, id: 'child', createdAt: 0, isSeeded: false, cwd: process.cwd(), ...headerOverrides } },
    ctx: {
      tools: {
        definitions: vi.fn(() => definitions.map(name => ({ name }))),
        restrict,
        guard,
      },
      on: vi.fn((event: string, listener: (...args: any[]) => any, options?: unknown) => {
        listeners.push({ event, listener, options })
        return () => {}
      }),
      logger: { warn: vi.fn(), info: vi.fn() },
    },
  } as unknown as Agent
  return { agent, restrict, guard, listeners, definitions }
}

describe('role isolation', () => {
  it('restricts explore and plan to known read-only file tools, installs a read-only guard, and strips instructions', () => {
    for (const role of ['explore', 'plan'] as const) {
      const { agent, restrict, guard, listeners } = harness()
      isolateRoleTools(agent, role, { includeMcp: false })
      expect(restrict).toHaveBeenCalledWith({ allow: ['read', 'glob', 'grep'] })
      expect(guard).toHaveBeenCalledTimes(1)
      const preStep = listeners.find(listener => listener.event === 'agent/pre-step')
      expect(preStep?.options).toEqual({ prepend: true })
    }
  })

  it('restricts dsh-code-guide to doc, web, and Cordis inspect tools while stripping workspace instructions', () => {
    const { agent, restrict, guard, listeners } = harness()
    isolateRoleTools(agent, 'dsh-code-guide', { includeMcp: false })
    expect(restrict).toHaveBeenCalledWith({
      allow: ['read', 'glob', 'grep', 'web_fetch', 'web_search', 'cordis_inspect_list', 'cordis_inspect_query'],
    })
    expect(guard).toHaveBeenCalledTimes(1)
    const check = guard.mock.calls[0]?.[0] as (exec: ToolExecution) => { reason: string } | undefined
    expect(check({ name: 'web_fetch', arguments: {} } as ToolExecution)).toBeUndefined()
    expect(check({ name: 'cordis_inspect_query', arguments: {} } as ToolExecution)).toBeUndefined()
    expect(check({ name: 'bash', arguments: {} } as ToolExecution)?.reason).toMatch(/read-only/)
    expect(check({ name: 'write', arguments: {} } as ToolExecution)?.reason).toMatch(/read-only/)
    expect(listeners.find(listener => listener.event === 'agent/pre-step')?.options).toEqual({ prepend: true })
    expect(GUIDE_TOOL_NAMES.has('cordis_inspect_list')).toBe(true)
  })

  it('masks every inherited global when no read-only global exists', () => {
    const { agent, restrict } = harness(['bash', 'mcp__jira'])
    isolateRoleTools(agent, 'explore', { includeMcp: false })
    expect(restrict).toHaveBeenCalledWith({ allow: [] })
  })

  it('strips only external MCP tools for default general-purpose and keeps them when includeMcp is true', () => {
    const defaultGp = harness()
    isolateRoleTools(defaultGp.agent, 'general-purpose', { includeMcp: false })
    expect(defaultGp.restrict).toHaveBeenCalledWith({ deny: ['mcp__jira'] })
    expect(defaultGp.restrict).not.toHaveBeenCalledWith({ allow: [] })

    const optedIn = harness()
    isolateRoleTools(optedIn.agent, 'general-purpose', { includeMcp: true })
    expect(optedIn.restrict).not.toHaveBeenCalled()
  })

  it('keeps parent tools and permissions for fork while guarding against nested delegation', () => {
    const forkChild = harness(undefined, { delegationDepth: 1 })
    isolateRoleTools(forkChild.agent, 'fork', { includeMcp: false })
    expect(forkChild.restrict).not.toHaveBeenCalled()
    expect(forkChild.guard).toHaveBeenCalledTimes(1)
    const limitGuard = forkChild.guard.mock.calls[0]?.[0] as (exec: ToolExecution) => { reason: string; info?: { code?: string } } | undefined
    // Claude-aligned: fork keeps full tool permissions (bash, write, edit allowed).
    expect(limitGuard({ name: 'bash', arguments: { command: 'git diff' } } as ToolExecution)).toBeUndefined()
    expect(limitGuard({ name: 'write', arguments: { file_path: 'a.ts', content: 'x' } } as ToolExecution)).toBeUndefined()
    // Single-level delegation: nested fork and nested subagent calls are both denied.
    expect(limitGuard({ name: 'orchestrate_subagent', arguments: { role: 'fork' } } as ToolExecution)?.info?.code).toBe('NESTED_FORK_DENIED')
    expect(limitGuard({ name: 'orchestrate_subagent', arguments: { role: 'explore' } } as ToolExecution)?.info?.code).toBe('MAX_DEPTH_REACHED')
  })

  it('reads preset-scoped tools via scopeParentOf when host globals disable them', async () => {
    const root = new Context()
    const presetScope = createScope(root, { preset: 'dsh-orchestration-explore' })
    const agentObj = { id: 'child-scoped' }
    const childScope = createScope(root, agentObj, { parent: presetScope.ctx.get('scope') })
    bindScopeParent(agentObj, { presetKey: true })
    const restrict = vi.fn(() => () => {})
    const guard = vi.fn(() => () => {})
    const definitions = vi.fn((scope?: unknown) =>
      scope === agentObj ? [] : scope !== undefined ? [{ name: 'read' }, { name: 'glob' }, { name: 'grep' }] : [{ name: 'bash' }],
    )
    const scopedAgent = Object.assign(agentObj, {
      options: {},
      session: { id: 'child-scoped', header: { version: 4, id: 'child-scoped', createdAt: 0, isSeeded: false, cwd: process.cwd() } },
      ctx: {
        tools: { definitions, restrict, guard },
        on: vi.fn(() => () => {}),
        logger: { warn: vi.fn(), info: vi.fn() },
      },
    }) as unknown as Agent
    try {
      isolateRoleTools(scopedAgent, 'explore', { includeMcp: false })
      expect(definitions).toHaveBeenCalledWith({ presetKey: true })
      expect(restrict).toHaveBeenCalledWith({ allow: ['read', 'glob', 'grep'] })
    } finally {
      await childScope.dispose()
      await presetScope.dispose()
    }
  })

  it('rejects non-read-only calls in explore and plan', async () => {
    const { agent, guard } = harness()
    isolateRoleTools(agent, 'plan', { includeMcp: false })
    const check = guard.mock.calls[0]?.[0] as (exec: ToolExecution) => { reason: string } | undefined
    expect(check({ name: 'read', arguments: {} } as ToolExecution)).toBeUndefined()
    expect(check({ name: 'bash', arguments: {} } as ToolExecution)?.reason).toMatch(/read-only/)
    expect([...READ_ONLY_TOOL_NAMES]).toEqual(['read', 'glob', 'grep'])
  })
})

describe('exploration instruction filtering', () => {
  it('removes workspace instructions and skill catalogs from the admitted step', async () => {
    const { agent, listeners } = harness()
    stripExplorationInstructions(agent)
    const listener = listeners[0]!.listener
    const instruction = { id: '1', role: 'user', content: [], source: { kind: 'agent-instructions' } } as unknown as UserMessage
    const catalog = { id: '2', role: 'user', content: [], source: { kind: 'skill-catalog' } } as unknown as UserMessage
    const prompt = { id: '3', role: 'user', content: [], source: { kind: 'user' } } as unknown as UserMessage
    const decision = await listener({}, async () => ({ kind: 'enter', messages: [instruction, catalog, prompt] }))
    expect(decision.messages).toEqual([prompt])
  })
})

describe('caller write scope', () => {
  it('denies a write outside the declared prefixes', () => {
    const { agent, guard } = harness()
    enforceWriteScope(agent, normalizeWriteScopes(['packages/app'])!, process.cwd())
    const check = guard.mock.calls[0]?.[0] as (exec: ToolExecution) => { reason: string } | undefined
    expect(check({ name: 'write', arguments: { file_path: 'packages/app/src/a.ts' } } as ToolExecution)).toBeUndefined()
    expect(check({ name: 'write', arguments: { file_path: 'docs/a.md' } } as ToolExecution)?.reason).toMatch(/outside/)
  })
})

describe('step budget', () => {
  const config = resolveOrchestrationConfig({ budgets: '{"explore":{"quick":3}}' }, {})
  const budget = 3

  function preStep(harnessed: Harness) {
    const entry = harnessed.listeners.find(listener => listener.event === 'agent/pre-step')
    return entry!.listener as (payload: { step: number }, next: () => Promise<unknown>) => Promise<any>
  }

  function sessionEvent(harnessed: Harness) {
    const entry = harnessed.listeners.find(listener => listener.event === 'session/event')
    return entry!.listener as (session: unknown, event: { type: string; data: { step: number } }) => void
  }

  it('passes through steps before the budget without extra messages', async () => {
    const h = harness()
    installStepBudget(h.agent, 'explore', 'quick', config)
    const decision = await preStep(h)({ step: 1 }, async () => ({ kind: 'enter', messages: [] }))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('arms tool restriction when step budget - 1 ends so the final step sees zero tools, and resets on turn/end', async () => {
    const h = harness()
    const liftRestrict = vi.fn()
    const liftGuard = vi.fn()
    h.restrict.mockReturnValue(liftRestrict)
    h.guard.mockReturnValue(liftGuard)
    installStepBudget(h.agent, 'explore', 'quick', config)
    const onSession = sessionEvent(h)
    const listener = preStep(h)

    onSession(h.agent.session, { type: 'step/end', data: { step: 1 } })
    expect(h.restrict).not.toHaveBeenCalled()

    onSession(h.agent.session, { type: 'step/end', data: { step: budget - 1 } })
    expect(h.restrict).toHaveBeenCalledWith({ allow: [] })
    expect(h.guard).toHaveBeenCalledTimes(1)

    const first = await listener({ step: budget }, async () => ({ kind: 'enter', messages: [] }))
    expect(first.kind).toBe('enter')
    expect(first.messages).toHaveLength(1)
    expect(first.messages[0].content[0].text).toMatch(/final step/)
    expect(h.restrict).toHaveBeenCalledTimes(1)

    const second = await listener({ step: budget }, async () => ({ kind: 'enter', messages: [] }))
    expect(second.messages).toHaveLength(0)

    onSession(h.agent.session, { type: 'turn/end', data: { step: budget } })
    expect(liftGuard).toHaveBeenCalledTimes(1)
    expect(liftRestrict).toHaveBeenCalledTimes(1)

    const resumed = await listener({ step: budget }, async () => ({ kind: 'enter', messages: [] }))
    expect(resumed.messages).toHaveLength(1)
    expect(h.restrict).toHaveBeenCalledTimes(2)
  })

  it('rejects every step past the budget without invoking the inner handler and marks exhaustion', async () => {
    const h = harness()
    const onBudgetExhausted = vi.fn()
    installStepBudget(h.agent, 'explore', 'quick', config, { onBudgetExhausted })
    const next = vi.fn(async () => ({ kind: 'enter', messages: [] }))
    await expect(preStep(h)({ step: budget + 1 }, next)).resolves.toEqual({ kind: 'reject' })
    expect(next).not.toHaveBeenCalled()
    expect(onBudgetExhausted).toHaveBeenCalledTimes(1)
  })
})

describe('durable child policy lookup', () => {
  it('ignores inherited records before session/end-seed and honors the child suffix across all internal presets', () => {
    const parentRecord = {
      type: CHILD_POLICY_RECORD_TYPE,
      seq: 0,
      time: 1,
      ignorable: true,
      data: { version: 1, role: 'general-purpose', thoroughness: 'standard', includeMcp: true, writeScopes: ['packages/a'] },
    }
    const endSeed = { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } }
    const childRecord = {
      type: CHILD_POLICY_RECORD_TYPE,
      seq: 2,
      time: 3,
      ignorable: true,
      data: { version: 1, role: 'fork', thoroughness: 'quick', includeMcp: false },
    }

    const withoutOwnRecord = {
      header: {},
      snapshotEvents: () => [parentRecord, endSeed] as unknown as readonly SessionEvent[],
    }
    expect(readChildPolicy(withoutOwnRecord)).toBeUndefined()

    const withOwnRecord = {
      header: {},
      snapshotEvents: () => [parentRecord, endSeed, childRecord] as unknown as readonly SessionEvent[],
    }
    expect(readChildPolicy(withOwnRecord)).toEqual({
      version: 1,
      role: 'fork',
      thoroughness: 'quick',
      includeMcp: false,
    })

    expect(readChildPolicy({ header: { agentPreset: 'dsh-orchestration-explore' } })).toMatchObject({ role: 'explore', includeMcp: false })
    expect(readChildPolicy({ header: { agentPreset: 'dsh-orchestration-plan' } })).toMatchObject({ role: 'plan', includeMcp: false })
    expect(readChildPolicy({ header: { agentPreset: 'dsh-orchestration-general-purpose' } })).toMatchObject({ role: 'general-purpose', includeMcp: false })
    expect(readChildPolicy({ header: { agentPreset: 'dsh-orchestration-guide' } })).toMatchObject({ role: 'dsh-code-guide', includeMcp: false })
  })
})
