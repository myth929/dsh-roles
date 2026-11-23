/**
 * Benchmark aggregation over durable session events plus delegation telemetry.
 *
 * The scanner is intentionally model-agnostic: it reads only `time`,
 * `type === 'assistant/message'` usage, and `orchestrate_subagent` tool calls,
 * so a baseline run (plugin disabled) and an enabled run can be compared with
 * the same code path.
 * @module dsh-roles/benchmark
 */

import { zstdDecompressSync } from 'node:zlib'
import type { DelegationRecord, DelegationSummary, DelegationUsage } from './telemetry.js'
import { summarizeDelegations } from './telemetry.js'

const ZSTD_MAGIC = 0xfd2fb528

/** Parse JSONL text into event objects, skipping torn tail lines. */
export function parseSessionText(text: string): unknown[] {
  const events: unknown[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A torn tail line is not an event.
    }
  }
  return events
}

/**
 * Decode a session artifact: plain JSONL, or the concatenated Zstandard frames
 * the JSONL persistence backend appends (one frame per header/batch).
 * @param buffer - complete artifact bytes.
 * @returns parsed event objects from every complete frame.
 */
export function decodeSessionLog(buffer: Buffer): unknown[] {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) {
    return parseSessionText(buffer.toString('utf8'))
  }
  const events: unknown[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5) break
    const descriptor = buffer.readUInt8(offset + 4)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return events
      const header = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (header & 1) !== 0
      const blockType = (header >>> 1) & 0x03
      const blockSize = header >>> 3
      offset += blockType === 0x01 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    if (offset > buffer.length) return events
    try {
      events.push(...parseSessionText(zstdDecompressSync(buffer.subarray(start, offset)).toString('utf8')))
    } catch {
      return events
    }
  }
  return events
}

/** Aggregate facts extracted from one or more sessions. */
export interface SessionScan {
  readonly sessions: number
  readonly requests: number
  readonly delegationCalls: number
  readonly wallMs: number
  readonly usage: DelegationUsage
}

/** Side-by-side comparison for one sample task. */
export interface BenchmarkComparison {
  readonly baseline: SessionScan
  readonly enabled: SessionScan
  readonly delegations: DelegationSummary
  readonly inputTokenDelta: number | null
  readonly wallMsDelta: number | null
}

function emptyUsage(): DelegationUsage {
  return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }
}

function eventRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function ownEventsOf(events: readonly unknown[]): readonly unknown[] {
  let endSeedIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (eventRecord(events[index])?.type === 'session/end-seed') {
      endSeedIndex = index
      break
    }
  }
  return endSeedIndex >= 0 ? events.slice(endSeedIndex + 1) : events
}

function mergedWallMs(intervals: readonly (readonly [number, number])[]): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((left, right) => left[0] - right[0] || left[1] - right[1])
  let total = 0
  let [curStart, curEnd] = sorted[0]!
  for (let index = 1; index < sorted.length; index += 1) {
    const [nextStart, nextEnd] = sorted[index]!
    if (nextStart <= curEnd) {
      curEnd = Math.max(curEnd, nextEnd)
    } else {
      total += Math.max(0, curEnd - curStart)
      curStart = nextStart
      curEnd = nextEnd
    }
  }
  return total + Math.max(0, curEnd - curStart)
}

/**
 * Scan parsed session events (one iterable per session).
 * Forked child logs drop events at or before `session/end-seed` so inherited
 * parent turns are never double-counted; overlapping session time spans are
 * merged into true wall-clock duration rather than summed serially.
 * @param sessions - each session's event objects in append order.
 * @returns request, delegation, token, and wall-clock totals.
 */
