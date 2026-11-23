/**
 * Per-child isolation, durable policy recovery, role guards, and step-budget wiring.
 * @module dsh-roles/runtime
 */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import { appendPluginRecord, pluginRecordOf, Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session/types'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { ToolExecution, ToolGuardDenial } from '@deepseek-ai/dsh-tools'
import { DELEGATION_MAX_DEPTH, ORCHESTRATION_ROLES, stepBudget, THOROUGHNESS_LEVELS } from './config.js'
import type { OrchestrationRole, ResolvedConfig, Thoroughness } from './config.js'
import { GUIDE_TOOL_NAMES } from './guide.js'
import { CONVERGENCE_DENIAL, convergenceNotice } from './roles.js'
import { effectiveSessionCwd, normalizeWriteScopes, WRITE_TOOL_NAMES, writeScopeDenial } from './scope.js'
import type { NormalizedScope } from './scope.js'
import { ISOLATION_MODES } from './worktree.js'
import type { IsolationMode } from './worktree.js'

/** Session plugin-record type storing a managed child's role and write policy. */
export const CHILD_POLICY_RECORD_TYPE = 'plugin:dsh-roles/child' as const

/** Durable orchestration policy stored inside the child session's own event suffix. */
export interface PersistedChildPolicy {
  readonly version: 1
  readonly role: OrchestrationRole
  readonly thoroughness: Thoroughness
  readonly includeMcp: boolean
  readonly readOnly?: boolean
  readonly isolation?: IsolationMode
  readonly writeScopes?: readonly string[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-roles/child': PersistedChildPolicy
  }
}

/** Tools a read-only explore/plan role keeps. */
export const READ_ONLY_TOOL_NAMES = new Set(['read', 'glob', 'grep'])

/** Context-injected source kinds stripped from instruction-isolated children. */
const STRIPPED_SOURCE_KINDS = new Set([
  'agent-instructions',
  'skill-catalog',
  'skill-invocation',
  'dsh-roles/catalog',
  'dsh-roles/refresh',
  'dsh-roles/nudge',
])

const ORCHESTRATION_TOOL = 'orchestrate_subagent'

function isPersistedChildPolicy(value: unknown): value is PersistedChildPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<PersistedChildPolicy>
  if (record.version !== 1) return false
  if (typeof record.role !== 'string' || !(ORCHESTRATION_ROLES as readonly string[]).includes(record.role)) return false
  if (typeof record.thoroughness !== 'string' || !(THOROUGHNESS_LEVELS as readonly string[]).includes(record.thoroughness)) return false
  if (typeof record.includeMcp !== 'boolean') return false
  if (record.readOnly !== undefined && typeof record.readOnly !== 'boolean') return false
  if (record.isolation !== undefined && (typeof record.isolation !== 'string' || !(ISOLATION_MODES as readonly string[]).includes(record.isolation))) {
    return false
  }
  if (record.writeScopes !== undefined) {
    if (!Array.isArray(record.writeScopes) || record.writeScopes.length === 0) return false
    try {
      normalizeWriteScopes(record.writeScopes)
    } catch {
      return false
    }
  }
  return true
}

function presetFallbackPolicy(preset: string | undefined): PersistedChildPolicy | undefined {
  switch (preset) {
    case 'dsh-roles-explore':
      return { version: 1, role: 'explore', thoroughness: 'standard', includeMcp: false }
    case 'dsh-roles-plan':
      return { version: 1, role: 'plan', thoroughness: 'standard', includeMcp: false }
    case 'dsh-roles-general-purpose':
      return { version: 1, role: 'general-purpose', thoroughness: 'standard', includeMcp: false }
    case 'dsh-roles-guide':
      return { version: 1, role: 'dsh-code-guide', thoroughness: 'standard', includeMcp: false }
    default:
      return undefined
  }
}

/**
 * Commit a managed child's role and scope policy into its own event log suffix
 * so cold resumes (for instance via `send_message`) restore the exact guards.
 * Lightweight non-`Session` test stubs are ignored safely.
 * @param session - live child session or test double.
 * @param policy - validated role, budget tier, MCP opt-in, and write scopes.
 */
export function commitChildPolicy(session: Session, policy: PersistedChildPolicy): void {
  if (!(session instanceof Session)) return
  appendPluginRecord(session, CHILD_POLICY_RECORD_TYPE, policy)
}

/**
 * Recover a child's durable orchestration policy from events committed after
 * `session/end-seed` so forked sessions never inherit a parent's own record.
 * Falls back to internal managed preset names when no record is present.
 * @param session - session or stub whose events and header are inspected.
 * @returns the child policy, or undefined for root or unmanaged sessions.
 */
