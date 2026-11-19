/**
 * `dsh-orchestration`: a standalone DSH bundle that exposes one role-layered
 * delegation tool with per-role context slimming, bounded steps, write-scope
 * enforcement, per-role model/provider routing, and real delegation telemetry.
 * @module dsh-orchestration
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { registerAntigravityOarFallback } from './antigravity.js'
import {
  Config as PluginConfigSchema,
  resolveOrchestrationConfig,
} from './config.js'
import type { OrchestrationRole, PluginConfigInput, ResolvedConfig } from './config.js'
import { hasOfficialOarProviders, listExternalSubagentProviders } from './guide.js'
import { isRelayAgent } from './relay.js'
import { ROOT_SCHEDULING_GUIDANCE } from './roles.js'
import { commitChildPolicy, enforceWriteScope, installStepBudget, isolateRoleTools, readChildPolicy } from './runtime.js'
import { effectiveSessionCwd, normalizeWriteScopes, WorkerWriteCoordinator } from './scope.js'
import { addUsage, observeStep, settleDelegation, TELEMETRY_LOG_PREFIX } from './telemetry.js'
import type { DelegationState } from './telemetry.js'
import { createOrchestrationTool, orchestrationToolVisible, ORCHESTRATION_TOOL_NAME } from './tool.js'
import type { PendingChild } from './tool.js'

export const name = 'dsh-orchestration'
export const inject = ['tools', 'subagents', 'systemPrompt']
export const Config = PluginConfigSchema

/** Stable prompt section name for the root scheduling policy. */
export const GUIDANCE_SECTION_NAME = 'dsh-orchestration:guidance'

/** Internal preset identities mounted for orchestration children; hidden from mode selectors. */
export const ORCHESTRATION_PRESETS = [
  'dsh-orchestration-general-purpose',
  'dsh-orchestration-explore',
  'dsh-orchestration-plan',
  'dsh-orchestration-guide',
] as const
const HIDDEN_ORCHESTRATION_PRESETS = new Set<string>(ORCHESTRATION_PRESETS)
const BARE_DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'subagent_oar'] as const

/**
 * Whether a preset id is an internal execution preset managed by `dsh-orchestration`.
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
): () => void {
  const injectFn = ctx.inject as unknown as (
    dependencies: readonly string[],
    fn: (scope: Context) => void,
  ) => () => void
  return injectFn.call(ctx, deps, callback)
}

/**
 * Install the host bundle: one tool, one root policy section, and telemetry.
 * @param ctx - host context owning the bundle's registrations.
 * @param config - Loader row configuration (plain or Cordis `Volatile`-backed).
 */
