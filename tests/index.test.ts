import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  GUIDANCE_SECTION_NAME,
  hiddenOrchestrationPreset,
  ORCHESTRATION_PRESETS,
  shouldInjectGuidance,
} from '../src/index.js'

function agent(header: Record<string, unknown> = {}, depth?: number): Agent {
  return {
    id: 'agent',
    options: depth === undefined ? {} : { subagentDepth: depth },
    session: { id: 'agent', header: { version: 4, id: 'agent', createdAt: 0, isSeeded: false, ...header } },
  } as unknown as Agent
}

describe('root scheduling guidance', () => {
  it('is injected for a native root and managed fork, never for fresh roles or Relay', () => {
    expect(shouldInjectGuidance(agent())).toBe(true)
    expect(shouldInjectGuidance(undefined)).toBe(false)
    expect(shouldInjectGuidance(agent({}, 1))).toBe(false)
    expect(shouldInjectGuidance(agent({ delegationDepth: 1, origin: 'subagent' }))).toBe(false)
    expect(shouldInjectGuidance(agent({ delegationDepth: 1, origin: 'subagent' }), 'fork')).toBe(true)
    expect(shouldInjectGuidance(agent({ delegationDepth: 1, origin: 'subagent' }), 'explore')).toBe(false)
    expect(shouldInjectGuidance(agent({ delegationDepth: 1, origin: 'subagent' }), 'plan')).toBe(false)
    expect(shouldInjectGuidance(agent({ delegationDepth: 1, origin: 'subagent' }), 'general-purpose')).toBe(false)
    expect(shouldInjectGuidance(agent({ delegationDepth: 1, origin: 'subagent' }), 'dsh-code-guide')).toBe(false)
    expect(shouldInjectGuidance(agent({ agentPreset: 'relay-codex' }))).toBe(false)
    expect(shouldInjectGuidance(agent({ agentPreset: 'relay-claude' }), 'fork')).toBe(false)
    const relaySwitchedToStandard = {
      ...agent({ agentPreset: 'relay-antigravity' }),
      ctx: { get: (name: string) => name === 'agentPresets' ? { composedPreset: () => 'standard', presetForSession: () => 'standard' } : undefined },
    } as unknown as Agent
    expect(shouldInjectGuidance(relaySwitchedToStandard)).toBe(true)
    expect(shouldInjectGuidance(relaySwitchedToStandard, 'fork')).toBe(true)
  })

  it('uses a stable section name so replays keep the same prefix', () => {
    expect(GUIDANCE_SECTION_NAME).toBe('dsh-orchestration:guidance')
  })

  it('identifies all 4 internal orchestration presets so mode selectors hide them', () => {
    expect(ORCHESTRATION_PRESETS).toEqual([
      'dsh-orchestration-general-purpose',
      'dsh-orchestration-explore',
      'dsh-orchestration-plan',
      'dsh-orchestration-guide',
    ])
    for (const preset of ORCHESTRATION_PRESETS) expect(hiddenOrchestrationPreset(preset)).toBe(true)
    expect(hiddenOrchestrationPreset('standard')).toBe(false)
    expect(hiddenOrchestrationPreset('cordis')).toBe(false)
  })
})
