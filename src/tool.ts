/**
 * The single model-facing entry point: `orchestrate_subagent`.
 * @module dsh-roles/tool
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type {
  SubagentActivation,
  SubagentActivationSpec,
  SubagentCapabilities,
  SubagentResult,
} from '@deepseek-ai/dsh-subagent'
import { defineTool, ToolArgsError as ArgsError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  DELEGATION_MAX_DEPTH,
  ORCHESTRATION_ROLES,
  stepBudget,
  THOROUGHNESS_LEVELS,
} from './config.js'
import type { OrchestrationRole, ResolvedConfig, RoleModelRoute, Thoroughness } from './config.js'
import { buildDshGuideContext } from './guide.js'
import { effectiveAgentPreset, isRelayAgent } from './relay.js'
import { rolePreamble } from './roles.js'
import { effectiveSessionCwd, normalizeWriteScopes, resolveWorkerBaseCwd, WorkerWriteCoordinator } from './scope.js'
import type { NormalizedScope } from './scope.js'
import { startDelegation } from './telemetry.js'
import type { DelegationState } from './telemetry.js'
import {
  buildWorktreeBranchName,
  finalizeWorktree,
  formatWorktreeSummary,
  ISOLATION_MODES,
  preflightWorktree,
} from './worktree.js'
import type { CreatedWorktree, IsolationMode, WorktreeOutcome, WorktreeServiceLike } from './worktree.js'

/** Model-facing tool name. */
export const ORCHESTRATION_TOOL_NAME = 'orchestrate_subagent'

/** Worktree creation parameters attached to a pre-registered local child. */
export interface PendingChildWorktreeRequest {
  readonly branchName?: string
  readonly description: string
  readonly childName?: string
}

/** One pre-registered child awaiting `agent/created` or settlement. */
export interface PendingChild {
  readonly state: DelegationState
  readonly includeMcp: boolean
  readonly readOnly: boolean
  readonly isolation: IsolationMode
  readonly writeScopes: readonly NormalizedScope[] | undefined
  readonly worktreeRequest?: PendingChildWorktreeRequest
  worktree?: CreatedWorktree
  worktreeOutcome?: Promise<WorktreeOutcome>
  /** Background workers hold their write reservation until settlement. */
  releaseWriteReservation?: () => void
}

/**
 * Idempotently finalize a child's isolated Git worktree once its run settles.
 * Safe to invoke from both `tool.execute` (sync) and `subagent/end` (background).
 */
export function settleChildWorktree(
  child: PendingChild,
  succeeded: boolean,
): Promise<WorktreeOutcome | undefined> {
  if (child.worktree === undefined) return Promise.resolve(undefined)
  if (child.worktreeOutcome === undefined) {
    child.worktreeOutcome = finalizeWorktree(child.worktree, {
      succeeded,
      description: child.worktreeRequest?.description ?? 'subagent changes',
      childName: child.worktreeRequest?.childName,
    })
  }
  return child.worktreeOutcome
}

/** Shared services the tool needs from the plugin composition. */
export interface ToolEnvironment {
  readonly config: ResolvedConfig
  readonly coordinator: WorkerWriteCoordinator
  /** Register the child id so lifecycle/telemetry events can bind to it. */
  registerChild(childId: SessionId, pending: PendingChild): void
  /** Drop a registration whose startup failed before publication. */
  releaseChild(childId: SessionId): void
  /** Keep a background worker's write reservation until `subagent/end`. */
  retainWriteReservation(childId: SessionId, release: () => void): void
  /** Settle an external activation when `subagent/end` is absent or raced before registration. */
  settleExternalChild?(state: DelegationState, stopReason: string): void
  /** Resolve the managed role of a live or restored agent, when known. */
  managedRoleOf?(agent: Agent): OrchestrationRole | undefined
  /** Resolve the optional official DSH `worktrees` service when installed. */
  getWorktreeService?(): WorktreeServiceLike | undefined
  /** Whether the calling agent may see the tool at all. */
  isVisible(agent: Agent): boolean
}

