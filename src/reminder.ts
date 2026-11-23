/**
 * Native DSH delegation reminders:
 * 1. Role catalog injected in `agent/pre-step` with `agent.session.surface.nodes`
 *    visibility deduplication (mirroring `@deepseek-ai/dsh-tool-skill` and
 *    Claude Code's `agent_listing_delta`), plus periodic compact refreshes every
 *    N user turns so long sessions do not lose recency attention.
 * 2. Advisory mid-turn delegation nudge attached via `tools/post-execute`
 *    `additionalContexts` after consecutive direct inspection steps without
 *    delegating (mirroring `@deepseek-ai/dsh-repeat-tool-reminder`).
 * @module dsh-roles/reminder
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { CONFIGURABLE_MODEL_ROLES, DEFAULT_REMINDERS } from './config.js'
import type { ResolvedConfig, ResolvedModels } from './config.js'
import { describeConfiguredRoute } from './roles.js'
import { ORCHESTRATION_TOOL_NAME } from './tool.js'

/** Durable message source kind for the role catalog injected at the user-message tail. */
export const ROLE_CATALOG_SOURCE_KIND = 'dsh-roles/catalog' as const
/** Durable message source kind for compact periodic tail refreshes in long sessions. */
export const ROLE_REFRESH_SOURCE_KIND = 'dsh-roles/refresh' as const
/** Durable message source kind for the mid-turn inspection-drift delegation nudge. */
export const DELEGATION_NUDGE_SOURCE_KIND = 'dsh-roles/nudge' as const

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-roles/catalog': {
      kind: 'dsh-roles/catalog'
      readonly digest: string
    } & ContextFormed
    'dsh-roles/refresh': {
      kind: 'dsh-roles/refresh'
    } & ContextFormed
    'dsh-roles/nudge': {
      kind: 'dsh-roles/nudge'
    } & ContextFormed
  }
}

/** Direct built-in inspection tools whose sustained inline loop signals a delegation candidate. */
export const INSPECTION_TOOL_NAMES = new Set(['bash', 'pwsh', 'read', 'glob', 'grep', 'web_search', 'web_fetch'])

/** Direct built-in file-editing tools tracked toward drift nudges when a dedicated `general-purpose` backend is configured. */
export const MUTATION_TOOL_NAMES = new Set(['write', 'edit', 'apply_patch'])

/** Read-only orchestration roles whose completion resets inline counters without suppressing later execution nudges. */
const READ_ONLY_ROLES = new Set(['explore', 'plan', 'dsh-code-guide'])

/** Whether a tool call counts as direct inline inspection/probing for mid-turn drift detection. */
export function isInspectionTool(name: string): boolean {
  return INSPECTION_TOOL_NAMES.has(name) || name.startsWith('mcp__')
}

/** Whether a tool call directly edits workspace files. */
export function isMutationTool(name: string): boolean {
  return MUTATION_TOOL_NAMES.has(name)
}

/** Default number of consecutive direct inspection steps in one turn before a nudge fires. */
export const DEFAULT_NUDGE_INSPECTION_STEPS = DEFAULT_REMINDERS.nudgeInspectionSteps

/** Default cap on repeated nudges in one turn (a long inline loop is re-prompted, not nagged forever). */
export const DEFAULT_MAX_DELEGATION_NUDGES = DEFAULT_REMINDERS.maxNudges

/** Default user-turn interval between compact tail refreshes while the catalog remains visible. */
export const DEFAULT_CATALOG_REFRESH_TURNS = DEFAULT_REMINDERS.catalogRefreshTurns

/**
 * Summarize any explicitly routed specialized subagent backends so the root model
 * knows when a role runs on a dedicated model or external OAR worker.
 */
