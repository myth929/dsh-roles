/**
 * Lightweight delegation telemetry: accumulate only values the transport
 * actually reported, and summarize settled records for benchmark reports.
 * @module dsh-orchestration/telemetry
 */

import type { OrchestrationRole, Thoroughness } from './config.js'

/** Observed token counters; a field stays `null` until a source reports it. */
export interface DelegationUsage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}

/** One settled delegation record. */
export interface DelegationRecord {
  readonly role: OrchestrationRole
  readonly thoroughness: Thoroughness
  readonly delivery: 'caller' | 'parent'
  readonly provider: string
  readonly childId: string
  readonly startedAt: number
  readonly wallMs: number
  readonly steps: number
  readonly stopReason: string
  readonly usage: DelegationUsage
}

/** Aggregate view used by reports. */
export interface DelegationSummary {
  readonly count: number
  readonly steps: number
  readonly wallMs: number
  readonly stopReasons: Readonly<Record<string, number>>
  readonly usage: DelegationUsage
}

/** Mutable accumulator owned by one in-flight delegation. */
export interface DelegationState {
  readonly role: OrchestrationRole
  readonly thoroughness: Thoroughness
  readonly delivery: 'caller' | 'parent'
  readonly provider: string
  childId: string
  readonly startedAt: number
  steps: number
  readonly usage: DelegationUsage
  settled: boolean
  budgetExhausted: boolean
}

/**
 * Create one in-flight record state.
 * @param input - role, delivery, provider, child identity, and start time.
 * @returns mutable accumulator with no observed usage yet.
 */
export function startDelegation(input: {
  role: OrchestrationRole
  thoroughness: Thoroughness
  delivery: 'caller' | 'parent'
  provider: string
  childId: string
  startedAt: number
}): DelegationState {
  return {
    ...input,
    steps: 0,
    settled: false,
    budgetExhausted: false,
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
  }
}

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const

/**
 * Add one reported usage object without inventing missing counters.
 * @param usage - accumulator to update.
 * @param reported - transport-reported usage, if any.
 */
export function addUsage(usage: DelegationUsage, reported: unknown): void {
  if (reported === null || typeof reported !== 'object') return
  const source = reported as Record<string, unknown>
  for (const field of USAGE_FIELDS) {
    const value = source[field]
    if (typeof value === 'number' && Number.isFinite(value)) {
      usage[field] = (usage[field] ?? 0) + value
    }
  }
}

/**
 * Count one admitted step, keeping the highest step number seen.
 * @param state - in-flight accumulator.
 * @param step - step number from `step/start`.
 */
export function observeStep(state: DelegationState, step: unknown): void {
  if (typeof step === 'number' && Number.isFinite(step)) state.steps = Math.max(state.steps, step)
}

/**
 * Convert a settled accumulator into an immutable record.
 * @param state - settled accumulator.
 * @param stopReason - terminal stop reason reported by the subagent seam.
 * @param endedAt - settlement time.
 * @returns the report record.
 */
export function settleDelegation(state: DelegationState, stopReason: string, endedAt: number): DelegationRecord {
  state.settled = true
  return Object.freeze({
    role: state.role,
    thoroughness: state.thoroughness,
    delivery: state.delivery,
    provider: state.provider,
    childId: state.childId,
    startedAt: state.startedAt,
    wallMs: Math.max(0, endedAt - state.startedAt),
    steps: state.steps,
    stopReason,
    usage: Object.freeze({ ...state.usage }),
  })
}

function emptyUsage(): DelegationUsage {
  return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }
}

function addRecordUsage(target: DelegationUsage, source: DelegationUsage): void {
  for (const field of USAGE_FIELDS) {
    const value = source[field]
    if (value !== null) target[field] = (target[field] ?? 0) + value
  }
}

/**
 * Aggregate delegation records for one report section.
 * @param records - settled records.
 * @returns counts, totals, averages, and stop reasons.
 */
export function summarizeDelegations(records: readonly DelegationRecord[]): DelegationSummary {
  const usage = emptyUsage()
  const stopReasons: Record<string, number> = {}
  let steps = 0
  let wallMs = 0
  for (const record of records) {
    steps += record.steps
    wallMs += record.wallMs
    addRecordUsage(usage, record.usage)
    stopReasons[record.stopReason] = (stopReasons[record.stopReason] ?? 0) + 1
  }
  return Object.freeze({
    count: records.length,
    steps,
    wallMs,
    stopReasons: Object.freeze(stopReasons),
    usage: Object.freeze(usage),
  })
}

const TELEMETRY_PREFIX = '[dsh-orchestration] telemetry '

/**
 * Extract delegation records from plugin log text.
 * @param text - log content, one record per line after the prefix.
 * @returns parsed records, skipping unrelated or malformed lines.
 */
export function parseTelemetryLines(text: string): DelegationRecord[] {
  const records: DelegationRecord[] = []
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(TELEMETRY_PREFIX)
    if (index < 0) continue
    const candidates = line.slice(index + TELEMETRY_PREFIX.length).trim()
    try {
      const value = JSON.parse(candidates) as unknown
      if (value === null || typeof value !== 'object') continue
      const record = value as Partial<DelegationRecord>
      if (typeof record.role !== 'string' || typeof record.wallMs !== 'number') continue
      if (record.usage === undefined || record.usage === null) continue
      records.push(record as DelegationRecord)
    } catch {
      // A truncated or interleaved log line is not a record.
    }
  }
  return records
}

/** The exact log prefix used to persist one record line. */
export const TELEMETRY_LOG_PREFIX = TELEMETRY_PREFIX
