import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedSubagentStartRequest, SubagentProvider } from '@deepseek-ai/dsh-subagent'
import {
  ANTIGRAVITY_OAR_PROVIDER_NAME,
  findAntigravityExecutable,
  hasOfficialAntigravityOar,
  isSupportedAntigravityVersion,
  parseAntigravityVersion,
  registerAntigravityOarFallback,
  scrubAntigravityEnv,
  startAntigravityOarRun,
} from '../src/antigravity.js'

const MOCK_ACP_SCRIPT = `#!/usr/bin/env node
const readline = require('node:readline');
const mode = process.env.MOCK_ACP_MODE || 'ok';

if (process.argv.includes('--version')) {
  process.stdout.write((process.env.MOCK_ACP_VERSION || '1.5.12') + '\\n');
  process.exit(0);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let pendingPromptId = null;

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { close: true } },
      },
    });
    return;
  }
  if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { sessionId: 'sess-mock-1' },
    });
    return;
  }
  if (msg.method === 'session/prompt') {
    pendingPromptId = msg.id;
    const text = msg.params?.prompt?.[0]?.text || '';
    if (mode === 'permission') {
      send({
        jsonrpc: '2.0',
        id: 9001,
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-mock-1',
          options: [
            { optionId: 'deny-1', kind: 'reject_once' },
            { optionId: 'allow-1', kind: 'allow_always' },
          ],
        },
      });
      return;
    }
    if (mode === 'hang') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-mock-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'partial-before-cancel' },
          },
        },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-mock-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Echo: ' },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-mock-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { stopReason: 'end_turn' },
    });
    return;
  }
  if (msg.id === 9001 && msg.result) {
    const chosen = msg.result?.outcome?.optionId || 'none';
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-mock-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'approved:' + chosen },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      id: pendingPromptId,
      result: { stopReason: 'end_turn' },
    });
    return;
  }
  if (msg.method === 'session/cancel' && pendingPromptId !== null) {
    send({
      jsonrpc: '2.0',
      id: pendingPromptId,
      result: { stopReason: 'cancelled' },
    });
    pendingPromptId = null;
    return;
  }
  if (msg.method === 'session/close') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
`

let tempDir = ''
let mockAgyPath = ''

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dsh-orch-agy-'))
  mockAgyPath = join(tempDir, 'mock-agy')
  writeFileSync(mockAgyPath, MOCK_ACP_SCRIPT, 'utf8')
  chmodSync(mockAgyPath, 0o755)
})

afterAll(() => {
  if (tempDir !== '') rmSync(tempDir, { recursive: true, force: true })
})

function startRequest(prompt: string, signal?: AbortSignal): ResolvedSubagentStartRequest {
  return {
    provider: ANTIGRAVITY_OAR_PROVIDER_NAME,
    prompt: [{ type: 'text', text: prompt }],
    cwd: tempDir,
    signal: signal ?? new AbortController().signal,
  } as unknown as ResolvedSubagentStartRequest
}

