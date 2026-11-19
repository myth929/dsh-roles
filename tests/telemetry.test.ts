import { describe, expect, it } from 'vitest'
import {
  addUsage,
  observeStep,
  parseTelemetryLines,
  settleDelegation,
  startDelegation,
  summarizeDelegations,
} from '../src/telemetry.js'

function begun() {
  return startDelegation({
    role: 'explore',
    thoroughness: 'quick',
    delivery: 'caller',
    provider: 'spawn',
    childId: 'child-1',
    startedAt: 1000,
  })
}

describe('delegation telemetry', () => {
  it('keeps unreported counters null and refuses to estimate them', () => {
    const state = begun()
    addUsage(state.usage, { inputTokens: 120, outputTokens: 30 })
    addUsage(state.usage, { inputTokens: 80 })
    expect(state.usage).toEqual({ inputTokens: 200, outputTokens: 30, cacheReadTokens: null, cacheWriteTokens: null })
  })

  it('records real cache counters when the transport reports them', () => {
    const state = begun()
    addUsage(state.usage, { inputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 100, outputTokens: 5 })
    const record = settleDelegation(state, 'completed', 3500)
    expect(record).toMatchObject({ wallMs: 2500, stopReason: 'completed', steps: 0 })
    expect(record.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 100 })
  })

  it('tracks the highest admitted step', () => {
    const state = begun()
    observeStep(state, 1)
    observeStep(state, undefined)
    observeStep(state, 3)
    observeStep(state, 2)
    expect(state.steps).toBe(3)
    expect(settleDelegation(state, 'completed', 1001).steps).toBe(3)
  })

  it('aggregates records and preserves incomplete usage', () => {
    const first = settleDelegation(begun(), 'completed', 1500)
    const secondState = begun()
    addUsage(secondState.usage, { inputTokens: 50, outputTokens: 10 })
    const second = settleDelegation(secondState, 'refusal', 2500)
    const summary = summarizeDelegations([first, second])
    expect(summary.count).toBe(2)
    expect(summary.wallMs).toBe(2000)
    expect(summary.stopReasons).toEqual({ completed: 1, refusal: 1 })
    expect(summary.usage).toEqual({ inputTokens: 50, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null })
  })

  it('parses only well-formed telemetry log lines', () => {
    const record = settleDelegation(begun(), 'completed', 2000)
    const text = [
      'noise',
      `2026-11-17 [dsh-orchestration] telemetry ${JSON.stringify(record)}`,
      '2026-11-17 [dsh-orchestration] telemetry {"truncated":',
    ].join('\n')
    expect(parseTelemetryLines(text)).toHaveLength(1)
    expect(parseTelemetryLines(text)[0]?.childId).toBe('child-1')
  })
})