export function formatDedicatedBackendHint(models?: ResolvedModels): string | undefined {
  if (models === undefined) return undefined
  const entries: string[] = []
  for (const role of CONFIGURABLE_MODEL_ROLES) {
    const label = describeConfiguredRoute(models[role])
    if (label !== undefined) entries.push(`\`${role}\` (${label})`)
  }
  if (entries.length === 0) return undefined
  const gpRoute = describeConfiguredRoute(models['general-purpose'])
  if (gpRoute !== undefined) {
    return `Dedicated subagent backends are configured for ${entries.join(', ')} — route substantive coding, bug fixes, refactors, reviews, and multi-step debugging to \`general-purpose\` instead of doing them inline, while keeping truly trivial tasks (plain Q&A, 1–2 known files, typo/constant tweaks, single deterministic commands) direct.`
  }
  return `Dedicated subagent backends are configured for ${entries.join(', ')} — prefer offloading non-trivial matching tasks to these specialized workers instead of grinding inline, while keeping truly trivial lookups direct.`
}

/** Render the full role catalog wrapped in `<system-reminder>` for the user-message tail. */
export function formatRoleCatalogText(models?: ResolvedModels): string {
  const gpRoute = describeConfiguredRoute(models?.['general-purpose'])
  const backendHint = formatDedicatedBackendHint(models)
  const codingRule = gpRoute !== undefined
    ? `- Feature implementation, bug fixes, refactors, or changes requiring tests/verification → \`orchestrate_subagent(role="general-purpose")\` (dedicated backend: ${gpRoute})`
    : '- Multi-file implementation, refactors, or bug fixes requiring reproduction/tests → `orchestrate_subagent(role="general-purpose")`'
  return [
    '<system-reminder>',
    `Before starting a multi-step tool loop, check whether this task belongs in \`${ORCHESTRATION_TOOL_NAME}\`:`,
    codingRule,
    '- Code review or branch/commit diff analysis touching >1 file (or a large cross-module change) → `orchestrate_subagent(role="general-purpose")`',
    '- Error, log, or monitoring troubleshooting that needs correlating logs with code or git history → `orchestrate_subagent(role="general-purpose", includeMcp=true)` (or `role="fork"` if prior turns matter)',
    '- Unfamiliar codebase search (>2 queries or unknown directories) → `orchestrate_subagent(role="explore")`',
    '- Unfamiliar CLI/environment/config debugging → `orchestrate_subagent(role="general-purpose")`',
    '- Multi-file architecture planning → `orchestrate_subagent(role="plan")`; DSH/Cordis docs or config → `orchestrate_subagent(role="dsh-code-guide")`',
    '',
    'Available roles:',
    '- `general-purpose` (default): Fresh worker with shell/file tools (`read`, `write`, `edit`, `glob`, `grep`, `bash`, plus MCP when `includeMcp: true`). Supports `readOnly: true` for parallel read-only reviews/investigations, disjoint `writeScope` prefixes for light parallel edits, and `isolation: "worktree"` for isolated Git branch parallel edits.',
    '- `explore`: Fast read-only codebase search (`read`, `glob`, `grep`) returning `Key Files` coordinates; do not use for code review.',
    '- `plan`: Read-only architect (`read`, `glob`, `grep`) returning a step-by-step plan and `Critical Files for Implementation`.',
    '- `fork`: Shares prior completed turns and prompt cache on the parent model (no nested delegation); keeps raw intermediate tool output out of this context.',
    '- `dsh-code-guide`: Read-only DSH/Cordis documentation and configuration specialist (`read`, `glob`, `grep`, `web_fetch`, `web_search`, Cordis inspect).',
    ...(backendHint === undefined ? [] : ['', backendHint]),
    '',
    'Keep trivial tasks direct (even with dedicated backends): plain Q&A, reading 1–2 known files, an obvious localized edit (typo/constant/copy or 1–2 known lines with no debugging/test loop), or a single deterministic command (like `git status`).',
    '</system-reminder>',
  ].join('\n')
}

/** Stable 16-hex digest for deduplicating a rendered catalog message. */
export function catalogDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** Default compact role catalog rendered when no custom role routes are configured. */
export const ROLE_CATALOG_TEXT = formatRoleCatalogText()

/** Stable content digest for the default role catalog. */
export const ROLE_CATALOG_DIGEST = catalogDigest(ROLE_CATALOG_TEXT)

