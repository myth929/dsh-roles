import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { compareBenchmarks, decodeSessionLog, formatBenchmarkReport, parseSessionText, scanSessionLogs } from '../src/benchmark.js'
import { addUsage, settleDelegation, startDelegation } from '../src/telemetry.js'

function assistant(time: number, usage: Record<string, number>) {
  return { type: 'assistant/message', time, data: { usage } }
}

describe('benchmark aggregation', () => {
  it('decodes plain JSONL and concatenated zstd frames from the session backend', () => {
    expect(parseSessionText('{"type":"a"}\nnot json\n')).toEqual([{ type: 'a' }])
    const first = zstdCompressSync(Buffer.from('{"type":"session"}\n'))
    const second = zstdCompressSync(Buffer.from('{"type":"assistant/message","time":2,"data":{"usage":{"inputTokens":5}}}\n'))
    const decoded = decodeSessionLog(Buffer.concat([first, second]))
    expect(decoded).toHaveLength(2)
    expect(decoded[1]).toMatchObject({ type: 'assistant/message' })
    expect(scanSessionLogs([decoded]).requests).toBe(1)
  })

  it('sums reported usage, requests, delegation calls, and wall time per session', () => {
    const scan = scanSessionLogs([
      [
        assistant(1000, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 }),
        { type: 'tool/call', time: 1100, data: { name: 'orchestrate_subagent' } },
        { type: 'tool/call', time: 1200, data: { name: 'read' } },
        assistant(1500, { inputTokens: 50, outputTokens: 10 }),
      ],
      [
        assistant(5000, { inputTokens: 25, outputTokens: 5 }),
        { type: 'tool/call', time: 5600, data: { name: 'orchestrate_subagent' } },
      ],
    ])
    expect(scan).toMatchObject({ sessions: 2, requests: 3, delegationCalls: 2, wallMs: 1100 })
    expect(scan.usage).toEqual({ inputTokens: 175, outputTokens: 35, cacheReadTokens: 80, cacheWriteTokens: null })
  })

  it('skips forked seed events before session/end-seed and merges concurrent wall intervals', () => {
    const scan = scanSessionLogs([
      [
        assistant(1000, { inputTokens: 100, outputTokens: 20 }),
        { type: 'tool/call', time: 1100, data: { name: 'orchestrate_subagent' } },
        assistant(2000, { inputTokens: 50, outputTokens: 10 }),
      ],
      [
        assistant(1000, { inputTokens: 100, outputTokens: 20 }),
        { type: 'session/end-seed', time: 1200, data: { inherited: true } },
        assistant(1300, { inputTokens: 40, outputTokens: 8 }),
        assistant(1800, { inputTokens: 10, outputTokens: 2 }),
      ],
    ])
    expect(scan).toMatchObject({ sessions: 2, requests: 4, delegationCalls: 1, wallMs: 1000 })
    expect(scan.usage).toEqual({ inputTokens: 200, outputTokens: 40, cacheReadTokens: null, cacheWriteTokens: null })
  })

  it('reports null deltas when a transport never reported a counter', () => {
    const baseline = scanSessionLogs([[assistant(0, { inputTokens: 100 })], []])
    const enabled = scanSessionLogs([[assistant(0, { inputTokens: 120 })], []])
    const state = startDelegation({
      role: 'explore',
      thoroughness: 'quick',
      delivery: 'caller',
      provider: 'spawn',
      childId: 'c1',
      startedAt: 0,
    })
    addUsage(state.usage, { inputTokens: 30 })
    const comparison = compareBenchmarks(baseline, enabled, [settleDelegation(state, 'completed', 500)])
    expect(comparison.inputTokenDelta).toBe(20)
    expect(comparison.wallMsDelta).toBe(0)
    const report = formatBenchmarkReport(comparison)
    expect(report).toContain('| input tokens | 100 | 120 | 20 |')
    expect(report).toContain('cache read tokens | n/a')
    expect(report).toContain('Delegation records: 1')
  })
})
