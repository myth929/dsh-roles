/**
 * The single model-facing entry point: `orchestrate_subagent`.
 * @module dsh-orchestration/tool
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
  THOROUGHNESS_LEVELS,
} from './config.js'
import type { OrchestrationRole, ResolvedConfig, RoleModelRoute, Thoroughness } from './config.js'
import { buildDshGuideContext } from './guide.js'
import { effectiveAgentPreset, isRelayAgent } from './relay.js'
import { rolePreamble } from './roles.js'
import { effectiveSessionCwd, normalizeWriteScopes, WorkerWriteCoordinator } from './scope.js'
import type { NormalizedScope } from './scope.js'
import { startDelegation } from './telemetry.js'
import type { DelegationState } from './telemetry.js'

/** Model-facing tool name. */
export const ORCHESTRATION_TOOL_NAME = 'orchestrate_subagent'

/** One pre-registered child awaiting `agent/created` or settlement. */
export interface PendingChild {
  readonly state: DelegationState
  readonly includeMcp: boolean
  readonly writeScopes: readonly NormalizedScope[] | undefined
  /** Background workers hold their write reservation until settlement. */
  releaseWriteReservation?: () => void
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
  /** Whether the calling agent may see the tool at all. */
  isVisible(agent: Agent): boolean
}

