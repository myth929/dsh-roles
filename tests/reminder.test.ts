import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { resolveOrchestrationConfig } from '../src/config.js'
import {
  DEFAULT_CATALOG_REFRESH_TURNS,
  DEFAULT_MAX_DELEGATION_NUDGES,
  DEFAULT_NUDGE_INSPECTION_STEPS,
  DELEGATION_NUDGE_SOURCE_KIND,
  formatDedicatedBackendHint,
  formatRoleCatalogText,
  hasVisibleRoleCatalog,
  installDelegationReminders,
  isInspectionTool,
  isMutationTool,
  ROLE_CATALOG_DIGEST,
  ROLE_CATALOG_SOURCE_KIND,
  ROLE_REFRESH_SOURCE_KIND,
  userTurnsSinceLastCatalogOrRefresh,
} from '../src/reminder.js'
import { ORCHESTRATION_TOOL_NAME } from '../src/tool.js'

interface FakeSessionEvent {
  readonly seq: number
  readonly type: string
  readonly data: { readonly source: Record<string, unknown> }
}

function makeAgent(id: string, visibleEvents: FakeSessionEvent[] = []): Agent & { setVisibleEvents(events: FakeSessionEvent[]): void } {
  let events = [...visibleEvents]
  const session = {
    id,
    header: { version: 4, id, createdAt: 0, isSeeded: false },
    get surface() {
      return { nodes: events.map(event => event.seq) }
    },
    eventAt: (seq: number) => events.find(event => event.seq === seq),
  }
  return {
    id,
    options: {},
    session,
    setVisibleEvents(next: FakeSessionEvent[]) {
      events = [...next]
    },
  } as unknown as Agent & { setVisibleEvents(events: FakeSessionEvent[]): void }
}

function makeHostContext(tool: ToolDefinition, visibleTool: ToolDefinition | null = tool) {
  const listeners = new Map<string, (...args: any[]) => any>()
  const ctx = {
    tools: {
      get: vi.fn((name: string) => name === ORCHESTRATION_TOOL_NAME ? (visibleTool ?? undefined) : undefined),
    },
    on: vi.fn((event: string, listener: (...args: any[]) => any) => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    }),
  } as unknown as Context
  return { ctx, listeners }
}

