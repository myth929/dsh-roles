/**
 * Preset resolution for an Agent whose Session was created under one preset
 * and later switched before the first turn. The durable creation header keeps
 * the initial preset, so the live composition, the folded session projection,
 * and `agent-preset/selected` events take precedence over `header.agentPreset`.
 * @module dsh-orchestration/relay
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

interface PresetRoster {
  presetForSession?(session: unknown): string | null
  composedPreset?(ctx: unknown): string | undefined
}

function nonEmptyPreset(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Resolve the Agent's current effective preset, preferring the live mounted
 * composition and folded session selection over the immutable creation header.
 * @param agent - live agent preparing a step.
 * @returns the active preset id, if any.
 */
export function effectiveAgentPreset(agent: Agent): string | undefined {
  let presets: PresetRoster | undefined
  try {
    presets = agent.ctx?.get?.('agentPresets') as PresetRoster | undefined
  } catch {
    presets = undefined
  }
  try {
    const composed = nonEmptyPreset(presets?.composedPreset?.(agent.ctx))
    if (composed !== undefined) return composed
  } catch {
    // A composition failure falls back to the folded session projection.
  }
  try {
    const projected = nonEmptyPreset(presets?.presetForSession?.(agent.session))
    if (projected !== undefined) return projected
  } catch {
    // A projection failure falls back to session events and creation header.
  }
  if (typeof agent.session.snapshotEvents === 'function') {
    const events = agent.session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as { readonly type?: unknown; readonly data?: { readonly agentPreset?: unknown } } | undefined
      if (event?.type === 'agent-preset/selected') {
        const selected = nonEmptyPreset(event.data?.agentPreset)
        if (selected !== undefined) return selected
      }
    }
  }
  return nonEmptyPreset(agent.session.header.agentPreset)
}

/**
 * Whether an Agent is currently running a Relay-backed preset.
 * @param agent - live agent preparing a step.
 * @returns true when the effective preset is a `relay-*` mode.
 */
export function isRelayAgent(agent: Agent): boolean {
  const preset = effectiveAgentPreset(agent)
  return preset !== undefined && preset.startsWith('relay-')
}
