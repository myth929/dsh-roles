/**
 * Built-in temporary `oar-antigravity` subagent provider mirroring DSH's
 * official `@deepseek-ai/dsh-experimental-subagent-oar` contract (`oar-codex` /
 * `oar-claude`), driving `agy acp` (`agy >= 1.5.0`) over stdio NDJSON JSON-RPC.
 *
 * Designed to yield automatically once `@deepseek-ai/dsh-experimental-subagent-oar`
 * upgrades its bundled `@botiverse/oar` and the user configures an official
 * `oar-antigravity` provider row.
 * @module dsh-roles/antigravity
 */

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, posix, win32 } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertPositiveFinite,
  assertUsableCwd,
  NO_START_CAPABILITIES,
  settleRunResult,
  subprocessRunHandle,
} from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'

/** Default provider name registered on `ctx.subagents` to align with `oar-codex` / `oar-claude`. */
export const ANTIGRAVITY_OAR_PROVIDER_NAME = 'oar-antigravity'

/** Minimum `agy` CLI version with native `agy acp` support. */
export const ANTIGRAVITY_MIN_VERSION = Object.freeze([1, 5, 0] as const)

/** Default per-turn timeout (5 minutes) guarding against runaway external ACP runs. */
export const DEFAULT_ANTIGRAVITY_TIMEOUT_MS = 5 * 60 * 1000

const ACP_PROTOCOL_VERSION = 1
const PACKAGE_VERSION: string = (() => {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { readonly version?: unknown }
    if (typeof pkg.version === 'string' && pkg.version.trim() !== '') return pkg.version
  } catch {
    // Fall back when running outside a packaged checkout.
  }
  return '0.0.1'
})()
const HANDSHAKE_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 2_000
const KILL_GRACE_MS = 1_500
const VERSION_TIMEOUT_MS = 10_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

const SENSITIVE_ENV_PATTERN = /(?:^|_)(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)(?:$|_)/iu

/** Runtime configuration for the built-in `oar-antigravity` provider. */
export interface AntigravityOarOptions {
  /** Override the `ctx.subagents` provider name (default `oar-antigravity`). */
  readonly providerName?: string
  /** Optional explicit `agy` executable path (overrides `OAR_ANTIGRAVITY_BIN` / `PATH`). */
  readonly command?: string
  /** Additional native launch arguments appended after `acp --dangerously-skip-permissions --process-per-session`. */
  readonly launchArgs?: readonly string[]
  /** Explicit environment entries merged after scrubbing `DSH_*` and credential-shaped variables. */
  readonly env?: Readonly<Record<string, string | null>>
  /** Optional turn deadline in milliseconds after startup; omitted defaults to {@link DEFAULT_ANTIGRAVITY_TIMEOUT_MS}, `null` disables the timeout. */
  readonly timeoutMs?: number | null
  /** Safe diagnostic sink invoked on failure; must not throw. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
  /** Test seam: override version probing. */
  readonly probeVersion?: (command: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>
  /** Test seam: override default ACP args (`['acp', '--dangerously-skip-permissions', '--process-per-session']`). */
  readonly baseArgs?: readonly string[]
}

type FailureStage = 'installation' | 'startup' | 'turn' | 'abort' | 'dispose'
type FailureCategory = 'not-found' | 'unsupported' | 'cancelled' | 'timeout' | 'protocol' | 'unknown'

const FAILURE_ADVICE: Readonly<Record<FailureStage, string>> = {
  installation: 'Install and authenticate agy CLI (>= 1.5.0) before retrying.',
  startup: 'Check the Antigravity CLI installation, authentication, and launch settings.',
  turn: 'Check the Antigravity runtime and its account before retrying.',
  abort: 'Antigravity did not accept interruption; session disposal was requested.',
  dispose: 'The Antigravity process may still be active; check it before starting another task.',
}

class AntigravityOarFailure extends Error {
  constructor(
    readonly stage: FailureStage,
    readonly category: FailureCategory,
    options?: ErrorOptions,
  ) {
    super(`OAR subagent failure (stage: ${stage}; category: ${category}). ${FAILURE_ADVICE[stage]}`, options)
    this.name = 'AntigravityOarFailure'
  }
}

function reportFailure(options: AntigravityOarOptions, error: AntigravityOarFailure): void {
  try {
    options.onError?.(error, 'error')
  } catch {
    // Diagnostic observer failures must not replace run results or cleanup.
  }
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Parse the first SemVer release line from `agy --version`.
 * @param stdout - raw stdout from `agy --version`.
 * @returns normalized SemVer string or `undefined`.
 */
export function parseAntigravityVersion(stdout: string): string | undefined {
  const line = stdout.trim().split(/\r?\n/u)[0]?.trim() ?? ''
  return /^(\d+\.\d+\.\d+(?:-[A-Za-z\d.-]+)?)$/u.exec(line)?.[1]
}

/**
 * Whether a parsed `agy` version satisfies stable SemVer `>= 1.5.0`.
 * Pre-releases of `1.5.0` (e.g. `1.5.0-rc.1`) do not satisfy `>= 1.5.0`.
 */
export function isSupportedAntigravityVersion(
  version: string | undefined,
  minimum: readonly [number, number, number] = ANTIGRAVITY_MIN_VERSION,
): boolean {
  if (version === undefined) return false
  const match = /^(\d+)\.(\d+)\.(\d+)(-[A-Za-z\d.-]+)?$/u.exec(version)
  if (!match) return false
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])]
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index]
  }
  return match[4] === undefined
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): string | undefined {
  try {
    const resolved = realpathSync(candidate)
    if (!statSync(resolved).isFile()) return undefined
    if (platform !== 'win32') accessSync(resolved, constants.X_OK)
    return resolved
  } catch {
    return undefined
  }
}

function defaultAntigravityCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  const joinPath = platform === 'win32' ? win32.join : posix.join
  const binaryName = platform === 'win32' ? 'agy.exe' : 'agy'
  const sep = platform === 'win32' ? ';' : delimiter
  const candidates: string[] = []
  if (typeof env.PATH === 'string') {
    for (const entry of env.PATH.split(sep)) {
      const trimmed = nonBlank(entry)
      if (trimmed !== undefined) candidates.push(joinPath(trimmed, binaryName))
    }
  }
  if (platform === 'win32') {
    const localAppData = nonBlank(env.LOCALAPPDATA) ?? win32.join(home, 'AppData', 'Local')
    candidates.push(win32.join(localAppData, 'agy', 'bin', binaryName))
  } else {
    candidates.push(
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
      posix.join(home, '.local', 'bin', binaryName),
    )
  }
  return candidates
}

/**
 * Locate an executable `agy` binary on the host without spawning a process.
 * Respects explicit `command`, `OAR_ANTIGRAVITY_BIN`, `RELAY_ANTIGRAVITY_COMMAND`,
 * `PATH`, and standard installer locations.
 */
export function findAntigravityExecutable(options: {
  readonly command?: string
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly home?: string
} = {}): string | undefined {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const configured = nonBlank(options.command)
    ?? nonBlank(env.OAR_ANTIGRAVITY_BIN)
    ?? nonBlank(env.RELAY_ANTIGRAVITY_COMMAND)
  if (configured !== undefined) {
    if (isAbsolute(configured)) return isExecutableFile(configured, platform)
    for (const entry of (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter)) {
      const trimmed = nonBlank(entry)
      if (trimmed === undefined) continue
      const candidate = (platform === 'win32' ? win32.join : posix.join)(trimmed, configured)
      const hit = isExecutableFile(candidate, platform)
      if (hit !== undefined) return hit
    }
    return isExecutableFile(configured, platform)
  }
  const seen = new Set<string>()
  for (const candidate of defaultAntigravityCandidates(env, platform, home)) {
    const hit = isExecutableFile(candidate, platform)
    if (hit === undefined || seen.has(hit)) continue
    seen.add(hit)
    return hit
  }
  return undefined
}

/**
 * Build a scrubbed child environment matching DSH's subprocess policy: drops
 * `DSH_*` and credential-shaped variables while keeping `PATH`, `HOME`,
 * locale, proxy, and Antigravity CLI config variables intact.
 */