export function readChildPolicy(
  session: {
    readonly header?: { readonly agentPreset?: string }
    readonly snapshotEvents?: () => readonly SessionEvent[]
  },
): PersistedChildPolicy | undefined {
  if (typeof session.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    let endSeedIndex = -1
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'session/end-seed' && (event.data as { readonly inherited?: unknown } | undefined)?.inherited === true) {
        endSeedIndex = index
        break
      }
    }
    for (let index = events.length - 1; index > endSeedIndex; index -= 1) {
      const event = events[index]
      if (event === undefined) continue
      const record = pluginRecordOf(event)
      if (record?.type === CHILD_POLICY_RECORD_TYPE && isPersistedChildPolicy(record.data)) {
        return record.data
      }
    }
  }
  return presetFallbackPolicy(session.header?.agentPreset)
}

function inheritedToolNames(agent: Agent): string[] {
  return agent.ctx.tools.definitions(scopeParentOf(agent)).map(definition => definition.name)
}

function restrictInheritedTools(agent: Agent, allow?: readonly string[], deny?: readonly string[]): void {
  // An empty allow list is meaningful: it masks every inherited global tool.
  if (allow === undefined && (deny === undefined || deny.length === 0)) return
  agent.ctx.tools.restrict({
    ...(allow === undefined ? {} : { allow }),
    ...(deny === undefined || deny.length === 0 ? {} : { deny }),
  })
}

function readOnlyGuard(role: OrchestrationRole, allowedTools: ReadonlySet<string>): (exec: ToolExecution) => ToolGuardDenial | undefined {
  const allowedList = [...allowedTools].join(', ')
  return (exec) => {
    if (allowedTools.has(exec.name)) return undefined
    return {
      reason: `The ${role} role is read-only: \`${exec.name}\` is not available. Use ${allowedList}, and report the limitation instead of retrying.`,
      info: { name: 'dsh-roles', code: 'READ_ONLY_ROLE' },
    }
  }
}

/**
 * Guard a `fork` child against nested delegation while preserving all parent
 * tools and KV-cache tool declarations verbatim.
 * @param agent - the forked child agent.
 * @returns a tool guard inspecting `orchestrate_subagent` calls.
 */
export function forkDelegationGuard(agent: Agent): (exec: ToolExecution) => ToolGuardDenial | undefined {
  return (exec) => {
    if (exec.name !== ORCHESTRATION_TOOL) return undefined
    const requestedRole = (exec.arguments as { readonly role?: unknown } | null)?.role
    if (requestedRole === 'fork') {
      return {
        reason: 'Fork is not available inside a forked subagent. Complete this task directly using your tools.',
        info: { name: 'dsh-roles', code: 'NESTED_FORK_DENIED' },
      }
    }
    let depth = DELEGATION_MAX_DEPTH
    try {
      depth = Math.max(DELEGATION_MAX_DEPTH, delegationDepthOf(agent))
    } catch {
      depth = DELEGATION_MAX_DEPTH
    }
    return {
      reason: `Subagent nesting limit reached (depth ${depth} of ${DELEGATION_MAX_DEPTH}). Complete this task directly using your tools instead of spawning another subagent.`,
      info: { name: 'dsh-roles', code: 'MAX_DEPTH_REACHED' },
    }
  }
}

function filterInjectedInstructions(decision: PreStepDecision): PreStepDecision {
  if (decision.kind !== 'enter') return decision
  const kept: UserMessage[] = decision.messages.filter(message =>
    !STRIPPED_SOURCE_KINDS.has((message.source as { kind?: string }).kind ?? ''))
  return kept.length === decision.messages.length ? decision : { ...decision, messages: kept }
}

/**
 * Strip workspace instructions and skill catalogs from an isolated read-only
 * child's first and later requests. Registered with `prepend` so it wraps the
 * instruction/catalog listeners and can remove what they injected.
 * @param agent - the read-only child.
 */
export function stripExplorationInstructions(agent: Agent): void {
  agent.ctx.on('agent/pre-step', async (_payload, next) => filterInjectedInstructions(await next()), { prepend: true })
}

function readOnlyGeneralPurposeGuard(): (exec: ToolExecution) => ToolGuardDenial | undefined {
  return (exec) => {
    if (!WRITE_TOOL_NAMES.has(exec.name)) return undefined
    return {
      reason: `This general-purpose subagent is running in readOnly mode: \`${exec.name}\` is disabled. Do not modify repository files; report your findings instead.`,
      info: { name: 'dsh-roles', code: 'READ_ONLY_MODE' },
    }
  }
}

/**
 * Apply the role's inherited-tool policy:
 * - `explore` / `plan` keep only read/glob/grep and strip workspace instructions;
 * - `dsh-code-guide` keeps read-only doc/web/inspect tools and strips workspace instructions;
 * - `general-purpose` drops external MCP unless opted in, and disables file-editing
 *   tools (`write`, `edit`, `apply_patch`) when `readOnly` is true;
 * - `fork` keeps the parent tool list and full permissions for KV-cache fidelity,
 *   while blocking nested forks and over-depth subagent calls via guard.
 * @param agent - the freshly created or cold-resumed child.
 * @param role - delegated role.
 * @param options - worker MCP and read-only preferences.
 */