export function apply(ctx: Context, config: PluginConfigInput = {}): void {
  const initial = resolveOrchestrationConfig(config)
  const currentConfig = (): ResolvedConfig => resolveOrchestrationConfig(config)
  const pending = new Map<string, PendingChild>()
  const convergedRestrictions = new Map<string, () => void>()
  const trackedProviders = new Set<string>()
  const coordinator = new WorkerWriteCoordinator()
  let boundScope: Context | undefined
  let builtinAntigravityActive = false
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
  }, 'dsh-orchestration: lifecycle')

  // Suppress DSH's auto-generated settings form so our custom `plugins.bundle.config` page renders.
  ctx.effect(() => optionalInject(ctx, ['settings'], (scope) => {
    const settings = (scope as unknown as {
      settings?: { configure?(presentation: { auto?: boolean }, owner?: unknown): () => void }
    }).settings
    if (typeof settings?.configure !== 'function') return
    scope.effect(() => settings.configure!({ auto: false }, ctx.fiber), 'dsh-orchestration: settings presentation')
  }), 'dsh-orchestration: settings presentation')

  // Expose live external subagent providers (`oar-*`, `codex`, etc.) and official OAR availability to the browser settings UI.
  ctx.effect(() => optionalInject(ctx, ['connection'], (scope) => {
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
    scope.effect(() => connection.rpc!.handle('/dsh-orchestration', async (operation) => {
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
          officialOarInstalled: hasOfficialOarProviders(hostCtx, externalProviders, builtinAntigravityActive),
        },
      }
    }), 'dsh-orchestration: rpc')
  }), 'dsh-orchestration: rpc')

  // Hide the bundle's internal presets from user-facing mode selectors on any DSH host.
  ctx.effect(() => optionalInject(ctx, ['agentPresets'], (scope) => {
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
    }, 'dsh-orchestration: preset visibility')
  }), 'dsh-orchestration: preset visibility')

  // `ctx.inject` resolves the host service instances the Agent actually
  // consumes; a plain `ctx.tools` from a bundle-layer row can point at a
  // different service copy in composed profiles.
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    ctx.inject(['tools', 'subagents', 'systemPrompt'], (scope) => {
      boundScope = scope
      const antigravityFallback = registerAntigravityOarFallback(scope)
      builtinAntigravityActive = antigravityFallback.registered
      const unregister = scope.tools.register(createOrchestrationTool(scope, {
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
        isVisible: agent => orchestrationToolVisible(agent, managedRoleOf(agent)),
      }), {
        when: ({ agent }) => orchestrationToolVisible(agent, managedRoleOf(agent)),
      })
      const removeSection = scope.systemPrompt.section({
        name: GUIDANCE_SECTION_NAME,
        order: scope.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
        text: context => shouldInjectGuidance(context.agent, managedRoleOf(context.agent)) ? ROOT_SCHEDULING_GUIDANCE : '',
      })
      for (const agent of agentsService(scope)?.list?.() ?? []) convergeBareDelegation(agent)
      dispose = () => {
        removeSection()
        unregister()
        antigravityFallback.dispose()
        builtinAntigravityActive = false
        if (boundScope === scope) boundScope = undefined
      }
    })
    return () => dispose?.()
  }, 'dsh-orchestration: host bindings')

  ctx.effect(() => ctx.on('subagent/provider-added', (provider) => {
    trackedProviders.add(provider.name)
  }), 'dsh-orchestration: provider-added')

  ctx.effect(() => ctx.on('subagent/provider-removed', (providerName) => {
    trackedProviders.delete(providerName)
  }), 'dsh-orchestration: provider-removed')

  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    const resolved = currentConfig()
    const child = pending.get(agent.id)
    if (child !== undefined) {
      commitChildPolicy(agent.session, {
        version: 1,
        role: child.state.role,
        thoroughness: child.state.thoroughness,
        includeMcp: child.includeMcp,
        ...(child.writeScopes === undefined ? {} : { writeScopes: child.writeScopes.map(scope => scope.prefix) }),
      })
      isolateRoleTools(agent, child.state.role, { includeMcp: child.includeMcp })
      if (child.state.role === 'fork') convergeBareDelegation(agent)
      if (child.state.role === 'general-purpose' && child.writeScopes !== undefined) {
        enforceWriteScope(agent, child.writeScopes, effectiveSessionCwd(agent.session, process.cwd()))
      }
      installStepBudget(agent, child.state.role, child.state.thoroughness, resolved, {
        onBudgetExhausted: () => { child.state.budgetExhausted = true },
      })
      return undefined
    }
    const restored = readChildPolicy(agent.session)
    if (restored !== undefined) {
      isolateRoleTools(agent, restored.role, { includeMcp: restored.includeMcp })
      if (restored.role === 'fork') convergeBareDelegation(agent)
      if (restored.role === 'general-purpose' && restored.writeScopes !== undefined) {
        enforceWriteScope(agent, normalizeWriteScopes(restored.writeScopes)!, effectiveSessionCwd(agent.session, process.cwd()))
      }
      installStepBudget(agent, restored.role, restored.thoroughness, resolved)
      return undefined
    }
    convergeBareDelegation(agent)
    return undefined
  }), 'dsh-orchestration: agent-created')

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if ((event as { readonly type: string }).type === 'agent-preset/selected') {
      const agent = agentsService(ctx)?.get?.(session.id)
      if (agent !== undefined) convergeBareDelegation(agent)
      return
    }
    const child = pending.get(session.id)
    if (child === undefined) return
    if (event.type === 'step/start') observeStep(child.state, event.data.step)
    else if (event.type === 'assistant/message') addUsage(child.state.usage, event.data.usage)
  }), 'dsh-orchestration: telemetry-events')

  ctx.effect(() => ctx.on('subagent/end', (info) => {
    const child = pending.get(info.id)
    if (child === undefined) return
    settleState(child.state, info.stopReason)
  }), 'dsh-orchestration: telemetry-end')

  ctx.logger.info(
    'ready: tool=%s models=%s budgets=%s',
    ORCHESTRATION_TOOL_NAME,
    JSON.stringify(initial.models),
    JSON.stringify(initial.budgets),
  )
}