export function scrubAntigravityEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
  extra: Readonly<Record<string, string | null>> = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue
    if (key.toUpperCase().startsWith('DSH_')) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    result[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete result[key]
    else result[key] = value
  }
  return result
}

function defaultProbeVersion(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { env, timeout: VERSION_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve(undefined)
        return
      }
      resolve(parseAntigravityVersion(String(stdout)))
    })
  })
}

function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('oar-antigravity: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('oar-antigravity: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('oar-antigravity: the one-shot task must not be empty')
  }
  return texts.join('')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function extractTextContent(value: unknown): string | undefined {
  if (isRecord(value)) {
    if (typeof value.text === 'string') return value.text
    if (value.type === 'content') return extractTextContent(value.content)
    return undefined
  }
  if (Array.isArray(value)) {
    const parts = value
      .map(item => extractTextContent(item))
      .filter((item): item is string => item !== undefined)
    return parts.length === 0 ? undefined : parts.join('\n')
  }
  return undefined
}

function allowPermissionResponse(params: unknown): Record<string, unknown> {
  const options = isRecord(params) && Array.isArray(params.options)
    ? params.options.filter(isRecord)
    : []
  const selected = options.find(opt => opt.kind === 'allow_always')
    ?? options.find(opt => opt.kind === 'allow_once')
  if (selected !== undefined && typeof selected.optionId === 'string') {
    return { outcome: { outcome: 'selected', optionId: selected.optionId } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

interface AcpConnection {
  readonly child: ChildProcessWithoutNullStreams
  readonly exited: Promise<number | null>
  request(method: string, params: Record<string, unknown>, timeoutMs: number | null): Promise<Record<string, unknown>>
  notify(method: string, params: Record<string, unknown>): void
  onUpdate(listener: (params: Record<string, unknown>) => void): () => void
  closeProcess(): Promise<void>
}

function openAcpConnection(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): AcpConnection {
  const child = spawn(command, [...args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let nextId = 1
  let closed = false
  let exitCode: number | null = null
  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void
    reject: (error: Error) => void
    timer?: NodeJS.Timeout
  }>()
  const updateListeners = new Set<(params: Record<string, unknown>) => void>()

  const failAllPending = (reason: Error): void => {
    for (const entry of pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.reject(reason)
    }
    pending.clear()
  }

  const writeMessage = (payload: Record<string, unknown>): void => {
    if (closed || child.stdin.destroyed || !child.stdin.writable) return
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed === '') return
    let message: unknown
    try {
      message = JSON.parse(trimmed)
    } catch {
      return
    }
    if (!isRecord(message)) return

    const hasId = message.id !== undefined && message.id !== null
    const method = typeof message.method === 'string' ? message.method : undefined

    if (hasId && method !== undefined) {
      if (method === 'session/request_permission') {
        writeMessage({
          jsonrpc: '2.0',
          id: message.id,
          result: allowPermissionResponse(message.params),
        })
      } else {
        writeMessage({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Unsupported ACP client method: ${method}` },
        })
      }
      return
    }

    if (!hasId && method !== undefined) {
      if (method === 'session/update' && isRecord(message.params)) {
        for (const listener of [...updateListeners]) listener(message.params)
      }
      return
    }

    if (hasId && typeof message.id === 'number') {
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      if (isRecord(message.error)) {
        const msg = typeof message.error.message === 'string' ? message.error.message : 'ACP RPC error'
        entry.reject(new Error(msg))
      } else {
        entry.resolve(isRecord(message.result) ? message.result : {})
      }
    }
  }

  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      handleLine(line)
      newlineIndex = buffer.indexOf('\n')
    }
  })
  // Drain stderr so the child cannot block on a full pipe.
  child.stderr.resume()

  const exited = new Promise<number | null>((resolve) => {
    const finish = (code: number | null, error?: Error): void => {
      if (closed) return
      closed = true
      exitCode = code
      if (buffer.trim() !== '') {
        handleLine(buffer)
        buffer = ''
      }
      failAllPending(error ?? new Error(`ACP process exited (${code ?? 'signal'})`))
      resolve(code)
    }
    child.once('error', (error) => { finish(null, error) })
    child.once('close', (code) => { finish(code) })
  })

  let closing: Promise<void> | undefined
  const closeProcess = (): Promise<void> => {
    if (closing !== undefined) return closing
    closing = (async () => {
      if (closed) return
      try { child.stdin.end() } catch { /* ignore */ }
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              if (!closed) {
                try { child.kill('SIGKILL') } catch { /* ignore */ }
              }
              resolve()
            }, KILL_GRACE_MS)
            timer.unref()
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      await exited
    })()
    return closing
  }

  return {
    child,
    exited,
    request(method, params, timeoutMs) {
      if (closed) {
        return Promise.reject(new Error(`ACP process already exited (${exitCode ?? 'signal'})`))
      }
      const id = nextId++
      return new Promise((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined
        if (timeoutMs !== null) {
          timer = setTimeout(() => {
            if (!pending.delete(id)) return
            reject(new AntigravityOarFailure('startup', 'timeout'))
          }, timeoutMs)
          timer.unref()
        }
        pending.set(id, { resolve, reject, timer })
        writeMessage({ jsonrpc: '2.0', id, method, params })
      })
    },
    notify(method, params) {
      writeMessage({ jsonrpc: '2.0', method, params })
    },
    onUpdate(listener) {
      updateListeners.add(listener)
      return () => { updateListeners.delete(listener) }
    },
    closeProcess,
  }
}

/**
 * Open one Antigravity ACP session and return a one-shot DSH `SubagentRun`.
 * Mirrors `@deepseek-ai/dsh-experimental-subagent-oar`'s `startOarRun`.
 */
export async function startAntigravityOarRun(
  request: ResolvedSubagentStartRequest,
  options: AntigravityOarOptions = {},
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) throw new AntigravityOarFailure('startup', 'cancelled')
  const cwd = assertUsableCwd('oar-antigravity', 'child cwd', request.cwd)

  const effectiveTimeoutMs = options.timeoutMs === undefined ? DEFAULT_ANTIGRAVITY_TIMEOUT_MS : options.timeoutMs
  if (effectiveTimeoutMs !== null) {
    assertPositiveFinite('oar-antigravity', 'timeoutMs', effectiveTimeoutMs)
    if (effectiveTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`oar-antigravity: timeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
    }
  }

  const childEnv = scrubAntigravityEnv(process.env, options.env)
  const command = findAntigravityExecutable({ command: options.command, env: process.env })
  if (command === undefined) {
    const failure = new AntigravityOarFailure('installation', 'not-found')
    reportFailure(options, failure)
    throw failure
  }

  const probe = options.probeVersion ?? defaultProbeVersion
  let version: string | undefined
  try {
    version = await probe(command, childEnv)
  } catch (error) {
    const failure = new AntigravityOarFailure('installation', 'unknown', { cause: error })
    reportFailure(options, failure)
    throw failure
  }
  if (request.signal.aborted) throw new AntigravityOarFailure('startup', 'cancelled')
  if (!isSupportedAntigravityVersion(version)) {
    const failure = new AntigravityOarFailure('installation', 'unsupported')
    reportFailure(options, failure)
    throw failure
  }

  const baseArgs = options.baseArgs ?? ['acp', '--dangerously-skip-permissions', '--process-per-session']
  const args = [...baseArgs, ...(options.launchArgs ?? [])]
  const connection = openAcpConnection(command, args, cwd, childEnv)

  let sessionId = ''
  let supportsClose = false
  try {
    const initialized = await connection.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'dsh-roles', version: PACKAGE_VERSION },
    }, HANDSHAKE_TIMEOUT_MS)
    const agentCaps = isRecord(initialized.agentCapabilities) ? initialized.agentCapabilities : undefined
    const sessionCaps = isRecord(agentCaps?.sessionCapabilities) ? agentCaps.sessionCapabilities : undefined
    supportsClose = sessionCaps?.close === true || isRecord(sessionCaps?.close)

    const created = await connection.request('session/new', {
      cwd,
      mcpServers: [],
    }, HANDSHAKE_TIMEOUT_MS)
    if (typeof created.sessionId !== 'string' || created.sessionId === '') {
      throw new AntigravityOarFailure('startup', 'protocol')
    }
    sessionId = created.sessionId
  } catch (error) {
    await connection.closeProcess()
    if (request.signal.aborted) throw new AntigravityOarFailure('startup', 'cancelled')
    const failure = error instanceof AntigravityOarFailure
      ? error
      : new AntigravityOarFailure('startup', 'unknown', { cause: error })
    reportFailure(options, failure)
    throw failure
  }

  if (request.signal.aborted) {
    await connection.closeProcess()
    throw new AntigravityOarFailure('startup', 'cancelled')
  }

  let resolveStopped!: (result: SubagentResult) => void
  const stoppedPromise = new Promise<SubagentResult>((resolve) => { resolveStopped = resolve })
  const messages = new Map<string, string>()
  let streamedText = ''
  let phase: 'running' | 'cancelled' | 'timeout' | 'settled' = 'running'
  let disposal: Promise<void> | undefined

  const collectOutput = (): readonly ContentBlock[] => {
    let answer = streamedText
    for (const text of messages.values()) {
      if (text.length > 0) answer = text
    }
    return answer.length === 0 ? [] : [{ type: 'text', text: answer }]
  }

  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal
    disposal = (async () => {
      try {
        if (supportsClose) {
          await connection.request('session/close', { sessionId }, CLOSE_TIMEOUT_MS).catch(() => {})
        }
      } finally {
        await connection.closeProcess()
      }
    })()
    return disposal
  }

  const interrupt = (reason: 'cancelled' | 'timeout'): void => {
    if (phase !== 'running') return
    phase = reason
    resolveStopped({
      output: collectOutput(),
      stopReason: reason === 'cancelled' ? 'aborted' : 'error',
      ...(reason === 'timeout'
        ? { diagnostic: 'OAR subagent exceeded its execution timeout. Increase timeoutMs or use a smaller task.' }
        : {}),
    })
    try {
      connection.notify('session/cancel', { sessionId })
    } catch (error) {
      reportFailure(options, new AntigravityOarFailure('abort', 'unknown', { cause: error }))
    }
    void dispose().catch(() => {})
  }

  const onAbort = (): void => { interrupt('cancelled') }
  const unsubscribe = connection.onUpdate((params) => {
    if (params.sessionId !== sessionId) return
    const update = isRecord(params.update) ? params.update : undefined
    if (update?.sessionUpdate !== 'agent_message_chunk') return
    const text = extractTextContent(update.content)
    if (text === undefined || text.length === 0) return
    streamedText += text
    const messageId = typeof update.messageId === 'string' ? update.messageId : undefined
    if (messageId !== undefined) {
      messages.set(messageId, (messages.get(messageId) ?? '') + text)
    }
  })

  request.signal.addEventListener('abort', onAbort, { once: true })
  if (request.signal.aborted) onAbort()

  const timer = effectiveTimeoutMs === null
    ? undefined
    : setTimeout(() => { interrupt('timeout') }, effectiveTimeoutMs)
  timer?.unref()

  const runTurn = async (): Promise<SubagentResult> => {
    const response = await connection.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    }, null)
    // Allow any final stdio update chunks delivered alongside the response to flush.
    await new Promise<void>(resolve => setImmediate(resolve))
    const stopReason = response.stopReason === 'cancelled' ? 'aborted' : 'completed'
    return { output: collectOutput(), stopReason }
  }

  const result = settleRunResult({
    attempt: async () => {
      if (phase !== 'running') return stoppedPromise
      try {
        return await Promise.race([runTurn(), stoppedPromise])
      } catch (error) {
        throw new AntigravityOarFailure('turn', 'unknown', { cause: error })
      }
    },
    collectOutput,
    collectDiagnostic: () => new AntigravityOarFailure('turn', 'unknown').message,
    cancelled: () => phase === 'cancelled',
    onError: options.onError,
    signal: request.signal,
    onAbort,
  }).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
    unsubscribe()
    if (phase === 'running') phase = 'settled'
  })

  return subprocessRunHandle({
    id: randomUUID() as SessionId,
    result,
    signal: request.signal,
    onAbort,
    requestCancel: onAbort,
    teardown: async () => {
      await dispose()
      await result
    },
  })
}