/** Render a compact periodic refresh reminder for long multi-turn conversations. */
export function formatRoleRefreshText(models?: ResolvedModels): string {
  const gpRoute = describeConfiguredRoute(models?.['general-purpose'])
  const backendHint = formatDedicatedBackendHint(models)
  const gpSummary = gpRoute !== undefined
    ? `- Substantive coding/fixes/tests, >1-file review/diff, bug/log/monitoring troubleshooting, or CLI/env debugging → \`general-purpose\` (${gpRoute}; set \`includeMcp: true\` if MCP tools are needed)`
    : '- Multi-file edits/fixes with tests, >1-file review/diff, bug/log/monitoring troubleshooting, or CLI/env debugging → `general-purpose` (set `includeMcp: true` if MCP tools are needed)'
  return [
    '<system-reminder>',
    `Reminder — \`${ORCHESTRATION_TOOL_NAME}\` is available for non-trivial work in this turn:`,
    gpSummary,
    '- Broad codebase search (>2 queries) → `explore`; multi-file design → `plan`; context-heavy follow-up → `fork`; DSH/Cordis → `dsh-code-guide`',
    ...(backendHint === undefined ? [] : [backendHint]),
    'Keep trivial tasks direct: plain Q&A, 1–2 known files, obvious 1–2 line edits (typo/constant/copy), or single deterministic commands.',
    '</system-reminder>',
  ].join('\n')
}

/** Build the durable catalog message carrying DSH's native `form: 'catalog'` source metadata. */
export function createRoleCatalogMessage(models?: ResolvedModels): UserMessage {
  const text = formatRoleCatalogText(models)
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: ROLE_CATALOG_SOURCE_KIND,
      form: 'catalog',
      digest: catalogDigest(text),
    },
  })
}

/** Build a compact periodic refresh message carrying DSH's native `form: 'notice'` metadata. */
export function createRoleRefreshMessage(models?: ResolvedModels): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: formatRoleRefreshText(models) }],
    source: {
      kind: ROLE_REFRESH_SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary('orchestrate_subagent role reminder'),
    },
  })
}

/** Optional context tailoring mid-turn nudge wording to configured execution backends. */
export interface DelegationNudgeOptions {
  readonly dedicatedGeneralPurposeRoute?: string
  readonly includesMutation?: boolean
}

/** Build the mid-turn nudge text after sustained inline inspection/editing steps. */
export function delegationNudgeText(
  inspectionSteps: number,
  occurrence: number = 1,
  maxNudges: number = DEFAULT_MAX_DELEGATION_NUDGES,
  options?: DelegationNudgeOptions,
): string {
  const stepLabel = options?.includesMutation === true
    ? `${inspectionSteps} consecutive inline inspection/editing steps`
    : `${inspectionSteps} consecutive inspection steps`
  const backendNote = options?.dedicatedGeneralPurposeRoute === undefined
    ? ''
    : ` (dedicated backend: ${options.dedicatedGeneralPurposeRoute})`
  if (occurrence <= 1) {
    return [
      '<system-reminder>',
      `You have spent ${stepLabel} inline without calling \`${ORCHESTRATION_TOOL_NAME}\`.`,
      `Unless this is a small known scope finishing in the very next step, offload the remaining implementation/fix, review (>1 file), error/log/MCP investigation, CLI/environment debugging, or codebase search now${backendNote}:`,
      `\`${ORCHESTRATION_TOOL_NAME}({ role: "general-purpose", description: "<3-5 word summary>", prompt: "<findings/changes so far, target paths, and remaining task>" })\``,
      '(Add `includeMcp: true` if MCP queries are needed, or use `role: "explore"` for read-only code search / `role: "fork"` if prior turns matter. Ignore only if you are finishing in 1 step.)',
      '</system-reminder>',
    ].join('\n')
  }
  return [
    '<system-reminder>',
    `Delegation reminder ${occurrence}/${maxNudges}: you have now spent ${stepLabel} inline without calling \`${ORCHESTRATION_TOOL_NAME}\`.`,
    `Stop grinding through another step inline. Package what you found or changed so far plus the remaining task and call${backendNote}:`,
    `\`${ORCHESTRATION_TOOL_NAME}({ role: "general-purpose", description: "<3-5 word summary>", prompt: "<findings/changes so far, target paths, and exact task to finish>" })\``,
    '(Add `includeMcp: true` if MCP tools are required, or use `role: "explore"` for pure read-only code search / `role: "fork"` when prior conversation history matters.)',
    '</system-reminder>',
  ].join('\n')
}