/** Presets mounted only for managed spawn children. */
const MANAGED_PRESETS = new Set([
  'dsh-roles-general-purpose',
  'dsh-roles-explore',
  'dsh-roles-plan',
  'dsh-roles-guide',
])

/**
 * Decide whether one agent sees the orchestration tool. Root sessions see it;
 * Relay sessions, managed fresh children, and nested subagents do not. A
 * managed `fork` child keeps the parent's exact tool declaration list for
 * KV-cache fidelity and is stopped by its guard instead.
 * @param agent - preparing agent.
 * @param managedRole - role recorded for this agent when it is our own child.
 * @returns true when the step should expose the tool.
 */
export function orchestrationToolVisible(
  agent: Agent,
  managedRole?: OrchestrationRole,
): boolean {
  if (isRelayAgent(agent)) return false
  if (managedRole === 'fork') return true
  const preset = effectiveAgentPreset(agent)
  if (preset !== undefined && MANAGED_PRESETS.has(preset)) return false
  try {
    return delegationDepthOf(agent) < DELEGATION_MAX_DEPTH
  } catch {
    return false
  }
}

/** Compact English role tags prefixed onto `SubagentActivationSpec.label` for compact UI display. */
export const ROLE_SHORT_TAGS: Readonly<Record<OrchestrationRole, string>> = Object.freeze({
  'general-purpose': 'gp',
  explore: 'exp',
  plan: 'plan',
  fork: 'fork',
  'dsh-code-guide': 'guide',
})

/**
 * Format the UI-facing task label with a compact `[tag]` role prefix (and external
 * provider name when routed outside local `spawn`/`fork`) so subagent popovers
 * and header badges identify both the role and backend without crowding the title.
 */
export function formatActivationLabel(
  role: OrchestrationRole,
  description: string,
  provider?: string,
): string {
  const trimmed = description.trim()
  const tag = ROLE_SHORT_TAGS[role]
  const externalTag = provider !== undefined && provider !== 'spawn' && provider !== 'fork'
    ? `${tag} · ${provider}`
    : tag
  if (trimmed === '') return `[${externalTag}]`
  const lower = trimmed.toLowerCase()
  if (
    lower.startsWith(`[${externalTag.toLowerCase()}]`)
    || (externalTag === tag && (lower.startsWith(`[${tag}]`) || lower.startsWith(`[${role}]`)))
  ) {
    return trimmed
  }
  return `[${externalTag}] ${trimmed}`
}

/**
 * Record a synchronous (`delivery: 'caller'`) external subagent run in the
 * parent session's `subagent/catalog` projection using DSH's unnamed `version: 2`
 * external entry shape. DSH's core subagent manager skips `establishExternalCatalogChild`
 * for `delivery: 'caller'` external runs because they do not reserve a `name`; writing
 * the unnamed `version: 2` entry restores the visible header subagent indicator in the
 * DSH Web UI without colliding with named `delivery: 'parent'` reservations.
 */
function recordCallerExternalCatalog(parent: Agent, childId: SessionId, label: string): void {
  const append = (parent.session as unknown as {
    append?(type: string, data: Record<string, unknown>): unknown
  })?.append
  if (typeof append !== 'function') return
  try {
    append.call(parent.session, 'subagent/catalog', {
      version: 2,
      childId,
      childCreatedAt: Date.now(),
      mode: 'external',
      label,
    })
  } catch {
    // Ignore sessions that do not support appending catalog events (e.g. lightweight test stubs).
  }
}