function userPrompt(text = 'hello'): UserMessage {
  return {
    id: `u-${Math.random()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as unknown as UserMessage
}

function toolExec(agent: Agent, name: string, args: Record<string, unknown> = {}): ToolExecution {
  return {
    callId: `call-${name}`,
    rootCallId: `call-${name}`,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
    token: Symbol('exec'),
  } as unknown as ToolExecution
}

describe('native DSH delegation reminders', () => {
  it('tail-injects the role catalog once per visible surface and re-emits after compaction', async () => {
    const tool = { name: ORCHESTRATION_TOOL_NAME } as ToolDefinition
    const { ctx, listeners } = makeHostContext(tool)
    const root = makeAgent('root')
    const dispose = installDelegationReminders(ctx, {
      tool,
      isEligibleRoot: () => true,
    })

    const preStep = listeners.get('agent/pre-step')!
    expect(ctx.on).toHaveBeenCalledWith('agent/pre-step', expect.any(Function), { prepend: true })
    const existing = {
      id: 'skill-cat',
      role: 'user',
      content: [{ type: 'text', text: '<available_skills/>' }],
      source: { kind: 'skill-catalog', form: 'catalog' },
    } as unknown as UserMessage

    const first = await preStep(
      { agent: root, messages: [userPrompt()], step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [userPrompt(), existing] }),
    )
    expect(first.kind).toBe('enter')
    expect(first.messages).toHaveLength(3)
    const catalogMsg = first.messages[2] as UserMessage
    expect(catalogMsg.source).toEqual({
      kind: ROLE_CATALOG_SOURCE_KIND,
      form: 'catalog',
      digest: ROLE_CATALOG_DIGEST,
    })
    expect((catalogMsg.content[0] as { text: string }).text).toContain('<system-reminder>')
    expect((catalogMsg.content[0] as { text: string }).text).toContain('`general-purpose`')

    // Once committed into surface.nodes, later steps and turns do not duplicate it.
    root.setVisibleEvents([{
      seq: 2,
      type: 'user/message',
      data: { source: { kind: ROLE_CATALOG_SOURCE_KIND, form: 'catalog', digest: ROLE_CATALOG_DIGEST } },
    }])
    expect(hasVisibleRoleCatalog(root)).toBe(true)

    const second = await preStep(
      { agent: root, messages: [userPrompt('turn 2')], step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [userPrompt('turn 2')] }),
    )
    expect(second.messages).toHaveLength(1)

    // After compaction removes the earlier catalog node from surface.nodes, it re-emits cleanly.
    root.setVisibleEvents([])
    expect(hasVisibleRoleCatalog(root)).toBe(false)
    const afterCompaction = await preStep(
      { agent: root, messages: [userPrompt('turn 3')], step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [userPrompt('turn 3')] }),
    )
    expect(afterCompaction.messages).toHaveLength(2)
    expect((afterCompaction.messages[1] as UserMessage).source.kind).toBe(ROLE_CATALOG_SOURCE_KIND)

    dispose()
    expect(listeners.size).toBe(0)
  })

  it('skips ineligible agents (children / Relay) and restricted tool scopes', async () => {
    const tool = { name: ORCHESTRATION_TOOL_NAME } as ToolDefinition
    const ineligible = makeHostContext(tool)
    installDelegationReminders(ineligible.ctx, { tool, isEligibleRoot: () => false })
    const child = makeAgent('child')

    const stepResult = await ineligible.listeners.get('agent/pre-step')!(
      { agent: child, messages: [userPrompt()], step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [userPrompt()] }),
    )
    expect(stepResult.messages).toHaveLength(1)

    const restricted = makeHostContext(tool, null)
    installDelegationReminders(restricted.ctx, { tool, isEligibleRoot: () => true })
    const restrictedResult = await restricted.listeners.get('agent/pre-step')!(
      { agent: makeAgent('root'), messages: [userPrompt()], step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [userPrompt()] }),
    )
    expect(restrictedResult.messages).toHaveLength(1)
  })

  it('attaches one gentle additionalContexts nudge via tools/post-execute after distinct inspection steps and resets on a new user turn', async () => {
    expect(DEFAULT_NUDGE_INSPECTION_STEPS).toBe(3)
    expect(DEFAULT_CATALOG_REFRESH_TURNS).toBe(3)
    const tool = { name: ORCHESTRATION_TOOL_NAME } as ToolDefinition
    const { ctx, listeners } = makeHostContext(tool)
    const root = makeAgent('root', [{
      seq: 0,
      type: 'user/message',
      data: { source: { kind: ROLE_CATALOG_SOURCE_KIND, form: 'catalog', digest: ROLE_CATALOG_DIGEST } },
    }])
    installDelegationReminders(ctx, {
      tool,
      isEligibleRoot: () => true,
      nudgeInspectionSteps: 3,
    })

    const preStep = listeners.get('agent/pre-step')!
    const postExec = listeners.get('tools/post-execute')!
    const downstream = { kind: 'accept' as const, additionalContexts: [userPrompt('downstream-note')] }

    // Step 1: 3 parallel inspection calls count as ONLY 1 inspection step.
    await preStep({ agent: root, messages: [userPrompt('review MR')], step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [userPrompt('review MR')] }))
    for (const name of ['bash', 'read', 'grep']) {
      const decision = await postExec(toolExec(root, name), { content: [], isError: false }, async () => ({ kind: 'accept' }))
      expect(decision.additionalContexts).toBeUndefined()
    }

    // Step 2: 2nd distinct inspection step -> still below threshold 3.
    await preStep({ agent: root, messages: [], step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    const step2 = await postExec(toolExec(root, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    expect(step2.additionalContexts).toBeUndefined()

    // Step 3: 3rd distinct inspection step -> fires one gentle notice prepended before downstream contexts.
    await preStep({ agent: root, messages: [], step: 3, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    const step3 = await postExec(toolExec(root, 'read'), { content: [], isError: false }, async () => downstream)
    expect(step3.additionalContexts).toHaveLength(2)
    const nudge = step3.additionalContexts[0] as UserMessage
    expect(nudge.source).toMatchObject({
      kind: DELEGATION_NUDGE_SOURCE_KIND,
      form: 'notice',
    })
    expect((nudge.content[0] as { text: string }).text).toContain('3 consecutive inspection steps')
    expect((nudge.content[0] as { text: string }).text).toContain('orchestrate_subagent({ role: "general-purpose"')
    expect((nudge.content[0] as { text: string }).text).toContain('finishing in 1 step')
    expect(step3.additionalContexts[1]).toBe(downstream.additionalContexts[0])

    // Step 4 in the same turn -> already nudged once, stays silent.
    await preStep({ agent: root, messages: [], step: 4, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    const step4 = await postExec(toolExec(root, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    expect(step4.additionalContexts).toBeUndefined()

    // New user turn resets counter; calling orchestrate_subagent suppresses any nudge for that turn.
    await preStep({ agent: root, messages: [userPrompt('next task')], step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [userPrompt('next task')] }))
    await postExec(toolExec(root, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    await preStep({ agent: root, messages: [], step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    await postExec(toolExec(root, ORCHESTRATION_TOOL_NAME), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    for (const step of [3, 4, 5]) {
      await preStep({ agent: root, messages: [], step, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
      const later = await postExec(toolExec(root, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))
      expect(later.additionalContexts).toBeUndefined()
    }
  })

  it('re-prompts at every threshold crossing up to the cap instead of going silent after one nudge', async () => {
    expect(DEFAULT_MAX_DELEGATION_NUDGES).toBe(3)
    const tool = { name: ORCHESTRATION_TOOL_NAME } as ToolDefinition
    const { ctx, listeners } = makeHostContext(tool)
    const root = makeAgent('root', [{
      seq: 0,
      type: 'user/message',
      data: { source: { kind: ROLE_CATALOG_SOURCE_KIND, form: 'catalog', digest: ROLE_CATALOG_DIGEST } },
    }])
    installDelegationReminders(ctx, {
      tool,
      isEligibleRoot: () => true,
      nudgeInspectionSteps: 2,
      maxNudges: 2,
    })
    const preStep = listeners.get('agent/pre-step')!
    const postExec = listeners.get('tools/post-execute')!

    const runStep = async (step: number) => {
      await preStep({ agent: root, messages: [], step, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
      return postExec(toolExec(root, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    }

    // A real turn starts with a user message; step 1 was already counted before the loop
    // below, so the first two inspection steps stay silent (1 < 2), then fire.
    await preStep({ agent: root, messages: [userPrompt('long investigation')], step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [userPrompt('long investigation')] }))
    expect((await postExec(toolExec(root, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()

    const first = await runStep(2)
    expect(first.additionalContexts).toHaveLength(1)
    expect(((first.additionalContexts![0] as UserMessage).content[0] as { text: string }).text).toContain('orchestrate_subagent({ role: "general-purpose"')
    expect(((first.additionalContexts![0] as UserMessage).content[0] as { text: string }).text).toContain('finishing in 1 step')

    // Step 3 is below the next threshold (4) and stays silent.
    expect((await runStep(3)).additionalContexts).toBeUndefined()

    // Step 4 crosses the threshold again and escalates with a direct call skeleton and no escape hatch.
    const second = await runStep(4)
    expect(second.additionalContexts).toHaveLength(1)
    const escalated = ((second.additionalContexts![0] as UserMessage).content[0] as { text: string }).text
    expect(escalated).toContain('Delegation reminder 2/2')
    expect(escalated).toContain('4 consecutive inspection steps')
    expect(escalated).toContain('orchestrate_subagent({ role: "general-purpose"')
    expect(escalated).not.toContain('finishing in 1 step')
    expect(escalated).not.toContain('Unless you are one step away')

    // Cap reached: later steps in the same turn stay silent.
    for (const step of [5, 6, 7]) {
      expect((await runStep(step)).additionalContexts).toBeUndefined()
    }

    // A new user turn re-arms the same budget.
    await preStep({ agent: root, messages: [userPrompt('next task')], step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [userPrompt('next task')] }))
    await postExec(toolExec(root, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    const rearmed = await runStep(2)
    expect(rearmed.additionalContexts).toHaveLength(1)
  })

  it('counts mcp__* and web inspection tools toward mid-turn nudges while ignoring non-inspection tools', async () => {
    expect(isInspectionTool('mcp__sgm-web__get_error_status')).toBe(true)
    expect(isInspectionTool('mcp__digger__AILogDetailQueryTool')).toBe(true)
    expect(isInspectionTool('web_search')).toBe(true)
    expect(isInspectionTool('web_fetch')).toBe(true)
    expect(isInspectionTool('hindsight_search_knowledge_pages')).toBe(false)
    expect(isInspectionTool('write')).toBe(false)

    const tool = { name: ORCHESTRATION_TOOL_NAME } as ToolDefinition
    const { ctx, listeners } = makeHostContext(tool)
    const root = makeAgent('root', [{
      seq: 0,
      type: 'user/message',
      data: { source: { kind: ROLE_CATALOG_SOURCE_KIND, form: 'catalog', digest: ROLE_CATALOG_DIGEST } },
    }])
    installDelegationReminders(ctx, { tool, isEligibleRoot: () => true })
    const preStep = listeners.get('agent/pre-step')!
    const postExec = listeners.get('tools/post-execute')!

    // Step 1: non-inspection hindsight lookup does not advance counter; mcp query does.
    await preStep({ agent: root, messages: [userPrompt('check yesterday timeout')], step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [userPrompt('check yesterday timeout')] }))
    expect((await postExec(toolExec(root, 'hindsight_search_knowledge_pages'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()
    expect((await postExec(toolExec(root, 'mcp__sgm-web__get_error_status'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()

    // Step 2: another MCP log query -> 2nd inspection step.
    await preStep({ agent: root, messages: [], step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    expect((await postExec(toolExec(root, 'mcp__digger__AILogDetailQueryTool'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()

    // Step 3: bash inspection -> hits default threshold 3 and triggers nudge mentioning includeMcp.
    await preStep({ agent: root, messages: [], step: 3, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    const third = await postExec(toolExec(root, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    expect(third.additionalContexts).toHaveLength(1)
    expect(((third.additionalContexts![0] as UserMessage).content[0] as { text: string }).text).toContain('includeMcp: true')

    // Step 4 stays silent; Step 5 fires escalated 2/3 reminder (3 -> 5 cadence).
    await preStep({ agent: root, messages: [], step: 4, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    expect((await postExec(toolExec(root, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()
    await preStep({ agent: root, messages: [], step: 5, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    const fifth = await postExec(toolExec(root, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    expect(fifth.additionalContexts).toHaveLength(1)
    expect(((fifth.additionalContexts![0] as UserMessage).content[0] as { text: string }).text).toContain('Delegation reminder 2/3')
  })

  it('refreshes a compact reminder every N user turns while the catalog stays visible, and respects dedicated backend hints and live config', async () => {
    const tool = { name: ORCHESTRATION_TOOL_NAME } as ToolDefinition
    const { ctx, listeners } = makeHostContext(tool)
    let config = resolveOrchestrationConfig({
      models: {
        'general-purpose': { subagentProvider: 'oar-antigravity' },
        plan: { provider: 'openai', model: 'gpt-5.4' },
      },
      reminders: {
        nudgeInspectionSteps: 3,
        maxNudges: 2,
        catalogRefreshTurns: 3,
      },
    }, {})
    expect(formatDedicatedBackendHint(config.models)).toContain('`general-purpose` (oar-antigravity)')
    expect(formatDedicatedBackendHint(config.models)).toContain('`plan` (openai/gpt-5.4)')

    const root = makeAgent('root')
    installDelegationReminders(ctx, {
      tool,
      isEligibleRoot: () => true,
      getConfig: () => config,
    })
    const preStep = listeners.get('agent/pre-step')!
    const postExec = listeners.get('tools/post-execute')!

    // Turn 1: emits full catalog containing dedicated backend hint.
    const turn1 = await preStep(
      { agent: root, messages: [userPrompt('turn 1')], step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [userPrompt('turn 1')] }),
    )
    expect(turn1.messages).toHaveLength(2)
    const catalogMsg = turn1.messages[1] as UserMessage
    expect(catalogMsg.source.kind).toBe(ROLE_CATALOG_SOURCE_KIND)
    expect((catalogMsg.content[0] as { text: string }).text).toContain('oar-antigravity')
    const activeDigest = (catalogMsg.source as { digest: string }).digest

    const history: FakeSessionEvent[] = [
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' } } },
      { seq: 2, type: 'user/message', data: { source: { kind: ROLE_CATALOG_SOURCE_KIND, form: 'catalog', digest: activeDigest } } },
    ]
    root.setVisibleEvents(history)
    expect(userTurnsSinceLastCatalogOrRefresh(root)).toBe(0)

    // Turn 2 (1 turn after catalog) and Turn 3 (2 turns after catalog) stay silent.
    const turn2 = await preStep(
      { agent: root, messages: [userPrompt('turn 2')], step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [userPrompt('turn 2')] }),
    )
    expect(turn2.messages).toHaveLength(1)
    history.push({ seq: 3, type: 'user/message', data: { source: { kind: 'user' } } })
    root.setVisibleEvents(history)

    const turn3 = await preStep(
      { agent: root, messages: [userPrompt('turn 3')], step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [userPrompt('turn 3')] }),
    )
    expect(turn3.messages).toHaveLength(1)
    history.push({ seq: 4, type: 'user/message', data: { source: { kind: 'user' } } })
    root.setVisibleEvents(history)
    expect(userTurnsSinceLastCatalogOrRefresh(root)).toBe(2)

    // Turn 4 (3rd user turn after catalog): emits one compact refresh notice with backend hint.
    const turn4 = await preStep(
      { agent: root, messages: [userPrompt('turn 4')], step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [userPrompt('turn 4')] }),
    )
    expect(turn4.messages).toHaveLength(2)
    const refreshMsg = turn4.messages[1] as UserMessage
    expect(refreshMsg.source).toMatchObject({ kind: ROLE_REFRESH_SOURCE_KIND, form: 'notice' })
    expect((refreshMsg.content[0] as { text: string }).text).toContain('oar-antigravity')

    // Mid-turn step 2 never emits another refresh.
    const turn4Step2 = await preStep(
      { agent: root, messages: [], step: 2, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(turn4Step2.messages).toHaveLength(0)

    // Once committed, Turn 5 resets the interval counter back to 0.
    history.push(
      { seq: 5, type: 'user/message', data: { source: { kind: 'user' } } },
      { seq: 6, type: 'user/message', data: { source: { kind: ROLE_REFRESH_SOURCE_KIND, form: 'notice' } } },
    )
    root.setVisibleEvents(history)
    expect(userTurnsSinceLastCatalogOrRefresh(root)).toBe(0)
    const turn5 = await preStep(
      { agent: root, messages: [userPrompt('turn 5')], step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [userPrompt('turn 5')] }),
    )
    expect(turn5.messages).toHaveLength(1)

    // Live config update disabling nudges (maxNudges: 0) takes effect immediately.
    config = resolveOrchestrationConfig({
      models: { 'general-purpose': { subagentProvider: 'oar-antigravity' }, plan: { provider: 'openai', model: 'gpt-5.4' } },
      reminders: { nudgeInspectionSteps: 1, maxNudges: 0, catalogRefreshTurns: 0 },
    }, {})
    const suppressed = await postExec(toolExec(root, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    expect(suppressed.additionalContexts).toBeUndefined()
  })

  it('tracks inline edits toward drift nudges only when a dedicated general-purpose backend is configured, leaving trivial 1-2 step edits silent', async () => {
    expect(isMutationTool('write')).toBe(true)
    expect(isMutationTool('edit')).toBe(true)
    expect(isMutationTool('apply_patch')).toBe(true)
    expect(isMutationTool('read')).toBe(false)

    // Without a dedicated general-purpose backend, direct edit steps do not trigger a nudge.
    const defaultTool = { name: ORCHESTRATION_TOOL_NAME } as ToolDefinition
    const defaultHost = makeHostContext(defaultTool)
    const defaultRoot = makeAgent('root-default', [{
      seq: 0,
      type: 'user/message',
      data: { source: { kind: ROLE_CATALOG_SOURCE_KIND, form: 'catalog', digest: ROLE_CATALOG_DIGEST } },
    }])
    installDelegationReminders(defaultHost.ctx, {
      tool: defaultTool,
      isEligibleRoot: () => true,
      nudgeInspectionSteps: 3,
    })
    const defaultPre = defaultHost.listeners.get('agent/pre-step')!
    const defaultPost = defaultHost.listeners.get('tools/post-execute')!
    await defaultPre({ agent: defaultRoot, messages: [userPrompt('fix bug')], step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [userPrompt('fix bug')] }))
    expect((await defaultPost(toolExec(defaultRoot, 'read'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()
    await defaultPre({ agent: defaultRoot, messages: [], step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    expect((await defaultPost(toolExec(defaultRoot, 'edit'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()
    await defaultPre({ agent: defaultRoot, messages: [], step: 3, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    expect((await defaultPost(toolExec(defaultRoot, 'write'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()

    // With a dedicated general-purpose backend, 1-2 step edits stay silent, while a 3rd step nudges.
    const dedicatedConfig = resolveOrchestrationConfig({
      models: { 'general-purpose': { subagentProvider: 'oar-codex' } },
      reminders: { nudgeInspectionSteps: 3, maxNudges: 2, catalogRefreshTurns: 3 },
    }, {})
    expect(formatRoleCatalogText(dedicatedConfig.models)).toContain('dedicated backend: oar-codex')
    expect(formatRoleCatalogText(dedicatedConfig.models)).toContain('Keep trivial tasks direct')

    const dedicatedTool = { name: ORCHESTRATION_TOOL_NAME } as ToolDefinition
    const dedicatedHost = makeHostContext(dedicatedTool)
    const dedicatedRoot = makeAgent('root-dedicated')
    installDelegationReminders(dedicatedHost.ctx, {
      tool: dedicatedTool,
      isEligibleRoot: () => true,
      getConfig: () => dedicatedConfig,
    })
    const preStep = dedicatedHost.listeners.get('agent/pre-step')!
    const postExec = dedicatedHost.listeners.get('tools/post-execute')!

    // Trivial 2-step read + edit: below threshold 3 -> zero nudges.
    await preStep({ agent: dedicatedRoot, messages: [userPrompt('fix typo')], step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [userPrompt('fix typo')] }))
    expect((await postExec(toolExec(dedicatedRoot, 'read'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()
    await preStep({ agent: dedicatedRoot, messages: [], step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    expect((await postExec(toolExec(dedicatedRoot, 'edit'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()

    // 3rd inline step crosses threshold -> nudges with dedicated backend details and implementation wording.
    await preStep({ agent: dedicatedRoot, messages: [], step: 3, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    const third = await postExec(toolExec(dedicatedRoot, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    expect(third.additionalContexts).toHaveLength(1)
    const text = ((third.additionalContexts![0] as UserMessage).content[0] as { text: string }).text
    expect(text).toContain('3 consecutive inline inspection/editing steps')
    expect(text).toContain('implementation/fix')
    expect(text).toContain('dedicated backend: oar-codex')
  })

  it('resets inline counters after read-only explore/plan delegation without suppressing subsequent execution nudges', async () => {
    const dedicatedConfig = resolveOrchestrationConfig({
      models: { 'general-purpose': { provider: 'openai', model: 'gpt-5.4' } },
      reminders: { nudgeInspectionSteps: 3, maxNudges: 2, catalogRefreshTurns: 3 },
    }, {})
    const tool = { name: ORCHESTRATION_TOOL_NAME } as ToolDefinition
    const { ctx, listeners } = makeHostContext(tool)
    const root = makeAgent('root-after-explore')
    installDelegationReminders(ctx, {
      tool,
      isEligibleRoot: () => true,
      getConfig: () => dedicatedConfig,
    })
    const preStep = listeners.get('agent/pre-step')!
    const postExec = listeners.get('tools/post-execute')!

    // Step 1: inspect, Step 2: delegate to read-only explore -> resets counter, does NOT suppress turn.
    await preStep({ agent: root, messages: [userPrompt('refactor auth')], step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [userPrompt('refactor auth')] }))
    await postExec(toolExec(root, 'grep'), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    await preStep({ agent: root, messages: [], step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    await postExec(toolExec(root, ORCHESTRATION_TOOL_NAME, { role: 'explore' }), { content: [], isError: false }, async () => ({ kind: 'accept' }))

    // Short 2-step follow-up (Steps 3-4) stays silent.
    await preStep({ agent: root, messages: [], step: 3, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    expect((await postExec(toolExec(root, 'read'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()
    await preStep({ agent: root, messages: [], step: 4, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    expect((await postExec(toolExec(root, 'edit'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()

    // Step 5 crosses threshold 3 -> fires nudge pointing to general-purpose (openai/gpt-5.4).
    await preStep({ agent: root, messages: [], step: 5, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    const fifth = await postExec(toolExec(root, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    expect(fifth.additionalContexts).toHaveLength(1)
    expect(((fifth.additionalContexts![0] as UserMessage).content[0] as { text: string }).text).toContain('dedicated backend: openai/gpt-5.4')

    // Once general-purpose is called, subsequent steps in the turn stay silent.
    await preStep({ agent: root, messages: [], step: 6, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    await postExec(toolExec(root, ORCHESTRATION_TOOL_NAME, { role: 'general-purpose' }), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    for (const step of [7, 8, 9]) {
      await preStep({ agent: root, messages: [], step, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
      expect((await postExec(toolExec(root, 'bash'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()
    }
  })

  it('treats general-purpose with readOnly: true as read-only so subsequent inline editing loops still nudge', async () => {
    const dedicatedConfig = resolveOrchestrationConfig({
      models: { 'general-purpose': { provider: 'openai', model: 'gpt-5.4' } },
      reminders: { nudgeInspectionSteps: 2, maxNudges: 2, catalogRefreshTurns: 0 },
    }, {})
    const tool = { name: ORCHESTRATION_TOOL_NAME } as ToolDefinition
    const { ctx, listeners } = makeHostContext(tool)
    const root = makeAgent('root-after-ro-gp')
    installDelegationReminders(ctx, {
      tool,
      isEligibleRoot: () => true,
      getConfig: () => dedicatedConfig,
    })
    const preStep = listeners.get('agent/pre-step')!
    const postExec = listeners.get('tools/post-execute')!

    await preStep({ agent: root, messages: [userPrompt('review then fix')], step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [userPrompt('review then fix')] }))
    await postExec(toolExec(root, ORCHESTRATION_TOOL_NAME, { role: 'general-purpose', readOnly: true }), { content: [], isError: false }, async () => ({ kind: 'accept' }))

    await preStep({ agent: root, messages: [], step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    expect((await postExec(toolExec(root, 'edit'), { content: [], isError: false }, async () => ({ kind: 'accept' }))).additionalContexts).toBeUndefined()

    await preStep({ agent: root, messages: [], step: 3, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    const nudged = await postExec(toolExec(root, 'edit'), { content: [], isError: false }, async () => ({ kind: 'accept' }))
    expect(nudged.additionalContexts).toHaveLength(1)
  })
})