/** Build the advisory nudge message carrying DSH's native `form: 'notice'` source metadata. */
export function createDelegationNudgeMessage(
  inspectionSteps: number,
  occurrence: number = 1,
  maxNudges: number = DEFAULT_MAX_DELEGATION_NUDGES,
  options?: DelegationNudgeOptions,
): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: delegationNudgeText(inspectionSteps, occurrence, maxNudges, options) }],
    source: {
      kind: DELEGATION_NUDGE_SOURCE_KIND,
      form: 'notice',
      summary: boundContextSummary(`delegation reminder ${occurrence}/${maxNudges} after ${inspectionSteps} inline steps`),
    },
  })
}

/**
 * Check whether the current visible session surface already holds the active
 * role catalog (so repeated turns stay silent and post-compaction steps re-emit).
 * @param agent - preparing agent.
 * @param digest - expected catalog digest.
 * @returns true when an identical catalog message is still visible in `surface.nodes`.
 */
export function hasVisibleRoleCatalog(agent: Agent, digest: string = ROLE_CATALOG_DIGEST): boolean {
  const nodes = agent.session.surface?.nodes
  if (nodes === undefined || typeof agent.session.eventAt !== 'function') return false
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const seq = nodes[index]
    if (seq === undefined) continue
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const source = event.data.source as { kind?: unknown; digest?: unknown }
    if (source.kind === ROLE_CATALOG_SOURCE_KIND && source.digest === digest) return true
  }
  return false
}

/**
 * Count committed user-input messages (`source.kind === 'user'`) that appear
 * after the most recent visible role catalog or periodic refresh in `surface.nodes`.
 * Purely derived from the session surface so restarts and cold resumes stay consistent.
 */
export function userTurnsSinceLastCatalogOrRefresh(agent: Agent): number {
  const nodes = agent.session.surface?.nodes
  if (nodes === undefined || typeof agent.session.eventAt !== 'function') return 0
  let userTurns = 0
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const seq = nodes[index]
    if (seq === undefined) continue
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const kind = (event.data.source as { kind?: unknown }).kind
    if (kind === ROLE_CATALOG_SOURCE_KIND || kind === ROLE_REFRESH_SOURCE_KIND) break
    if (kind === 'user') userTurns += 1
  }
  return userTurns
}

function hasPendingRoleCatalog(messages: readonly UserMessage[], digest: string): boolean {
  return messages.some((message) => {
    const source = message.source as { kind?: unknown; digest?: unknown }
    return source.kind === ROLE_CATALOG_SOURCE_KIND && source.digest === digest
  })
}

function hasPendingRoleRefresh(messages: readonly UserMessage[]): boolean {
  return messages.some(message => (message.source as { kind?: unknown }).kind === ROLE_REFRESH_SOURCE_KIND)
}

interface TurnInspectionState {
  currentStep: number
  lastCountedStep: number
  inspectionSteps: number
  sawMutation: boolean
  delegated: boolean
  nudges: number
  nextNudgeAt: number
}

export interface DelegationReminderOptions {
  /** Exact registered `orchestrate_subagent` tool definition for visibility verification. */
  readonly tool: ToolDefinition
  /** Whether the agent is an eligible native root (never a managed child or Relay). */
  isEligibleRoot(agent: Agent): boolean
  /** Live configuration accessor supplying current role routes and reminder thresholds. */
  readonly getConfig?: () => ResolvedConfig
  /** Override for consecutive direct inspection steps between nudges (default 3). */
  readonly nudgeInspectionSteps?: number
  /** Override for max repeated nudges in one turn (default 3; 0 disables mid-turn nudges). */
  readonly maxNudges?: number
  /** Override for user-turn interval between compact tail refreshes (default 3; 0 disables refresh). */
  readonly catalogRefreshTurns?: number
}