function presetForRole(role: OrchestrationRole): string | undefined {
  switch (role) {
    case 'general-purpose':
      return 'dsh-roles-general-purpose'
    case 'explore':
      return 'dsh-roles-explore'
    case 'plan':
      return 'dsh-roles-plan'
    case 'dsh-code-guide':
      return 'dsh-roles-guide'
    case 'fork':
      return undefined
  }
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function resultText(
  role: OrchestrationRole,
  thoroughness: Thoroughness,
  state: DelegationState,
  result: SubagentResult,
  isLocal: boolean,
): string {
  const wallMs = Math.max(0, Date.now() - state.startedAt)
  const stopTag = result.stopReason === 'refusal' && state.budgetExhausted ? 'budget-exhausted' : result.stopReason
  const header = isLocal
    ? `[${role}/${thoroughness}] ${stopTag} · ${state.steps} step(s) · ${(wallMs / 1000).toFixed(1)}s`
    : `[${role}/${thoroughness} · ${state.provider}] ${stopTag} · ${(wallMs / 1000).toFixed(1)}s`
  const output = textOf(result.output)
  const body = output === '' ? '(the subagent produced no textual output)' : output
  const diagnostic = result.diagnostic === undefined ? '' : `\n\nDiagnostic: ${result.diagnostic}`
  return `${header}\n\n${body}${diagnostic}`
}

const VALID_CHILD_NAME = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Normalize benign casing/separator mistakes in model-supplied child names
 * (such as `sgm-goBack-probe` or `code_review`) into DSH's `^[a-z][a-z0-9-]{0,31}$`
 * format so a subagent call does not waste a turn retrying on capitalization.
 * Reserved (`lead`) or unrecoverable names pass through untouched for host validation.
 */
export function normalizeChildName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return raw
  if (VALID_CHILD_NAME.test(trimmed)) return trimmed
  const slug = trimmed
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  if (slug !== 'lead' && VALID_CHILD_NAME.test(slug)) return slug
  return raw
}

function validateSemantics(role: OrchestrationRole, args: {
  writeScope?: readonly string[]
  includeMcp?: boolean
  readOnly?: boolean
  isolation?: IsolationMode
}): void {
  const violations: string[] = []
  if (role !== 'general-purpose') {
    if (args.writeScope !== undefined) violations.push('writeScope is only supported for role "general-purpose"')
    if (args.includeMcp === true) violations.push('includeMcp is only supported for role "general-purpose"')
    if (args.readOnly === true) violations.push('readOnly is only supported for role "general-purpose"')
    if (args.isolation !== undefined && args.isolation !== 'none') {
      violations.push('isolation is only supported for role "general-purpose"')
    }
  } else if (args.readOnly === true) {
    if (args.writeScope !== undefined) violations.push('readOnly cannot be combined with writeScope')
    if (args.isolation === 'worktree') violations.push('readOnly cannot be combined with isolation "worktree"')
  }
  if (violations.length > 0) throw new ArgsError(violations)
}

function resolveProviderCapabilities(
  ctx: Context,
  provider: string,
): {
  readonly isLocal: boolean
  readonly canPreset: boolean
  readonly canAgentOptions: boolean
  readonly canDepthLimit: boolean
} {
  const registry = ctx.subagents as {
    getProvider?(name: string): {
      readonly capabilities: SubagentCapabilities
      readonly inheritsParentContext: boolean
      readonly prepareContinuable?: unknown
    } | undefined
  }
  const providerImpl = registry.getProvider?.(provider)
  if (providerImpl === undefined) {
    return {
      isLocal: provider === 'spawn' || provider === 'fork',
      canPreset: provider === 'spawn',
      canAgentOptions: provider === 'spawn' || provider === 'fork',
      canDepthLimit: provider === 'spawn' || provider === 'fork',
    }
  }
  return {
    isLocal: typeof providerImpl.prepareContinuable === 'function',
    canPreset: providerImpl.capabilities.agentPreset && !providerImpl.inheritsParentContext,
    canAgentOptions: providerImpl.capabilities.agentOptions,
    canDepthLimit: providerImpl.capabilities.depthLimit,
  }
}

function buildAgentOptions(route: RoleModelRoute | undefined, canAgentOptions: boolean): AgentOptions | undefined {
  if (!canAgentOptions || route?.provider === undefined || route.model === undefined) return undefined
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
  }
}

function closeActivation(activation: SubagentActivation, logger: { warn(...args: unknown[]): void }): void {
  void activation.dispose().catch((error: unknown) => {
    logger.warn('subagent disposal failed: %o', error)
  })
}