export function isolateRoleTools(
  agent: Agent,
  role: OrchestrationRole,
  options: { includeMcp: boolean; readOnly?: boolean },
): void {
  switch (role) {
    case 'explore':
    case 'plan': {
      const known = new Set(inheritedToolNames(agent))
      const allow = [...READ_ONLY_TOOL_NAMES].filter(name => known.has(name))
      restrictInheritedTools(agent, allow, undefined)
      agent.ctx.tools.guard(readOnlyGuard(role, READ_ONLY_TOOL_NAMES))
      stripExplorationInstructions(agent)
      return
    }
    case 'dsh-code-guide': {
      const known = new Set(inheritedToolNames(agent))
      const allow = [...GUIDE_TOOL_NAMES].filter(name => known.has(name))
      restrictInheritedTools(agent, allow, undefined)
      agent.ctx.tools.guard(readOnlyGuard(role, GUIDE_TOOL_NAMES))
      stripExplorationInstructions(agent)
      return
    }
    case 'general-purpose': {
      const inherited = inheritedToolNames(agent)
      const denySet = new Set<string>()
      if (!options.includeMcp) {
        for (const name of inherited) {
          if (name.startsWith('mcp__')) denySet.add(name)
        }
      }
      if (options.readOnly === true) {
        for (const name of inherited) {
          if (WRITE_TOOL_NAMES.has(name)) denySet.add(name)
        }
        agent.ctx.tools.guard(readOnlyGeneralPurposeGuard())
      }
      if (denySet.size > 0) restrictInheritedTools(agent, undefined, [...denySet])
      return
    }
    case 'fork':
      agent.ctx.tools.guard(forkDelegationGuard(agent))
      return
  }
}

/**
 * Enforce a `general-purpose` worker's declared write prefixes on `write`, `edit`,
 * and `apply_patch`, resolving symlinks on the target's existing ancestors.
 * Scope prefixes stay anchored to the worker's initial `baseCwd` even if the
 * child later emits `working-directory/change`, while relative targets resolve
 * against the child's current effective directory.
 * @param agent - the child agent.
 * @param scopes - checked workspace-relative prefixes.
 * @param baseCwd - initial session directory anchoring the declared scopes.
 */
export function enforceWriteScope(agent: Agent, scopes: readonly NormalizedScope[], baseCwd: string): void {
  agent.ctx.tools.guard((exec) => {
    const current = effectiveSessionCwd(agent.session, baseCwd)
    const denial = writeScopeDenial(exec.name, exec.arguments, current, scopes, baseCwd)
    return denial === undefined ? undefined : {
      reason: denial,
      info: { name: 'dsh-roles', code: 'WRITE_SCOPE_VIOLATION' },
    }
  })
}

/**
 * Install the two-layer step budget: arm tool suppression as step `budget - 1`
 * ends so the final admitted step renders 0 tools and converges cleanly, and
 * reject every later step. Clears turn-scoped convergence restrictions at
 * `turn/end` so resumed turns start cleanly.
 * @param agent - the managed child.
 * @param role - delegated role.
 * @param thoroughness - selected task size.
 * @param config - resolved budgets.
 * @param options - optional exhaustion callback for partial-output recovery.
 */
export function installStepBudget(
  agent: Agent,
  role: OrchestrationRole,
  thoroughness: Thoroughness,
  config: ResolvedConfig,
  options?: { readonly onBudgetExhausted?: () => void },
): void {
  const budget = stepBudget(config.budgets, role, thoroughness)
  let liftRestrict: (() => void) | undefined
  let liftGuard: (() => void) | undefined
  let notified = false

  const armConvergence = (): void => {
    if (liftRestrict !== undefined) return
    liftRestrict = agent.ctx.tools.restrict({ allow: [] })
    liftGuard = agent.ctx.tools.guard(() => ({
      reason: CONVERGENCE_DENIAL,
      info: { name: 'dsh-roles', code: 'BUDGET_EXHAUSTED' },
    }))
  }

  const resetTurnBudget = (): void => {
    liftGuard?.()
    liftRestrict?.()
    liftGuard = undefined
    liftRestrict = undefined
    notified = false
  }

  agent.ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'step/end' && event.data.step >= budget - 1) {
      armConvergence()
    } else if (event.type === 'turn/end') {
      resetTurnBudget()
    }
  })

  agent.ctx.on('agent/pre-step', async ({ step }, next) => {
    if (step > budget) {
      options?.onBudgetExhausted?.()
      return { kind: 'reject' }
    }
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (step < budget) return decision
    armConvergence()
    if (notified) return decision
    notified = true
    return {
      kind: 'enter',
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: convergenceNotice(role, budget) }],
        source: { kind: 'user' },
      })],
    }
  })
}
