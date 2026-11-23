/**
 * `dsh-roles`: a standalone DSH bundle that exposes one role-layered
 * delegation tool with per-role context slimming, bounded steps, write-scope
 * enforcement, per-role model/provider routing, and real delegation telemetry.
 * @module dsh-roles
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { registerAntigravityOarFallback } from './antigravity.js'
import {
  Config as PluginConfigSchema,
  resolveOrchestrationConfig,
  unwrapPluginConfig,
} from './config.js'
import type { OrchestrationRole, PluginConfigInput, ResolvedConfig } from './config.js'
import { listExternalSubagentProviders } from './guide.js'
import { isRelayAgent } from './relay.js'
import { installDelegationReminders } from './reminder.js'
import { formatRootSchedulingGuidance } from './roles.js'
import { commitChildPolicy, enforceWriteScope, installStepBudget, isolateRoleTools, readChildPolicy } from './runtime.js'
import { effectiveSessionCwd, normalizeWriteScopes, WorkerWriteCoordinator } from './scope.js'
import { addUsage, observeStep, settleDelegation, TELEMETRY_LOG_PREFIX } from './telemetry.js'
import type { DelegationState } from './telemetry.js'
import { createOrchestrationTool, orchestrationToolVisible, ORCHESTRATION_TOOL_NAME, settleChildWorktree } from './tool.js'
import type { PendingChild } from './tool.js'
import type { WorktreeServiceLike } from './worktree.js'

export const name = 'dsh-roles'
export const inject = ['tools', 'subagents', 'systemPrompt']
export const Config = PluginConfigSchema

/** Stable prompt section name for the root scheduling policy. */
export const GUIDANCE_SECTION_NAME = 'dsh-roles:guidance'

/** Internal preset identities mounted for orchestration children; hidden from mode selectors. */
export const ORCHESTRATION_PRESETS = [
  'dsh-roles-general-purpose',
  'dsh-roles-explore',
  'dsh-roles-plan',
  'dsh-roles-guide',
] as const
const HIDDEN_ORCHESTRATION_PRESETS = new Set<string>(ORCHESTRATION_PRESETS)
const BARE_DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'subagent_oar'] as const

/**
 * Whether a preset id is an internal execution preset managed by `dsh-roles`.
 * @param id - preset identity.
 * @returns true when the preset should stay hidden from user-facing mode selectors.
 */
export function hiddenOrchestrationPreset(id: string): boolean {
  return HIDDEN_ORCHESTRATION_PRESETS.has(id)
}

/**
 * Whether the root scheduling policy belongs to this assembly.
 * Native roots and forked `fork` children receive the exact same section
 * (keeping node 0 KV-cache identical for `fork`), while other children and
 * Relay sessions omit it.
 * @param agent - assembled agent, if any.
 * @param managedRole - persisted or pending role when this agent is our own child.
 * @returns true when the guidance section should be emitted.
 */
export function shouldInjectGuidance(
  agent: Agent | undefined,
  managedRole?: OrchestrationRole,
): boolean {
  if (agent === undefined) return false
  if (isRelayAgent(agent)) return false
  if (managedRole === 'fork') return true
  const header = agent.session.header
  if (header.origin === 'subagent') return false
  try {
    return delegationDepthOf(agent) === 0
  } catch {
    return false
  }
}

function optionalInject(
  ctx: Context,
  deps: readonly string[],
  callback: (scope: Context) => void,
): void {
  const injectFn = ctx.inject as unknown as (
    dependencies: readonly string[],
    fn: (scope: Context) => void,
  ) => unknown
  injectFn.call(ctx, deps, callback)
}

/**
 * Install the host bundle: one tool, one root policy section, and telemetry.
 * @param ctx - host context owning the bundle's registrations.
 * @param config - Loader row configuration (plain or Cordis `Volatile`-backed).
 */