/**
 * Create the orchestration tool definition.
 * @param ctx - plugin context owning the registration.
 * @param env - shared configuration and child bookkeeping.
 * @returns the registry-ready definition.
 */
export function createOrchestrationTool(ctx: Context, env: ToolEnvironment): ToolDefinition {
  return defineTool({
    name: ORCHESTRATION_TOOL_NAME,
    description: [
      'Launch a specialized subagent role to handle multi-step investigation, review, exploration, planning, or implementation and return its distilled result.',
      'Available roles and their tools are listed in `<system-reminder>` messages in the conversation (`general-purpose` by default, `explore`, `plan`, `fork`, `dsh-code-guide`).',
      '',
      '## When to use',
      '- Feature implementation, bug fixes, refactors, or multi-file code changes (especially with tests/verification, or when a dedicated `general-purpose` backend is configured) → `general-purpose`',
      '- Code review / branch or commit diff analysis touching more than 1 file (or a large cross-module change) → `general-purpose`',
      '- Error, log, or monitoring troubleshooting that requires correlating logs with code or git history → `general-purpose` (set `includeMcp: true` when MCP query tools are needed) or `fork`',
      '- Unfamiliar codebase search (>2 queries or unknown directories) → `explore`',
      '- Unfamiliar CLI/environment/config debugging → `general-purpose`',
      '- Multi-file architecture or refactor planning → `plan`; DSH/Cordis docs or config questions → `dsh-code-guide`',
      '',
      '## When not to use',
      'Handle trivial tasks directly without delegating (even when dedicated backends are configured): plain Q&A, reading 1–2 already-known files, an obvious localized edit (such as a typo, constant, copy, or 1–2 known lines needing no debugging/test loop), or a single deterministic command (`git status`/`git commit`/`git push`).',
      '',
      '## Usage notes',
      '- By default, the call runs synchronously in this step and returns the subagent report. Pass `background: true` only when you can do other useful local work before the result is needed.',
      '- Fresh roles (`general-purpose`, `explore`, `plan`, `dsh-code-guide`) start with zero conversation history — write a self-contained `prompt` with paths, context, and expected deliverable. `fork` inherits completed prior turns and shares your prompt cache (list same-turn edits in `prompt`).',
      '- For parallel `general-purpose` calls in one step: pass `readOnly: true` for read-only reviews/investigations, disjoint `writeScope` prefixes for non-overlapping edits in the main checkout, or `isolation: "worktree"` for isolated Git branch edits that may touch shared files (requires `@deepseek-ai/dsh-experimental-worktree`; returns branch/diff coordinates so you can review and merge via `git`).',
      '',
      'Example usage:',
      '<example>',
      'user: "Add rate limiting to the login endpoint and cover it with unit tests."',
      'assistant: <thinking>This is substantive implementation requiring logic edits and unit test verification rather than a trivial 1-2 line edit. Delegating it to `general-purpose` keeps implementation and test iteration isolated and uses any configured execution backend.</thinking>',
      'orchestrate_subagent({',
      '  role: "general-purpose",',
      '  description: "Add login rate limiting",',
      '  prompt: "Add rate limiting to the login endpoint (check src/auth/login.ts and related middleware/config), add unit tests covering normal and throttled requests, and run the relevant test suite. Return Summary, Files with line ranges, and exact Verification results."',
      '})',
      '</example>',
      '<example>',
      'user: "Review the changes on this branch / MR."',
      'assistant: <thinking>`git diff --stat` shows 3 changed files across 2 modules (>1 file). Reading every diff inline would clutter my context, so I will delegate a fresh-eyes review to `general-purpose`.</thinking>',
      'orchestrate_subagent({',
      '  role: "general-purpose",',
      '  description: "Review 3-file branch diff",',
      '  prompt: "Review all changes on the current branch against main (3 files). Inspect the full diff and surrounding callers, and report concrete bugs, edge cases, regressions, and missing tests with `path:line` references."',
      '})',
      '</example>',
      '<example>',
      'user: "Look into why endpoint X timed out yesterday and find the root cause in the repo."',
      'assistant: <thinking>This requires correlating logs/errors with code and git history across multiple steps. Offloading it to `general-purpose` keeps raw log and grep noise out of my context.</thinking>',
      'orchestrate_subagent({',
      '  role: "general-purpose",',
      '  description: "Investigate timeout root cause",',
      '  prompt: "Investigate why endpoint X timed out yesterday. Inspect relevant logs/history and trace the code path in the repo; return the root cause with exact `path:line` evidence."',
      '})',
      '</example>',
    ].join('\n'),
    parameters: {
      role: {
        type: 'string',
        enum: [...ORCHESTRATION_ROLES],
        description: 'general-purpose (default) = fresh full-tool agent; explore = fast read-only search; plan = read-only architect; fork = context-sharing local fork; dsh-code-guide = DSH/Cordis specialist.',
      },
      thoroughness: {
        type: 'string',
        enum: [...THOROUGHNESS_LEVELS],
        description: 'Task size and step budget: quick, standard (default), or thorough.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display. Use the language of the current request.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The self-contained task. Include paths, constraints, and the expected deliverable. For `fork`, completed prior turns are inherited, but same-turn edits are not — list changed paths and intent directly.',
      },
      cwd: {
        type: 'string',
        description: 'Initial working directory. Relative paths use the current directory; omitted inherits it.',
      },
      background: {
        type: 'boolean',
        description: 'Return immediately and receive the result asynchronously. Defaults to false: wait in this step and return the result directly.',
      },
      name: {
        type: 'string',
        description: 'Optional short name, unique among your children: lower-case letters, digits, and hyphens, starting with a letter, at most 32 characters. `lead` is reserved.',
      },
      writeScope: {
        type: 'array',
        items: { type: 'string' },
        description: 'general-purpose only: workspace-relative directory prefixes this child may write. Concurrent main-checkout writes must declare disjoint scopes.',
      },
      readOnly: {
        type: 'boolean',
        description: 'general-purpose only: declare that this child will only inspect, review, or run read-only checks without modifying files. Skips the concurrent write lock and disables write/edit/apply_patch tools; cannot be combined with writeScope or isolation="worktree".',
      },
      isolation: {
        type: 'string',
        enum: [...ISOLATION_MODES],
        description: 'general-purpose only: "none" (default) shares the main checkout; "worktree" isolates this child in a new Git worktree and branch via @deepseek-ai/dsh-experimental-worktree so concurrent mutating workers can edit overlapping/shared files and merge afterward.',
      },
      includeMcp: {
        type: 'boolean',
        description: 'general-purpose only: keep external `mcp__*` tools. Defaults to false so unrelated MCP schemas are stripped.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          text: { type: 'string' },
          name: { type: 'string' },
          role: { type: 'string', required: true },
          provider: { type: 'string' },
          steps: { type: 'number' },
          wallMs: { type: 'number' },
          stopReason: { type: 'string' },
          worktree: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true },
              branch: { type: 'string', required: true },
              path: { type: 'string', required: true },
              baseCommit: { type: 'string', required: true },
              headCommit: { type: 'string' },
              commitCount: { type: 'number' },
              autoCommitted: { type: 'boolean' },
              cleanedUp: { type: 'boolean', required: true },
              changedFiles: { type: 'array', items: { type: 'string' } },
              diffStat: { type: 'string' },
              note: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'activation'
          ? [
              `started ${value.role}${value.provider !== undefined && value.provider !== 'spawn' && value.provider !== 'fork' ? ` (${value.provider})` : ''} subagent ${value.name ?? ''}`.trim(),
              ...(value.worktree === undefined ? [] : [`(worktree branch ${value.worktree.branch} at ${value.worktree.path})`]),
            ].join(' ')
          : value.text ?? '',
      }],
      presentationMeta: (_args, value) => ({
        kind: value.kind,
        ...(value.name === undefined ? {} : { name: value.name }),
        role: value.role,
        ...(value.provider === undefined ? {} : { provider: value.provider }),
      }),
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const config = env.config
      const parent = exec.agent
      if (parent === undefined) throw new Error('orchestrate_subagent requires a calling agent')
      const role: OrchestrationRole = args.role ?? 'general-purpose'
      const thoroughness: Thoroughness = args.thoroughness ?? 'standard'
      validateSemantics(role, args)
      if (role === 'fork' && env.managedRoleOf?.(parent) === 'fork') {
        throw new ArgsError(['Fork is not available inside a forked subagent'])
      }
      const readOnly = role === 'general-purpose' && args.readOnly === true
      const isolation: IsolationMode = role === 'general-purpose' ? (args.isolation ?? 'none') : 'none'
      let writeScopes: NormalizedScope[] | undefined
      if (role === 'general-purpose') {
        try {
          writeScopes = normalizeWriteScopes(args.writeScope)
        } catch (error) {
          throw new ArgsError([error instanceof Error ? error.message : String(error)])
        }
      }
      const includeMcp = role === 'general-purpose' && args.includeMcp === true
      const delivery = args.background === true ? 'parent' as const : 'caller' as const
      const roleRoute = role === 'fork' ? undefined : config.models[role]
      const provider = role === 'fork' ? 'fork' : (roleRoute?.subagentProvider ?? 'spawn')
      const { isLocal, canPreset, canAgentOptions, canDepthLimit } = resolveProviderCapabilities(ctx, provider)
      const parentCwd = effectiveSessionCwd(parent.session, process.cwd())

      if (isolation === 'worktree') {
        const targetCwd = resolveWorkerBaseCwd(parentCwd, args.cwd)
        try {
          await preflightWorktree({
            worktreeService: env.getWorktreeService?.(),
            isLocal,
            provider,
            targetCwd,
            signal: exec.signal,
          })
        } catch (error) {
          throw new ArgsError([error instanceof Error ? error.message : String(error)])
        }
      }

      let reservation: ReturnType<WorkerWriteCoordinator['reserve']> | undefined
      if (role === 'general-purpose' && !readOnly && isolation !== 'worktree') {
        reservation = env.coordinator.reserve(parent.id, exec.callId, writeScopes, { parentCwd, childCwd: args.cwd })
        if (!reservation.ok) throw new ArgsError([reservation.reason])
      }

      const normalizedName = normalizeChildName(args.name)
      const reservedChildId = isLocal ? randomUUID() as SessionId : undefined
      const state = startDelegation({
        role,
        thoroughness,
        delivery,
        provider,
        childId: reservedChildId ?? 'pending-external',
        startedAt: Date.now(),
        ...(readOnly ? { readOnly: true } : {}),
        ...(isolation === 'worktree' ? { isolation } : {}),
      })
      const pendingChild: PendingChild = {
        state,
        includeMcp,
        readOnly,
        isolation,
        writeScopes,
        ...(isolation === 'worktree' && reservedChildId !== undefined
          ? {
              worktreeRequest: {
                branchName: buildWorktreeBranchName(reservedChildId, normalizedName),
                description: args.description,
                ...(normalizedName === undefined ? {} : { childName: normalizedName }),
              },
            }
          : {}),
      }
      if (reservedChildId !== undefined) {
        env.registerChild(reservedChildId, pendingChild)
      }

      let activation: SubagentActivation | undefined
      let retainedReservation = false
      try {
        const preambleOptions = {
          ...(isLocal ? {} : { externalStepBudget: stepBudget(config.budgets, role, thoroughness) }),
          ...(readOnly ? { readOnly: true } : {}),
          ...(isolation === 'worktree' ? { worktree: true } : {}),
        }
        let taskBody = `${rolePreamble(role, thoroughness, preambleOptions)}\n\n<task>\n${args.prompt}\n</task>`
        if (role === 'dsh-code-guide') {
          const guideContext = await buildDshGuideContext(ctx, parent, config)
          taskBody = `${taskBody}\n\n${guideContext}`
        }

        const preset = canPreset ? presetForRole(role) : undefined
        const agentOptions = buildAgentOptions(roleRoute, canAgentOptions)
        const omitExternalCallerName = !isLocal && delivery === 'caller'
        const activationLabel = formatActivationLabel(role, args.description, isLocal ? undefined : provider)
        const spec: SubagentActivationSpec = {
          provider,
          label: activationLabel,
          ...(reservedChildId === undefined ? {} : { childId: reservedChildId }),
          prompt: [{ type: 'text', text: taskBody }],
          parent,
          ...(canDepthLimit ? { maxDepth: DELEGATION_MAX_DEPTH } : {}),
          signal: exec.signal,
          delivery,
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(normalizedName === undefined || omitExternalCallerName ? {} : { name: normalizedName }),
          ...(preset === undefined ? {} : { agentPreset: preset }),
          ...(agentOptions === undefined ? {} : { agentOptions }),
        }

        activation = await ctx.subagents.startActivation(spec)
        if (reservedChildId === undefined) {
          state.childId = activation.childId
          env.registerChild(activation.childId, pendingChild)
        }
        if (omitExternalCallerName) {
          recordCallerExternalCatalog(parent, activation.childId, activationLabel)
        }

        if (delivery === 'parent') {
          if (reservation?.ok) {
            env.retainWriteReservation(activation.childId, reservation.release)
            retainedReservation = true
          }
          if (!isLocal) {
            void activation.result.then(
              (settled) => { env.settleExternalChild?.(state, settled.stopReason) },
              () => { env.settleExternalChild?.(state, 'error') },
            )
          }
          const activeWorktree: WorktreeOutcome | undefined = pendingChild.worktree === undefined
            ? undefined
            : {
                status: 'active',
                branch: pendingChild.worktree.branch,
                path: pendingChild.worktree.path,
                baseCommit: pendingChild.worktree.baseCommit,
                cleanedUp: false,
              }
          return {
            kind: 'activation' as const,
            role,
            provider,
            name: activation.name,
            ...(activeWorktree === undefined ? {} : { worktree: activeWorktree }),
          }
        }

        let result: SubagentResult
        try {
          result = await activation.result
        } catch (error) {
          if (!isLocal) env.settleExternalChild?.(state, 'error')
          const failedOutcome = await settleChildWorktree(pendingChild, false)
          const suffix = failedOutcome === undefined ? '' : `\n\n${formatWorktreeSummary(failedOutcome)}`
          throw new Error(`orchestrate_subagent ${role} failed before producing a result: ${error instanceof Error ? error.message : String(error)}${suffix}`)
        }
        if (!isLocal) env.settleExternalChild?.(state, result.stopReason)
        const wallMs = Math.max(0, Date.now() - state.startedAt)
        const hasPartialOnBudget = result.stopReason === 'refusal' && state.budgetExhausted && textOf(result.output) !== ''
        const succeeded = result.stopReason === 'completed' || hasPartialOnBudget
        const worktreeOutcome = await settleChildWorktree(pendingChild, succeeded)
        const baseText = resultText(role, thoroughness, state, result, isLocal)
        const text = worktreeOutcome === undefined ? baseText : `${baseText}\n\n${formatWorktreeSummary(worktreeOutcome)}`
        if (!succeeded) {
          throw new Error(text)
        }
        return {
          kind: 'result' as const,
          role,
          provider,
          text,
          steps: state.steps,
          wallMs,
          stopReason: hasPartialOnBudget ? 'budget-exhausted' : result.stopReason,
          ...(worktreeOutcome === undefined ? {} : { worktree: worktreeOutcome }),
        }
      } finally {
        if (activation === undefined && pendingChild.worktree !== undefined) {
          await settleChildWorktree(pendingChild, false).catch(() => {})
        }
        if (reservation?.ok && !retainedReservation) reservation.release()
        if (activation === undefined && reservedChildId !== undefined) env.releaseChild(reservedChildId)
        else if (activation !== undefined && delivery === 'caller') closeActivation(activation, ctx.logger)
      }
    },
  })
}