function prependContext(ours: UserMessage, theirs: readonly UserMessage[] | undefined): UserMessage[] {
  return [ours, ...(theirs ?? [])]
}

/**
 * Install native DSH delegation reminders on the host plugin context:
 * - `agent/pre-step`: tail-injects the role catalog when absent from the visible
 *   surface, emits a compact periodic refresh every N user turns in long sessions,
 *   and resets per-turn inspection tracking on fresh user input.
 * - `tools/post-execute`: counts distinct inspection steps (including `mcp__*`
 *   and web lookups) in the current turn and attaches an `additionalContexts`
 *   nudge at every threshold crossing, up to `maxNudges` per turn.
 * @param ctx - host context owning the tool registration.
 * @param options - visibility check, exact tool definition, live config, and optional overrides.
 * @returns a disposer removing both listeners.
 */
export function installDelegationReminders(ctx: Context, options: DelegationReminderOptions): () => void {
  if (options.nudgeInspectionSteps !== undefined && (!Number.isInteger(options.nudgeInspectionSteps) || options.nudgeInspectionSteps < 1)) {
    throw new Error(`dsh-roles: nudgeInspectionSteps must be an integer >= 1, got ${String(options.nudgeInspectionSteps)}`)
  }
  if (options.maxNudges !== undefined && (!Number.isInteger(options.maxNudges) || options.maxNudges < 0)) {
    throw new Error(`dsh-roles: maxNudges must be an integer >= 0, got ${String(options.maxNudges)}`)
  }
  if (options.catalogRefreshTurns !== undefined && (!Number.isInteger(options.catalogRefreshTurns) || options.catalogRefreshTurns < 0)) {
    throw new Error(`dsh-roles: catalogRefreshTurns must be an integer >= 0, got ${String(options.catalogRefreshTurns)}`)
  }

  const resolveSettings = (): {
    readonly models: ResolvedModels | undefined
    readonly threshold: number
    readonly maxNudges: number
    readonly refreshTurns: number
  } => {
    const cfg = options.getConfig?.()
    return {
      models: cfg?.models,
      threshold: options.nudgeInspectionSteps ?? cfg?.reminders.nudgeInspectionSteps ?? DEFAULT_NUDGE_INSPECTION_STEPS,
      maxNudges: options.maxNudges ?? cfg?.reminders.maxNudges ?? DEFAULT_MAX_DELEGATION_NUDGES,
      refreshTurns: options.catalogRefreshTurns ?? cfg?.reminders.catalogRefreshTurns ?? DEFAULT_CATALOG_REFRESH_TURNS,
    }
  }

  const freshState = (step: number, threshold: number): TurnInspectionState => ({
    currentStep: step,
    lastCountedStep: -1,
    inspectionSteps: 0,
    sawMutation: false,
    delegated: false,
    nudges: 0,
    nextNudgeAt: threshold,
  })
  const states = new WeakMap<Agent, TurnInspectionState>()

  const isToolVisibleToRoot = (agent: Agent): boolean => {
    if (!options.isEligibleRoot(agent)) return false
    const tools = (ctx as unknown as { tools?: { get?(name: string, scope?: unknown): ToolDefinition | undefined } }).tools
    if (typeof tools?.get === 'function' && tools.get(ORCHESTRATION_TOOL_NAME, agent) !== options.tool) {
      return false
    }
    return true
  }

  // Register with `prepend: true` so this waterfall wrapper sits on the outside
  // of `dsh-tool-skill` / memory recall hooks; its post-`next()` append then
  // lands at the recency tail of `decision.messages` (after 12KB+ skill catalogs).
  const disposePreStep = ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    const { models, threshold, refreshTurns } = resolveSettings()
    const hasIncomingUser = messages.some(message => message.source.kind === 'user')
    if (hasIncomingUser) {
      states.set(agent, freshState(step, threshold))
    } else {
      const existing = states.get(agent)
      if (existing !== undefined) {
        existing.currentStep = step
      } else {
        states.set(agent, freshState(step, threshold))
      }
    }

    if (!isToolVisibleToRoot(agent)) return decision

    const catalogText = formatRoleCatalogText(models)
    const digest = catalogDigest(catalogText)
    if (!hasPendingRoleCatalog(decision.messages, digest) && !hasVisibleRoleCatalog(agent, digest)) {
      return {
        ...decision,
        messages: [...decision.messages, createRoleCatalogMessage(models)],
      }
    }

    if (
      hasIncomingUser
      && refreshTurns > 0
      && !hasPendingRoleRefresh(decision.messages)
      && userTurnsSinceLastCatalogOrRefresh(agent) + 1 >= refreshTurns
    ) {
      return {
        ...decision,
        messages: [...decision.messages, createRoleRefreshMessage(models)],
      }
    }

    return decision
  }, { prepend: true })

  const observePostExecute = (exec: ToolExecution): UserMessage | undefined => {
    const agent = exec.agent
    if (agent === undefined || !isToolVisibleToRoot(agent)) return undefined

    const { models, threshold, maxNudges } = resolveSettings()
    const gpRoute = describeConfiguredRoute(models?.['general-purpose'])
    let state = states.get(agent)
    if (state === undefined) {
      state = freshState(0, threshold)
      states.set(agent, state)
    }

    if (exec.name === ORCHESTRATION_TOOL_NAME) {
      const callArgs = exec.arguments as { readonly role?: unknown; readonly readOnly?: unknown } | undefined
      const rawRole = callArgs?.role
      const role = typeof rawRole === 'string' ? rawRole : 'general-purpose'
      const isReadOnlyGp = role === 'general-purpose' && callArgs?.readOnly === true
      if (READ_ONLY_ROLES.has(role) || isReadOnlyGp) {
        // Read-only delegation finished: clear the inline counter so a short 1-2 step
        // follow-up stays silent, while a sustained inline loop afterward can still nudge.
        state.inspectionSteps = 0
        state.sawMutation = false
        state.lastCountedStep = state.currentStep
        state.nextNudgeAt = threshold
      } else {
        state.delegated = true
      }
      return undefined
    }
    const isMutation = isMutationTool(exec.name)
    const trackable = isInspectionTool(exec.name) || (gpRoute !== undefined && isMutation)
    if (maxNudges === 0 || state.delegated || !trackable) {
      return undefined
    }
    if (isMutation) state.sawMutation = true
    if (state.lastCountedStep === state.currentStep) {
      return undefined
    }

    state.lastCountedStep = state.currentStep
    state.inspectionSteps += 1
    if (state.nudges === 0) state.nextNudgeAt = threshold
    if (state.nudges >= maxNudges || state.inspectionSteps < state.nextNudgeAt) return undefined

    state.nudges += 1
    // After the first nudge is skipped, follow up slightly sooner (e.g. step 3 -> 5 -> 7)
    // so open-ended shell loops hit the strong escalation before burning many slow commands.
    const repeatGap = threshold >= 3 ? threshold - 1 : threshold
    state.nextNudgeAt = state.inspectionSteps + repeatGap
    return createDelegationNudgeMessage(state.inspectionSteps, state.nudges, maxNudges, {
      dedicatedGeneralPurposeRoute: gpRoute,
      includesMutation: state.sawMutation,
    })
  }

  const disposePostExecute = ctx.on('tools/post-execute', async (exec, _result, next) => {
    const reminder = observePostExecute(exec)
    const downstream = await next()
    if (reminder === undefined) return downstream
    return {
      ...downstream,
      additionalContexts: prependContext(reminder, downstream.additionalContexts),
    }
  })

  return () => {
    disposePostExecute()
    disposePreStep()
  }
}