describe('antigravity OAR fallback provider', () => {
  it('parses and gates agy SemVer >= 1.5.0 strictly', () => {
    expect(parseAntigravityVersion('1.5.12\n')).toBe('1.5.12')
    expect(parseAntigravityVersion('1.5.0-rc.1')).toBe('1.5.0-rc.1')
    expect(parseAntigravityVersion('Build label: 1.2.1')).toBeUndefined()

    expect(isSupportedAntigravityVersion('1.5.0')).toBe(true)
    expect(isSupportedAntigravityVersion('1.5.12')).toBe(true)
    expect(isSupportedAntigravityVersion('1.5.1-rc.1')).toBe(true)
    expect(isSupportedAntigravityVersion('1.5.0-rc.1')).toBe(false)
    expect(isSupportedAntigravityVersion('1.4.9')).toBe(false)
    expect(isSupportedAntigravityVersion(undefined)).toBe(false)
  })

  it('scrubs DSH_* and credential-shaped env vars while preserving agy config vars', () => {
    const scrubbed = scrubAntigravityEnv({
      PATH: '/usr/bin',
      HOME: '/Users/tester',
      DSH_HOME: '/tmp/dsh',
      dsh_token: 'leak',
      DEEPSEEK_API_KEY: 'secret',
      OPENAI_API_KEY: 'secret',
      GEMINI_HOME: '/Users/tester/.gemini',
      ANTIGRAVITY_CLI_CONFIG_DIR: '/Users/tester/.gemini/antigravity-cli',
      HTTPS_PROXY: 'http://127.0.0.1:8080',
    }, { CUSTOM_FLAG: '1', HTTPS_PROXY: null })

    expect(scrubbed.PATH).toBe('/usr/bin')
    expect(scrubbed.HOME).toBe('/Users/tester')
    expect(scrubbed.GEMINI_HOME).toBe('/Users/tester/.gemini')
    expect(scrubbed.ANTIGRAVITY_CLI_CONFIG_DIR).toBe('/Users/tester/.gemini/antigravity-cli')
    expect(scrubbed.CUSTOM_FLAG).toBe('1')
    expect(scrubbed.DSH_HOME).toBeUndefined()
    expect(scrubbed.dsh_token).toBeUndefined()
    expect(scrubbed.DEEPSEEK_API_KEY).toBeUndefined()
    expect(scrubbed.OPENAI_API_KEY).toBeUndefined()
    expect(scrubbed.HTTPS_PROXY).toBeUndefined()
  })

  it('locates an explicit executable via command or OAR_ANTIGRAVITY_BIN', () => {
    expect(findAntigravityExecutable({ command: mockAgyPath })).toBeTruthy()
    expect(findAntigravityExecutable({ env: { OAR_ANTIGRAVITY_BIN: mockAgyPath } })).toBeTruthy()
    expect(findAntigravityExecutable({ command: join(tempDir, 'nonexistent-agy') })).toBeUndefined()
  })

  it('completes a one-shot ACP turn and streams agent_message_chunk output', async () => {
    const run = await startAntigravityOarRun(startRequest('hello antigravity'), {
      command: mockAgyPath,
    })
    const result = await run.result
    expect(result).toEqual({
      output: [{ type: 'text', text: 'Echo: hello antigravity' }],
      stopReason: 'completed',
    })
    await run.dispose()
  })

  it('auto-approves session/request_permission with allow_always', async () => {
    const run = await startAntigravityOarRun(startRequest('run check'), {
      command: mockAgyPath,
      env: { MOCK_ACP_MODE: 'permission' },
    })
    const result = await run.result
    expect(result).toEqual({
      output: [{ type: 'text', text: 'approved:allow-1' }],
      stopReason: 'completed',
    })
    await run.dispose()
  })

  it('cancels cleanly on parent AbortSignal and preserves streamed partial output', async () => {
    const controller = new AbortController()
    const run = await startAntigravityOarRun(startRequest('long work', controller.signal), {
      command: mockAgyPath,
      env: { MOCK_ACP_MODE: 'hang' },
    })
    await new Promise(resolve => setTimeout(resolve, 120))
    controller.abort()
    const result = await run.result
    expect(result.stopReason).toBe('aborted')
    expect(result.output).toEqual([{ type: 'text', text: 'partial-before-cancel' }])
    await run.dispose()
  })

  it('enforces optional timeoutMs and settles with a timeout diagnostic', async () => {
    const run = await startAntigravityOarRun(startRequest('slow work'), {
      command: mockAgyPath,
      env: { MOCK_ACP_MODE: 'hang' },
      timeoutMs: 120,
    })
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('timeout')
    await run.dispose()
  })

  it('rejects unsupported agy CLI versions during installation check', async () => {
    await expect(startAntigravityOarRun(startRequest('hi'), {
      command: mockAgyPath,
      env: { MOCK_ACP_VERSION: '1.4.9' },
    })).rejects.toThrow(/stage: installation; category: unsupported/)
  })

  it('yields automatically when official oar-antigravity provider or loader entry exists', () => {
    const registered = new Map<string, SubagentProvider>()
    const registerProvider = vi.fn((provider: SubagentProvider) => {
      registered.set(provider.name, provider)
      return () => { registered.delete(provider.name) }
    })

    // Case 1: official loader entry declared -> fallback yields.
    const ctxWithOfficialLoader = {
      subagents: {
        getProvider: (name: string) => registered.get(name),
        registerProvider,
      },
      get: (key: string) => key === 'loader'
        ? {
            entries: () => [{
              disabled: false,
              options: {
                name: '@deepseek-ai/dsh-experimental-subagent-oar',
                config: { runtime: 'antigravity', providerName: 'oar-antigravity' },
              },
            }],
          }
        : undefined,
      logger: { info: vi.fn(), warn: vi.fn() },
    } as unknown as Context
    expect(hasOfficialAntigravityOar(ctxWithOfficialLoader)).toBe(true)
    const skipped = registerAntigravityOarFallback(ctxWithOfficialLoader, { command: mockAgyPath })
    expect(skipped.registered).toBe(false)
    expect(registerProvider).not.toHaveBeenCalled()

    // Case 2: no official provider/loader entry + executable found -> registers and disposes cleanly.
    const ctxFallback = {
      subagents: {
        getProvider: (name: string) => registered.get(name),
        registerProvider,
      },
      logger: { info: vi.fn(), warn: vi.fn() },
    } as unknown as Context
    const mounted = registerAntigravityOarFallback(ctxFallback, { command: mockAgyPath })
    expect(mounted.registered).toBe(true)
    expect(registered.has('oar-antigravity')).toBe(true)
    expect(registered.get('oar-antigravity')?.inheritsParentContext).toBe(false)
    mounted.dispose()
    expect(registered.has('oar-antigravity')).toBe(false)
  })
})