export function apply(ctx: Context, config: PluginConfigInput = {}): void {
  const initial = resolveOrchestrationConfig(config)
  let cachedConfig: ResolvedConfig = initial
  let cachedInputs: readonly unknown[] | undefined
  const currentConfig = (): ResolvedConfig => {
    const plain = unwrapPluginConfig(config)
    const inputs = [
      plain.exploreProvider,
      plain.exploreModel,
      plain.models,
      plain.budgets,
      plain.reminders,
      process.env.DSH_ROLES_EXPLORE_PROVIDER,
      process.env.DSH_ROLES_EXPLORE_MODEL,
      process.env.DSH_ROLES_MODELS,
      process.env.DSH_ROLES_BUDGETS,
      process.env.DSH_ROLES_REMINDERS,
    ]
    if (
      cachedInputs !== undefined
      && inputs.every((value, index) => Object.is(value, cachedInputs![index]))
    ) {
      return cachedConfig
    }
    try {
      cachedConfig = resolveOrchestrationConfig(plain)
      cachedInputs = inputs
    } catch (error) {
      ctx.logger.warn('ignoring invalid live dsh-roles config update: %s', error instanceof Error ? error.message : String(error))
    }
    return cachedConfig
  }
  const pending = new Map<string, PendingChild>()
  const convergedRestrictions = new Map<string, () => void>()
  const trackedProviders = new Set<string>()
  const coordinator = new WorkerWriteCoordinator()
  let boundScope: Context | undefined
  let worktreeService: WorktreeServiceLike | undefined
  const managedRoleOf = (agent: Agent | undefined): OrchestrationRole | undefined => {
    if (agent === undefined) return undefined
    return pending.get(agent.id)?.state.role ?? readChildPolicy(agent.session)?.role
  }

  const settleState = (state: DelegationState, stopReason: string): void => {
    const child = pending.get(state.childId)
    if (child !== undefined) {
      pending.delete(state.childId)
      child.releaseWriteReservation?.()
    }
    if (state.settled) return
    const record = settleDelegation(state, stopReason, Date.now())
    ctx.logger.info('%s%s', TELEMETRY_LOG_PREFIX, JSON.stringify(record))
  }

  const releaseConvergedRestriction = (agentId: string): void => {
    const disposeRestriction = convergedRestrictions.get(agentId)
    if (disposeRestriction === undefined) return
    convergedRestrictions.delete(agentId)
    disposeRestriction()
  }

  const agentsService = (target: Context): { get?(id: string): Agent | undefined; list?(): Agent[] } | undefined =>
    (target as unknown as { get?(key: string): { get?(id: string): Agent | undefined; list?(): Agent[] } | undefined }).get?.('agents')

  // On plain DSH hosts without a host-level preset filter, converge bare `subagent` /
  // `subagent_fork` / `subagent_oar` whenever `orchestrate_subagent` is exposed (including
  // forked children so their declared tool list matches the parent byte-for-byte for KV-cache reuse).
  const convergeBareDelegation = (agent: Agent): void => {
    releaseConvergedRestriction(agent.id)
    const managedRole = managedRoleOf(agent)
    if (!orchestrationToolVisible(agent, managedRole)) return
    if (typeof agent.ctx?.tools?.definitions !== 'function' || typeof agent.ctx?.tools?.restrict !== 'function') return
    const known = new Set(agent.ctx.tools.definitions(scopeParentOf(agent)).map(definition => definition.name))
    const deny = BARE_DELEGATION_TOOLS.filter(toolName => known.has(toolName))
    if (deny.length === 0) return
    convergedRestrictions.set(agent.id, agent.ctx.tools.restrict({ deny }))
    agent.ctx.effect?.(() => () => { convergedRestrictions.delete(agent.id) })
  }

  ctx.effect(() => {
    const removeRegistration = (): void => {
      for (const child of pending.values()) child.releaseWriteReservation?.()
      pending.clear()
      for (const agentId of [...convergedRestrictions.keys()]) releaseConvergedRestriction(agentId)
    }
    return removeRegistration
  }, 'dsh-roles: lifecycle')

  // Optionally bind DSH's official `@deepseek-ai/dsh-experimental-worktree` service when installed.
  optionalInject(ctx, ['worktrees'], (scope) => {
    const service = (scope as unknown as { worktrees?: WorktreeServiceLike }).worktrees
    if (typeof service?.create !== 'function') return
    worktreeService = service
    scope.effect(() => () => {
      if (worktreeService === service) worktreeService = undefined
    }, 'dsh-roles: worktrees')
  })

  // Suppress DSH's auto-generated settings form so our custom `plugins.bundle.config` page renders.
  optionalInject(ctx, ['settings'], (scope) => {
    const settings = (scope as unknown as {
      settings?: { configure?(presentation: { auto?: boolean }, owner?: unknown): () => void }
    }).settings
    if (typeof settings?.configure !== 'function') return
    scope.effect(() => settings.configure!({ auto: false }, ctx.fiber), 'dsh-roles: settings presentation')
  })

  // Expose live external subagent providers (`oar-*`, `codex`, etc.) to the browser settings UI.
  optionalInject(ctx, ['connection'], (scope) => {
    const connection = (scope as unknown as {
      connection?: {
        rpc?: {
          handle(
            channel: string,
            handler: (operation: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
          ): () => Promise<void> | void
        }
      }
    }).connection
    if (typeof connection?.rpc?.handle !== 'function') return
    scope.effect(() => connection.rpc!.handle('/dsh-roles', async (operation) => {
      if (operation !== 'options') {
        return { ok: false, error: { code: 'not-found', message: `Unknown operation: ${operation}`, details: {} } }
      }
      const cfg = currentConfig()
      const hostCtx = boundScope ?? ctx
      const externalProviders = listExternalSubagentProviders(hostCtx, cfg, trackedProviders)
      return {
        ok: true,
        value: {
          externalProviders,
        },
      }
    }), 'dsh-roles: rpc')
  })

  // Hide the bundle's internal presets from user-facing mode selectors on any DSH host.
  optionalInject(ctx, ['agentPresets'], (scope) => {
    const registry = (scope as unknown as {
      agentPresets?: {
        defaultId?: string
        list(): Promise<Array<{ readonly id: string }>>
      }
    }).agentPresets
    if (registry === undefined || typeof registry.list !== 'function') return
    let active = true
    const originalList = registry.list
    const filteredList = async function (this: typeof registry) {
      const rows = await originalList.call(this)
      return active ? rows.filter(row => !hiddenOrchestrationPreset(row.id) || row.id === this.defaultId) : rows
    }
    registry.list = filteredList
    scope.effect(() => () => {
      active = false
      if (registry.list === filteredList) registry.list = originalList
    }, 'dsh-roles: preset visibility')
  })

  // `ctx.inject` resolves the host service instances the Agent actually
  // consumes; a plain `ctx.tools` from a bundle-layer row can point at a
  // different service copy in composed profiles.
  ctx.inject(['tools', 'subagents', 'systemPrompt'], (scope) => {
    boundScope = scope
    const antigravityFallback = registerAntigravityOarFallback(scope)
    const toolDefinition = createOrchestrationTool(scope, {
      get config() { return currentConfig() },
      coordinator,
      registerChild: (childId, child) => { pending.set(childId, child) },
      releaseChild: (childId) => { pending.delete(childId) },
      retainWriteReservation: (childId, release) => {
        const child = pending.get(childId)
        if (child === undefined) release()
        else child.releaseWriteReservation = release
      },
      settleExternalChild: settleState,
      managedRoleOf,
      getWorktreeService: () => worktreeService,
      isVisible: agent => orchestrationToolVisible(agent, managedRoleOf(agent)),
    })
    const unregister = scope.tools.register(toolDefinition, {
      when: ({ agent }) => orchestrationToolVisible(agent, managedRoleOf(agent)),
    })
    const removeReminders = installDelegationReminders(scope, {
      tool: toolDefinition,
      isEligibleRoot: agent => managedRoleOf(agent) === undefined && shouldInjectGuidance(agent, undefined),
      getConfig: currentConfig,
    })
    const removeSection = scope.systemPrompt.section({
      name: GUIDANCE_SECTION_NAME,
      order: scope.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
      text: context => shouldInjectGuidance(context.agent, managedRoleOf(context.agent))
        ? formatRootSchedulingGuidance(currentConfig().models)
        : '',
    })
    for (const agent of agentsService(scope)?.list?.() ?? []) convergeBareDelegation(agent)
    scope.effect?.(() => () => {
      removeSection()
      removeReminders()
      unregister()
      antigravityFallback.dispose()
      if (boundScope === scope) boundScope = undefined
    }, 'dsh-roles: host bindings')
  })

  ctx.effect(() => ctx.on('subagent/provider-added', (provider) => {
    trackedProviders.add(provider.name)
  }), 'dsh-roles: provider-added')

  ctx.effect(() => ctx.on('subagent/provider-removed', (providerName) => {
    trackedProviders.delete(providerName)
  }), 'dsh-roles: provider-removed')

  const configurePendingChild = (agent: Agent, child: PendingChild, resolved: ResolvedConfig): void => {
    commitChildPolicy(agent.session, {
      version: 1,
      role: child.state.role,
      thoroughness: child.state.thoroughness,
      includeMcp: child.includeMcp,
      ...(child.readOnly ? { readOnly: true } : {}),
      ...(child.isolation === 'worktree' ? { isolation: child.isolation } : {}),
      ...(child.writeScopes === undefined ? {} : { writeScopes: child.writeScopes.map(scope => scope.prefix) }),
    })
    isolateRoleTools(agent, child.state.role, { includeMcp: child.includeMcp, readOnly: child.readOnly })
    if (child.state.role === 'fork') convergeBareDelegation(agent)
    if (child.state.role === 'general-purpose' && child.writeScopes !== undefined) {
      enforceWriteScope(agent, child.writeScopes, effectiveSessionCwd(agent.session, process.cwd()))
    }
    installStepBudget(agent, child.state.role, child.state.thoroughness, resolved, {
      onBudgetExhausted: () => { child.state.budgetExhausted = true },
    })
  }

  ctx.effect(() => ctx.on('agent/created', ({ agent, source, signal }) => {
    const resolved = currentConfig()
    const child = pending.get(agent.id)
    if (child !== undefined) {
      if (child.worktreeRequest !== undefined && child.worktree === undefined && (source === 'startup' || source === undefined)) {
        return (async () => {
          if (worktreeService === undefined) {
            throw new Error(
              'isolation "worktree" requires @deepseek-ai/dsh-experimental-worktree, which is no longer available.',
            )
          }
          const created = await worktreeService.create(
            agent,
            child.worktreeRequest!.branchName === undefined ? {} : { name: child.worktreeRequest!.branchName },
            signal,
          )
          child.worktree = created
          configurePendingChild(agent, child, resolved)
          return undefined
        })()
      }
      configurePendingChild(agent, child, resolved)
      return undefined
    }
    const restored = readChildPolicy(agent.session)
    if (restored !== undefined) {
      isolateRoleTools(agent, restored.role, { includeMcp: restored.includeMcp, readOnly: restored.readOnly })
      if (restored.role === 'fork') convergeBareDelegation(agent)
      if (restored.role === 'general-purpose' && restored.writeScopes !== undefined) {
        enforceWriteScope(
          agent,
          normalizeWriteScopes(restored.writeScopes)!,
          agent.session.header?.cwd ?? effectiveSessionCwd(agent.session, process.cwd()),
        )
      }
      installStepBudget(agent, restored.role, restored.thoroughness, resolved)
      return undefined
    }
    convergeBareDelegation(agent)
    return undefined
  }), 'dsh-roles: agent-created')

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if ((event as { readonly type: string }).type === 'agent-preset/selected') {
      const agent = agentsService(boundScope ?? ctx)?.get?.(session.id)
      if (agent !== undefined) convergeBareDelegation(agent)
      return
    }
    const child = pending.get(session.id)
    if (child === undefined) return
    if (event.type === 'step/start') observeStep(child.state, event.data.step)
    else if (event.type === 'assistant/message') addUsage(child.state.usage, event.data.usage)
  }), 'dsh-roles: telemetry-events')

  ctx.effect(() => ctx.on('subagent/end', (info) => {
    const child = pending.get(info.id)
    if (child === undefined) return
    if (child.worktree !== undefined && child.state.delivery === 'parent') {
      const succeeded = info.stopReason === 'completed'
        || (info.stopReason === 'refusal' && child.state.budgetExhausted)
      void settleChildWorktree(child, succeeded).then((outcome) => {
        if (outcome === undefined) return
        ctx.logger.info(
          'worktree finalized: child=%s branch=%s status=%s cleanedUp=%s',
          info.id,
          outcome.branch,
          outcome.status,
          outcome.cleanedUp,
        )
      })
    }
    settleState(child.state, info.stopReason)
  }), 'dsh-roles: telemetry-end')

  ctx.logger.info(
    'ready: tool=%s models=%s budgets=%s reminders=%s',
    ORCHESTRATION_TOOL_NAME,
    JSON.stringify(initial.models),
    JSON.stringify(initial.budgets),
    JSON.stringify(initial.reminders),
  )
}
