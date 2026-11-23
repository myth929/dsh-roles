// End-to-end runtime smoke test on a plain DSH composition (dsh-base + dsh-web-app + dsh-roles).
// Verifies: internal preset hiding across all 4 presets, bare subagent/subagent_fork/subagent_oar
// convergence, explore & plan read-only isolation without workspace instructions, per-role model
// routing, dsh-code-guide environment + package doc injection, Claude-aligned fork KV-cache fidelity +
// bash permission + nested delegation guard (live & cold resume), and two-stage step-budget convergence.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  createRuntimeResolution,
  initProfile,
  loadProfile,
  PluginPackages,
} from '@deepseek-ai/dsh-app-boot'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveOrchestrationConfig } from '../../lib/config.js'
import { listExternalSubagentProviders } from '../../lib/guide.js'

for (const key of [
  'DSH_ME_PROVIDER',
  'DSH_ME_MODEL',
  'DSH_ROLES_EXPLORE_PROVIDER',
  'DSH_ROLES_EXPLORE_MODEL',
  'DSH_ROLES_MODELS',
  'DSH_ROLES_BUDGETS',
]) {
  delete process.env[key]
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const data = mkdtempSync(join(tmpdir(), 'dsh-roles-smoke-'))
process.env.DSH_HOME = join(data, 'dsh')
process.env.DSH_SESSION_ROOT = join(data, 'sessions')
const hostDir = join(data, 'host')
mkdirSync(hostDir, { recursive: true })
const anchor = join(hostDir, 'package.json')
writeFileSync(anchor, JSON.stringify({
  name: 'dsh-smoke-host',
  private: true,
  dependencies: {
    '@deepseek-ai/dsh-base': '*',
    '@deepseek-ai/dsh-web-app': '*',
  },
}))
symlinkSync(join(packageRoot, 'node_modules'), join(hostDir, 'node_modules'), 'dir')

const directory = join(process.env.DSH_HOME, 'profiles', 'orchestration')
initProfile(directory, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-roles'])
mkdirSync(join(directory, 'node_modules'), { recursive: true })
symlinkSync(packageRoot, join(directory, 'node_modules', 'dsh-roles'), 'dir')

const profile = loadProfile('orchestration', 'orchestration', anchor)
const config = join(directory, 'cordis.yml')
writeFileSync(config, '[]\n')
writeFileSync(join(process.env.DSH_HOME, 'AGENTS.md'), 'FIXTURE_WORKSPACE_RULE: Read AGENTS.md before edits.\n')

// Omit Host-plane `tool-fs` / `tool-fs-search` so preset-scoped tool discovery is also exercised.
const patches = [
  { id: 'hmr', disabled: true },
  { id: 'web-startup', disabled: true },
  { id: 'session-title-llm', disabled: true },
  { id: 'session-telemetry-otel', disabled: true },
  { id: 'llm-deepseek', disabled: true },
  { id: 'llm-deepseek-account', disabled: true },
  { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: packageRoot } },
  { id: 'approval', config: { policy: 'never' } },
  { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
  { id: 'session-persistence-jsonl', config: { root: process.env.DSH_SESSION_ROOT } },
  ...['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-skill', 'skill-filesystem', 'agent-instructions']
    .map(id => ({ id, disabled: false })),
  { id: 'webserver', inject: [], config: { host: '127.0.0.1', port: 0 } },
  { id: 'web-runtime', inject: [], config: { printUrl: false, openBrowser: false, surfaceContext: true, trustedHosts: [] } },
  { id: 'connection', inject: ['webServer'], config: { trustedHosts: [] } },
  { id: 'agent-default-model', config: { provider: 'fixture-parent', model: 'parent-model' } },
  { id: 'agent-preset-registry', config: { default: 'standard' } },
  { id: 'dsh-roles', config: { models: { plan: 'fixture-plan/plan-model' } } },
]
writeFileSync(profile.patchPath, JSON.stringify(patches))
const resolution = await createRuntimeResolution({ installAnchor: anchor, profile })

const rootRequests = []
const exploreRequests = []
const planRequests = []
const guideRequests = []
const forkRequests = []
const resumedForkRequests = []
const budgetRequests = []
let exploreToolNames
let planToolNames
let guideToolNames
let forkToolNames
let budgetStepTools

function collectUserText(messages) {
  return messages
    .filter(message => message.role === 'user')
    .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
    .join('\n')
}

function textResponse(text) {
  return [
    { type: 'block-start', blockType: 'text', index: 0 },
    { type: 'text-delta', text, index: 0 },
    { type: 'block-end', block: { type: 'text', text }, index: 0 },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(name, args) {
  return [
    { type: 'block-start', blockType: 'tool-call', index: 0 },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${randomUUID()}`, name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class PlanAdapter extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'plan-model', name: 'plan-model' }] }
  async resolveModel(provider, model) { return { provider, id: model, name: model, input: ['text'], context: { contextWindow: 32768 } } }
  async *stream(options) {
    planRequests.push(options)
    planToolNames = (options.tools ?? []).map(tool => tool.name).sort()
    assert.equal(options.model, 'plan-model', 'plan child must receive configured plan-model')
    for (const chunk of textResponse('Plan summary.\n\n### Critical Files for Implementation\n- src/index.ts:1-40')) {
      yield chunk
    }
  }
}

class ParentAdapter extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'parent-model', name: 'parent-model' }] }
  async resolveModel(provider, model) { return { provider, id: model, name: model, input: ['text'], context: { contextWindow: 32768 } } }
  async *stream(options) {
    const userText = collectUserText(options.messages)
    const serialized = JSON.stringify(options.messages)

    if (userText.includes('Resume and try nested delegation')) {
      resumedForkRequests.push(options)
      if (resumedForkRequests.length === 1) {
        for (const chunk of toolCallResponse('orchestrate_subagent', { role: 'fork', description: 'nested fork', prompt: 'try fork' })) {
          yield chunk
        }
        return
      }
      assert(serialized.includes('Fork is not available'), 'cold-resumed fork must still block nested fork')
      for (const chunk of textResponse('Resumed fork stayed guarded.')) yield chunk
      return
    }

    if (userText.includes('You are a forked subagent')) {
      forkRequests.push(options)
      if (forkRequests.length === 1) {
        forkToolNames = (options.tools ?? []).map(tool => tool.name).sort()
        for (const chunk of toolCallResponse('bash', { command: 'echo fork-bash-ok' })) yield chunk
        return
      }
      if (forkRequests.length === 2) {
        assert(serialized.includes('fork-bash-ok'), 'fork must be allowed to execute bash commands')
        for (const chunk of toolCallResponse('orchestrate_subagent', { role: 'explore', description: 'nested explore', prompt: 'find x' })) {
          yield chunk
        }
        return
      }
      assert(serialized.includes('Subagent nesting limit reached'), 'fork at depth 1 must block nested orchestrate_subagent')
      for (const chunk of textResponse('Fork verified bash execution and blocked nesting.')) yield chunk
      return
    }

    if (userText.includes('You are the DeepSeek Harness (DSH) and Cordis documentation')) {
      guideRequests.push(options)
      guideToolNames = (options.tools ?? []).map(tool => tool.name).sort()
      assert(userText.includes('# Current DSH Environment'), 'dsh-code-guide must receive # Current DSH Environment')
      assert(userText.includes('@deepseek-ai/dsh-subagent'), 'dsh-code-guide must receive installed @deepseek-ai package paths')
      for (const chunk of textResponse('DSH uses @deepseek-ai/dsh-subagent for delegation.')) yield chunk
      return
    }

    if (userText.includes('Run a budgeted search')) {
      budgetRequests.push(options)
      if (budgetRequests.length < 4) {
        for (const chunk of toolCallResponse('glob', { pattern: 'package.json', path: '.' })) yield chunk
        return
      }
      budgetStepTools = (options.tools ?? []).map(tool => tool.name)
      assert(userText.includes('<orchestration-budget step="4">'), 'final budget step must inject convergence notice')
      for (const chunk of textResponse('Summary: converged cleanly on step 4.\nKey Files: package.json:1-5')) yield chunk
      return
    }

    if (userText.includes('You are a read-only exploration subagent')) {
      exploreRequests.push(options)
      exploreToolNames = (options.tools ?? []).map(tool => tool.name).sort()
      for (const chunk of textResponse('Summary: parser lives in src/parser.ts.\nKey Files: src/parser.ts:10-40')) yield chunk
      return
    }

    const lastMessage = options.messages.at(-1)
    const prevMessage = options.messages.at(-2)
    if (lastMessage?.role === 'user' && lastMessage.source?.kind === 'subagent-settled' && prevMessage?.role !== 'tool') {
      for (const chunk of textResponse('acknowledged-settled-child')) yield chunk
      return
    }

    rootRequests.push(options)
    if (rootRequests.length === 1) {
      for (const chunk of toolCallResponse('orchestrate_subagent', {
        role: 'explore',
        thoroughness: 'quick',
        description: 'locate parser',
        prompt: 'Locate the parser entry point across the repository.',
      })) yield chunk
      return
    }
    if (rootRequests.length === 2) {
      assert(serialized.includes('Key Files: src/parser.ts:10-40'), 'the parent must receive the child result in the same step')
      for (const chunk of textResponse('explore-fixture-ok')) yield chunk
      return
    }
    if (rootRequests.length === 3) {
      for (const chunk of toolCallResponse('orchestrate_subagent', {
        role: 'plan',
        thoroughness: 'quick',
        description: 'plan refactor',
        prompt: 'Design a minimal refactor plan.',
      })) yield chunk
      return
    }
    if (rootRequests.length === 4) {
      assert(serialized.includes('### Critical Files for Implementation'), 'parent must receive plan output')
      for (const chunk of textResponse('plan-fixture-ok')) yield chunk
      return
    }
    if (rootRequests.length === 5) {
      for (const chunk of toolCallResponse('orchestrate_subagent', {
        role: 'dsh-code-guide',
        thoroughness: 'quick',
        description: 'query dsh subagent docs',
        prompt: 'How does dsh-subagent work?',
      })) yield chunk
      return
    }
    if (rootRequests.length === 6) {
      assert(serialized.includes('DSH uses @deepseek-ai/dsh-subagent'), 'parent must receive dsh-code-guide output')
      for (const chunk of textResponse('guide-fixture-ok')) yield chunk
      return
    }
    if (rootRequests.length === 7) {
      for (const chunk of toolCallResponse('orchestrate_subagent', {
        role: 'fork',
        thoroughness: 'quick',
        description: 'forked audit',
        prompt: 'Audit the completed exploration and run a shell check.',
      })) yield chunk
      return
    }
    if (rootRequests.length === 8) {
      assert(serialized.includes('Fork verified bash execution and blocked nesting.'), 'fork result must return to the parent')
      for (const chunk of textResponse('fork-fixture-ok')) yield chunk
      return
    }
    if (rootRequests.length === 9) {
      for (const chunk of toolCallResponse('orchestrate_subagent', {
        role: 'explore',
        thoroughness: 'quick',
        description: 'budgeted search',
        prompt: 'Run a budgeted search to test step convergence.',
      })) yield chunk
      return
    }
    if (rootRequests.length === 10) {
      assert(serialized.includes('Summary: converged cleanly on step 4.'), 'parent must receive converged step-budget output')
      for (const chunk of textResponse('budget-convergence-ok')) yield chunk
      return
    }
    if (rootRequests.length === 11) {
      for (const chunk of toolCallResponse('orchestrate_subagent', {
        role: 'explore',
        thoroughness: 'quick',
        description: 'oar live route',
        prompt: 'Route explore through the live OAR subagent provider.',
      })) yield chunk
      return
    }
    assert(serialized.includes('Summary: routed via live oar-codex.'), 'parent must receive live OAR provider output')
    for (const chunk of textResponse('live-oar-ok')) yield chunk
  }
}

async function runTurn(agent, text) {
  const before = agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: randomUUID() },
  }))
  const deadline = Date.now() + 15000
  while (
    agent.status !== 'idle'
    || agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length <= before
  ) {
    if (Date.now() > deadline) throw new Error('fixture agent did not finish turn')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function idle(agent) {
  const deadline = Date.now() + 15000
  while (agent.status !== 'idle') {
    if (Date.now() > deadline) throw new Error('fixture agent did not become idle')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

let ctx
const agents = []
const ends = []
try {
  ctx = await boot('orchestration', config, [...profile.layers.flatMap(layer => layer.patches), ...patches], async host => {
    host.provide('profileContext', {
      name: 'orchestration',
      dir: directory,
      patchPath: profile.patchPath,
      installAnchor: anchor,
      cwd: packageRoot,
      home: process.env.DSH_HOME,
      startedBundles: profile.layers.map(layer => layer.packageName),
      overlays: [],
    })
    await host.plugin(PluginPackages, { resolution })
  })
  await ctx.get('loader')?.await?.()

  // Verify browser client bundle composition and suppressed auto-generated settings form.
  const clientEntries = ctx.clientModules?.graph?.().entries ?? []
  assert(clientEntries.some(entry => entry.id === 'dsh-roles'), 'clientModules graph must include dsh-roles')
  const orchestrationSettings = ctx.settings?.describe?.().find(entry => entry.ns === 'dsh-roles')
  assert(orchestrationSettings !== undefined, 'dsh-settings must expose volatile dsh-roles descriptor')
  assert.equal(orchestrationSettings.autoGenerate, false, 'dsh-roles must suppress auto-generated form')

  // Register a fixture external OAR provider (`oar-codex`) and confirm discovery.
  let oarCalls = 0
  ctx.subagents.registerProvider({
    name: 'oar-codex',
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: false,
    start: async () => {
      oarCalls += 1
      return {
        id: `oar-codex-${randomUUID()}`,
        result: Promise.resolve({
          output: [{ type: 'text', text: 'Summary: routed via live oar-codex.\nKey Files: src/oar.ts:1-10' }],
          stopReason: 'completed',
        }),
        dispose: async () => {},
      }
    },
  })
  const discoveredExternal = listExternalSubagentProviders(ctx, resolveOrchestrationConfig({}))
  assert(
    discoveredExternal.some(provider => provider.id === 'oar-codex' && provider.isOar === true),
    'external provider discovery must include oar-codex',
  )

  // Register a dummy bare `subagent_oar` tool to prove bare-tool convergence covers all three bare tools.
  ctx.tools.register(defineTool({
    name: 'subagent_oar',
    description: 'Dummy bare OAR tool for convergence smoke testing.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'no',
  }))

  const roster = await ctx.agentPresets.list()
  for (const id of [
    'dsh-roles-explore',
    'dsh-roles-plan',
    'dsh-roles-general-purpose',
    'dsh-roles-guide',
  ]) {
    assert(!roster.some(row => row.id === id), `${id} must stay hidden from the mode selector`)
    const resolved = await ctx.agentPresets.resolve(id)
    assert.equal(resolved.broken, undefined, `${id} must mount without diagnostics`)
  }

  ctx.llm.registerAdapter(['fixture-parent'], new ParentAdapter())
  ctx.llm.registerAdapter(['fixture-plan'], new PlanAdapter())
  ctx.on('subagent/end', info => { ends.push(info) })

  const parent = await ctx.agents.create({
    sessionId: randomUUID(),
    meta: { cwd: packageRoot, agentPreset: 'standard' },
    agentOptions: { provider: 'fixture-parent', model: 'parent-model' },
    setup: async scope => { await scope.get('agentPresets').mount(scope, 'standard') },
  })
  agents.push(parent)

  // 1. Explore role
  parent.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Find the parser entry point.' }],
    source: { kind: 'user', rpcId: randomUUID() },
  }))
  await idle(parent.agent)

  assert.equal(rootRequests.length, 2, 'the caller-delivered result must not require an extra notification turn')
  const rootTools = (rootRequests[0].tools ?? []).map(tool => tool.name)
  assert(rootTools.includes('orchestrate_subagent'), 'root must expose the single orchestration entry')
  assert(!rootTools.includes('subagent') && !rootTools.includes('subagent_fork') && !rootTools.includes('subagent_oar'), 'root must converge all bare delegation entries')
  const rootSystem = rootRequests[0].messages.find(message => message.role === 'system')
  assert(JSON.stringify(rootSystem).includes('Delegation policy'), 'root must receive the scheduling policy')
  const rootInitialCatalogs = rootRequests[0].messages.filter(message => message.source?.kind === 'dsh-roles/catalog')
  assert.equal(rootInitialCatalogs.length, 1, 'root must receive the role catalog once at the user-message tail')
  assert.equal(rootInitialCatalogs[0].source?.form, 'catalog', 'role catalog must carry native DSH catalog form')

  assert.equal(exploreRequests.length, 1, 'exactly one exploration child request')
  assert.deepEqual(exploreToolNames, ['glob', 'grep', 'read'], 'exploration child must see only read-only file tools')
  const exploreSystem = exploreRequests[0].messages.find(message => message.role === 'system')
  assert(!JSON.stringify(exploreSystem).includes('Delegation policy'), 'child must not receive the root scheduling policy')
  const exploreInjected = exploreRequests[0].messages.filter(message => [
    'agent-instructions',
    'skill-catalog',
    'skill-invocation',
    'dsh-roles/catalog',
    'dsh-roles/refresh',
    'dsh-roles/nudge',
  ].includes(message.source?.kind))
  assert.equal(exploreInjected.length, 0, 'exploration child must not receive workspace instructions, skill catalogs, or orchestration reminders')
  assert(ends.length === 1 && ends[0].stopReason === 'completed', 'subagent/end must settle once as completed')

  const events = parent.agent.session.snapshotEvents()
  const result = events.find(event => event.type === 'tool/result' && event.data.message.content.some(block => block.type === 'text' && block.text.includes('Key Files')))
  assert(result !== undefined, 'the tool result must carry the Key Files coordinates')
  assert(!result.data.message.isError, 'a completed child must not be marked as an error')

  // 2. Plan role + per-role model routing
  parent.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Plan the refactor.' }],
    source: { kind: 'user', rpcId: randomUUID() },
  }))
  await idle(parent.agent)
  assert.equal(planRequests.length, 1, 'plan child must route through fixture-plan adapter')
  assert.deepEqual(planToolNames, ['glob', 'grep', 'read'], 'plan child must see only read-only file tools')
  const planInjected = planRequests[0].messages.filter(message => ['agent-instructions', 'skill-catalog', 'skill-invocation'].includes(message.source?.kind))
  assert.equal(planInjected.length, 0, 'plan child must not receive workspace instructions or skill catalogs')

  // 3. dsh-code-guide role
  parent.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Explain dsh-subagent.' }],
    source: { kind: 'user', rpcId: randomUUID() },
  }))
  await idle(parent.agent)
  assert.equal(guideRequests.length, 1, 'guide child must run once')
  const allowedGuideTools = new Set(['read', 'glob', 'grep', 'web_fetch', 'web_search', 'cordis_inspect_list', 'cordis_inspect_query'])
  for (const name of guideToolNames) assert(allowedGuideTools.has(name), `guide tool ${name} must stay in read-only guide subset`)
  for (const required of ['glob', 'grep', 'read']) assert(guideToolNames.includes(required), `guide must expose ${required}`)
  assert(!guideToolNames.includes('bash') && !guideToolNames.includes('write'), 'guide must not expose bash or write')
  const guideInjected = guideRequests[0].messages.filter(message => ['agent-instructions', 'skill-catalog', 'skill-invocation'].includes(message.source?.kind))
  assert.equal(guideInjected.length, 0, 'dsh-code-guide must not receive workspace instructions or skill catalogs')

  // 4. Fork role (KV-cache identity + bash permission + nested delegation guard)
  parent.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Fork and verify.' }],
    source: { kind: 'user', rpcId: randomUUID() },
  }))
  await idle(parent.agent)
  assert.equal(rootRequests.length, 8, 'the fork result must return in its own tool step')
  const laterCatalogs = rootRequests[rootRequests.length - 1].messages.filter(message => message.source?.kind === 'dsh-roles/catalog')
  assert.equal(laterCatalogs.length, 1, 'role catalog must not duplicate across later turns while visible on the session surface')
  assert.equal(forkRequests.length, 3, 'fork must execute bash once, fail nested orchestrate_subagent once, then finish')
  assert.deepEqual(forkRequests[0].messages[0], rootRequests[0].messages[0], 'fork must preserve node 0 system prompt byte-for-byte for KV-cache fidelity')
  assert.deepEqual(forkToolNames, [...rootTools].sort(), 'fork must keep the parent tool declaration list for KV-cache fidelity')
  assert(forkToolNames.includes('bash'), 'fork keeps parent bash and write tools available')
  assert(JSON.stringify(forkRequests[0].messages).includes('Find the parser entry point.'), 'fork must inherit completed parent turns')

  // Cold-resume the settled fork child via sendMessage and confirm nested delegation guard persists.
  const forkChildId = ends[3]?.id
  assert(forkChildId !== undefined, 'fork childId must be recorded')
  await ctx.sessionPersistence?.flush?.()
  assert.equal(ctx.agents.get(forkChildId), undefined, 'settled fork agent must be disposed before cold resume')
  await ctx.subagents.sendMessage(parent.agent, forkChildId, [{ type: 'text', text: 'Resume and try nested delegation' }], {
    signal: new AbortController().signal,
  })
  const resumedAgent = ctx.agents.get(forkChildId)
  assert(resumedAgent !== undefined, 'cold-resumed fork agent must exist')
  await idle(resumedAgent)
  assert.equal(resumedForkRequests.length, 2, 'cold-resumed fork must deny nested fork once, then answer')

  // 5. Exercise real ReactLoopAgent step-budget convergence where step 4 renders zero tools.
  parent.agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Run the budgeted search check.' }],
    source: { kind: 'user', rpcId: randomUUID() },
  }))
  await idle(parent.agent)
  assert.equal(budgetRequests.length, 4, 'budgeted quick explore must finish cleanly at step 4')
  assert.deepEqual(budgetStepTools, [], 'step 4 convergence step must declare zero tools before model execution')

  // 6. Mutate volatile config live to route `explore` to `oar-codex` without restarting.
  await ctx.settings.mutate('dsh-roles', [{
    op: 'set',
    path: ['models'],
    value: {
      plan: 'fixture-plan/plan-model',
      explore: { subagentProvider: 'oar-codex' },
    },
  }])
  await runTurn(parent.agent, 'Run live OAR explore check.')
  assert.equal(oarCalls, 1, 'live settings mutation must route explore to oar-codex without restart')
  const catalogSnapshot = ctx.get('sessionProjections').snapshot(parent.agent.session, ['subagentCatalog'])
  const externalCatalogEntries = (catalogSnapshot.values.subagentCatalog ?? []).filter(entry => entry.mode === 'external')
  assert.equal(externalCatalogEntries.length, 1, 'caller-delivered external OAR run must appear in parent subagentCatalog projection for Web UI visibility')
  assert(externalCatalogEntries[0]?.label?.includes('[exp · oar-codex]'), 'external catalog entry label must identify role and provider')

  console.log(JSON.stringify({
    status: 'PASS',
    internalPresetsHidden: true,
    bareDelegationConverged: true,
    clientBundleComposed: true,
    settingsDescriptorMounted: true,
    oarProviderDiscovered: true,
    liveSettingsOarRouting: true,
    externalOarCatalogVisible: true,
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
  }))
} finally {
  for (const agent of agents) await agent.dispose().catch(() => {})
  await ctx?.fiber.dispose().catch(() => {})
  rmSync(data, { recursive: true, force: true })
}