export function scanSessionLogs(sessions: Iterable<readonly unknown[]>): SessionScan {
  let sessionCount = 0
  let requests = 0
  let delegationCalls = 0
  const intervals: Array<readonly [number, number]> = []
  const usage = emptyUsage()
  for (const events of sessions) {
    sessionCount += 1
    let first: number | undefined
    let last: number | undefined
    for (const raw of ownEventsOf(events)) {
      const event = eventRecord(raw)
      if (event === undefined) continue
      const time = event.time
      if (typeof time === 'number' && Number.isFinite(time)) {
        first ??= time
        last = Math.max(last ?? time, time)
      }
      const data = eventRecord(event.data)
      if (event.type === 'assistant/message') {
        requests += 1
        const reported = data?.usage
        if (reported !== null && typeof reported === 'object') {
          const source = reported as Record<string, unknown>
          for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
            const value = source[field]
            if (typeof value === 'number' && Number.isFinite(value)) {
              usage[field] = (usage[field] ?? 0) + value
            }
          }
        }
      }
      if (event.type === 'tool/call' && data?.name === 'orchestrate_subagent') delegationCalls += 1
    }
    if (first !== undefined && last !== undefined) intervals.push([first, last])
  }
  return Object.freeze({ sessions: sessionCount, requests, delegationCalls, wallMs: mergedWallMs(intervals), usage: Object.freeze(usage) })
}

/**
 * Compare a baseline scan with an enabled scan.
 * @param baseline - plugin-disabled run.
 * @param enabled - plugin-enabled run.
 * @param records - settled delegation telemetry from the enabled run.
 * @returns deltas and the delegation summary.
 */
export function compareBenchmarks(
  baseline: SessionScan,
  enabled: SessionScan,
  records: readonly DelegationRecord[],
): BenchmarkComparison {
  const delta = (left: number | null, right: number | null): number | null =>
    left === null || right === null ? null : right - left
  return Object.freeze({
    baseline,
    enabled,
    delegations: summarizeDelegations(records),
    inputTokenDelta: delta(baseline.usage.inputTokens, enabled.usage.inputTokens),
    wallMsDelta: delta(baseline.wallMs, enabled.wallMs),
  })
}

function show(value: number | null, unit = ''): string {
  return value === null ? 'n/a' : `${value}${unit}`
}

/**
 * Render a human-readable comparison table.
 * @param comparison - result of {@link compareBenchmarks}.
 * @returns a compact report with one line per metric.
 */
export function formatBenchmarkReport(comparison: BenchmarkComparison): string {
  const { baseline, enabled, delegations } = comparison
  const lines = [
    '| metric | baseline | orchestration | delta |',
    '| --- | ---: | ---: | ---: |',
    `| requests | ${baseline.requests} | ${enabled.requests} | ${enabled.requests - baseline.requests} |`,
    `| input tokens | ${show(baseline.usage.inputTokens)} | ${show(enabled.usage.inputTokens)} | ${show(comparison.inputTokenDelta)} |`,
    `| cache read tokens | ${show(baseline.usage.cacheReadTokens)} | ${show(enabled.usage.cacheReadTokens)} | ${show(
      baseline.usage.cacheReadTokens === null || enabled.usage.cacheReadTokens === null
        ? null
        : enabled.usage.cacheReadTokens - baseline.usage.cacheReadTokens,
    )} |`,
    `| output tokens | ${show(baseline.usage.outputTokens)} | ${show(enabled.usage.outputTokens)} | ${show(
      baseline.usage.outputTokens === null || enabled.usage.outputTokens === null
        ? null
        : enabled.usage.outputTokens - baseline.usage.outputTokens,
    )} |`,
    `| wall ms | ${baseline.wallMs} | ${enabled.wallMs} | ${show(comparison.wallMsDelta)} |`,
    `| delegations | ${baseline.delegationCalls} | ${enabled.delegationCalls} | ${enabled.delegationCalls - baseline.delegationCalls} |`,
    '',
    `Delegation records: ${delegations.count}; steps ${delegations.steps}; wall ${delegations.wallMs} ms; stop reasons ${JSON.stringify(delegations.stopReasons)}.`,
  ]
  return lines.join('\n')
}