/** Presets mounted only for managed spawn children. */
const MANAGED_PRESETS = new Set([
  'dsh-orchestration-general-purpose',
  'dsh-orchestration-explore',
  'dsh-orchestration-plan',
  'dsh-orchestration-guide',
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

function presetForRole(role: OrchestrationRole): string | undefined {
  switch (role) {
    case 'general-purpose':
      return 'dsh-orchestration-general-purpose'
    case 'explore':
      return 'dsh-orchestration-explore'
    case 'plan':
      return 'dsh-orchestration-plan'
    case 'dsh-code-guide':
      return 'dsh-orchestration-guide'
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

function resultText(role: OrchestrationRole, thoroughness: Thoroughness, state: DelegationState, result: SubagentResult): string {
  const wallMs = Math.max(0, Date.now() - state.startedAt)
  const stopTag = result.stopReason === 'refusal' && state.budgetExhausted ? 'budget-exhausted' : result.stopReason
  const header = `[${role}/${thoroughness}] ${stopTag} · ${state.steps} step(s) · ${(wallMs / 1000).toFixed(1)}s`
  const output = textOf(result.output)
  const body = output === '' ? '(the subagent produced no textual output)' : output
  const diagnostic = result.diagnostic === undefined ? '' : `\n\nDiagnostic: ${result.diagnostic}`
  return `${header}\n\n${body}${diagnostic}`
}

function validateSemantics(role: OrchestrationRole, args: {
  writeScope?: readonly string[]
  includeMcp?: boolean
}): void {
  const violations: string[] = []
  if (role !== 'general-purpose') {
    if (args.writeScope !== undefined) violations.push('writeScope is only supported for role "general-purpose"')
    if (args.includeMcp === true) violations.push('includeMcp is only supported for role "general-purpose"')
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
    description:
      'Delegate one focused task to a specialized subagent role and return its distilled result. '
      + 'Use `general-purpose` (default) for multi-step implementation (with optional disjoint `writeScope` for parallel calls), complex debugging, or a fresh unbiased code review. '
      + 'Use `explore` for fast read-only codebase search; it returns Key Files coordinates the caller must read before editing. '
      + 'Use `plan` for read-only architectural design and step-by-step planning ending with Critical Files for Implementation. '
      + 'Use `fork` to inherit completed prior turns on the parent model and share prompt cache (ideal for audits, verification runs, or open-ended surveys; list same-turn edits in `prompt`). '
      + 'Use `dsh-code-guide` for read-only questions about DSH CLI, profiles, Cordis plugins/services, presets, subagents, or active host setup. '
      + 'By default the call waits in this same step and returns the child result. Set `background: true` only when you can continue useful local work before the result is needed. '
      + 'Do not delegate known paths, single-symbol lookups, at most three files, or plain test/build/git commands — do those directly.',
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
        description: 'general-purpose only: workspace-relative directory prefixes this child may write. Concurrent general-purpose calls must declare disjoint scopes.',
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
          steps: { type: 'number' },
          wallMs: { type: 'number' },
          stopReason: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'activation'
          ? `started ${value.role} subagent ${value.name ?? ''}`.trim()
          : value.text ?? '',
      }],
      presentationMeta: (_args, value) => ({
        kind: value.kind,
        ...(value.name === undefined ? {} : { name: value.name }),
        role: value.role,
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
      const writeScopes = role === 'general-purpose' ? normalizeWriteScopes(args.writeScope) : undefined
      const includeMcp = role === 'general-purpose' && args.includeMcp === true
      const delivery = args.background === true ? 'parent' as const : 'caller' as const
      const roleRoute = role === 'fork' ? undefined : config.models[role]
      const provider = role === 'fork' ? 'fork' : (roleRoute?.subagentProvider ?? 'spawn')
      const { isLocal, canPreset, canAgentOptions, canDepthLimit } = resolveProviderCapabilities(ctx, provider)

      let reservation: ReturnType<WorkerWriteCoordinator['reserve']> | undefined
      if (role === 'general-purpose') {
        const parentCwd = effectiveSessionCwd(parent.session, process.cwd())
        reservation = env.coordinator.reserve(parent.id, exec.callId, writeScopes, { parentCwd, childCwd: args.cwd })
        if (!reservation.ok) throw new ArgsError([reservation.reason])
      }

      const reservedChildId = isLocal ? randomUUID() as SessionId : undefined
      const state = startDelegation({
        role,
        thoroughness,
        delivery,
        provider,
        childId: reservedChildId ?? 'pending-external',
        startedAt: Date.now(),
      })
      if (reservedChildId !== undefined) {
        env.registerChild(reservedChildId, { state, includeMcp, writeScopes })
      }

      let activation: SubagentActivation | undefined
      let retainedReservation = false
      try {
        let taskBody = `${rolePreamble(role, thoroughness)}\n\n<task>\n${args.prompt}\n</task>`
        if (role === 'dsh-code-guide') {
          const guideContext = await buildDshGuideContext(ctx, parent, config)
          taskBody = `${taskBody}\n\n${guideContext}`
        }

        const preset = canPreset ? presetForRole(role) : undefined
        const agentOptions = buildAgentOptions(roleRoute, canAgentOptions)
        const omitExternalCallerName = !isLocal && delivery === 'caller'
        const spec: SubagentActivationSpec = {
          provider,
          label: args.description,
          ...(reservedChildId === undefined ? {} : { childId: reservedChildId }),
          prompt: [{ type: 'text', text: taskBody }],
          parent,
          ...(canDepthLimit ? { maxDepth: DELEGATION_MAX_DEPTH } : {}),
          signal: exec.signal,
          delivery,
          ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
          ...(args.name === undefined || omitExternalCallerName ? {} : { name: args.name }),
          ...(preset === undefined ? {} : { agentPreset: preset }),
          ...(agentOptions === undefined ? {} : { agentOptions }),
        }

        activation = await ctx.subagents.startActivation(spec)
        if (reservedChildId === undefined) {
          state.childId = activation.childId
          env.registerChild(activation.childId, { state, includeMcp, writeScopes })
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
          return {
            kind: 'activation' as const,
            role,
            name: activation.name,
          }
        }

        let result: SubagentResult
        try {
          result = await activation.result
        } catch (error) {
          if (!isLocal) env.settleExternalChild?.(state, 'error')
          throw new Error(`orchestrate_subagent ${role} failed before producing a result: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!isLocal) env.settleExternalChild?.(state, result.stopReason)
        const wallMs = Math.max(0, Date.now() - state.startedAt)
        const text = resultText(role, thoroughness, state, result)
        const hasPartialOnBudget = result.stopReason === 'refusal' && state.budgetExhausted && textOf(result.output) !== ''
        if (result.stopReason !== 'completed' && !hasPartialOnBudget) {
          throw new Error(text)
        }
        return {
          kind: 'result' as const,
          role,
          text,
          steps: state.steps,
          wallMs,
          stopReason: hasPartialOnBudget ? 'budget-exhausted' : result.stopReason,
        }
      } finally {
        if (reservation?.ok && !retainedReservation) reservation.release()
        if (activation === undefined && reservedChildId !== undefined) env.releaseChild(reservedChildId)
        else if (activation !== undefined && delivery === 'caller') closeActivation(activation, ctx.logger)
      }
    },
  })
}