/**
 * Create a `SubagentProvider` for Antigravity mirroring `@deepseek-ai/dsh-experimental-subagent-oar`.
 */
export function createAntigravityOarProvider(options: AntigravityOarOptions = {}): SubagentProvider {
  const providerName = options.providerName ?? ANTIGRAVITY_OAR_PROVIDER_NAME
  return {
    name: providerName,
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    start: request => startAntigravityOarRun(request, options),
  }
}

interface LoaderEntryLike {
  readonly disabled?: boolean
  readonly options?: {
    readonly name?: unknown
    readonly config?: unknown
  }
}

function unwrapMaybeVolatile(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { readonly get: () => unknown }).get()
  }
  return value
}

/**
 * Check whether the host already has an official `oar-antigravity` provider
 * registered or declared in Loader entries (so our built-in fallback yields cleanly).
 */
export function hasOfficialAntigravityOar(
  ctx: Context,
  providerName = ANTIGRAVITY_OAR_PROVIDER_NAME,
): boolean {
  try {
    const subagents = (ctx as unknown as {
      subagents?: { getProvider?(name: string): SubagentProvider | undefined }
    }).subagents
    if (subagents?.getProvider?.(providerName) !== undefined) return true
  } catch {
    // Ignore registry inspection errors.
  }
  try {
    const root = (ctx as unknown as { root?: Context }).root ?? ctx
    const getter = root as unknown as { get?(key: string): unknown; loader?: unknown }
    const loader = (typeof getter.get === 'function' ? getter.get('loader') : undefined) ?? getter.loader
    if (loader === null || typeof loader !== 'object' || typeof (loader as { entries?: unknown }).entries !== 'function') {
      return false
    }
    for (const entry of (loader as { entries(): Iterable<LoaderEntryLike> }).entries()) {
      if (entry.disabled === true) continue
      if (entry.options?.name !== '@deepseek-ai/dsh-experimental-subagent-oar') continue
      const cfg = isRecord(entry.options.config) ? entry.options.config : undefined
      const configuredName = nonBlank(unwrapMaybeVolatile(cfg?.providerName)) ?? 'oar'
      const configuredRuntime = nonBlank(unwrapMaybeVolatile(cfg?.runtime))
      if (configuredName === providerName || configuredRuntime === 'antigravity') return true
    }
  } catch {
    // Ignore loader inspection errors.
  }
  return false
}

/**
 * Register the temporary built-in `oar-antigravity` provider when:
 * 1. no official `oar-antigravity` provider or Loader entry exists, and
 * 2. an `agy` CLI binary is present on the host.
 * @returns registration status and disposer.
 */
export function registerAntigravityOarFallback(
  ctx: Context,
  options: AntigravityOarOptions = {},
): { readonly registered: boolean; readonly dispose: () => void } {
  const providerName = options.providerName ?? ANTIGRAVITY_OAR_PROVIDER_NAME
  if (hasOfficialAntigravityOar(ctx, providerName)) {
    return { registered: false, dispose: () => {} }
  }
  const executable = findAntigravityExecutable({ command: options.command })
  if (executable === undefined) {
    return { registered: false, dispose: () => {} }
  }
  const subagents = (ctx as unknown as {
    subagents?: { registerProvider?(provider: SubagentProvider): () => void }
  }).subagents
  if (typeof subagents?.registerProvider !== 'function') {
    return { registered: false, dispose: () => {} }
  }
  const provider = createAntigravityOarProvider({
    ...options,
    providerName,
    onError: options.onError ?? ((error) => {
      ctx.logger?.warn?.('oar-antigravity: %s', error.message)
    }),
  })
  const dispose = subagents.registerProvider(provider)
  ctx.logger?.info?.(
    'registered temporary built-in %s provider via %s (yields automatically to official @deepseek-ai/dsh-experimental-subagent-oar)',
    providerName,
    executable,
  )
  return { registered: true, dispose }
}
