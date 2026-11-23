#!/usr/bin/env node
/**
 * Reproducible live benchmark for `dsh-roles`.
 *
 * Boots an isolated DSH composition per run (OpenAI-compatible endpoint, real
 * tools, isolated DSH_HOME/session root) and records total observed tokens, wall
 * time, delegation calls, and task quality for a baseline (plugin disabled) and
 * an enabled (orchestration enabled) run of the same task.
 *
 * Usage:
 *   pnpm run build
 *   node scripts/live-benchmark.mjs \
 *     [--tasks simple,explore,parallel] [--modes baseline,enabled] [--out report.json]
 *
 * Configuration environment variables:
 *   - DSH_BENCHMARK_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY (required)
 *   - DSH_BENCHMARK_BASE_URL / OPENAI_BASE_URL (default: https://api.deepseek.com/v1)
 *   - DSH_BENCHMARK_MODEL (default: deepseek-chat)
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { boot, initProfile, loadProfile, createRuntimeResolution, PluginPackages } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { decodeSessionLog, scanSessionLogs } from '../lib/benchmark.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const gateway = {
  provider: 'benchmark-openai',
  model: process.env.DSH_BENCHMARK_MODEL || 'deepseek-chat',
  baseURL: process.env.DSH_BENCHMARK_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1',
}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function apiKey() {
  const key = process.env.DSH_BENCHMARK_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY
  if (key) return key
  throw new Error('Set DSH_BENCHMARK_API_KEY, DEEPSEEK_API_KEY, or OPENAI_API_KEY before running live benchmarks')
}

function sessionFiles(path) {
  if (!statSync(path).isDirectory()) return [path]
  const files = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) files.push(...sessionFiles(child))
    else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) files.push(child)
  }
  return files
}

function readSessionEvents(file) {
  return decodeSessionLog(readFileSync(file))
}

function scanRoot(root) {
  try {
    return scanSessionLogs(sessionFiles(root).map(readSessionEvents))
  } catch {
    return { sessions: 0, requests: 0, delegationCalls: 0, wallMs: 0, usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null } }
  }
}

function finalAssistantText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const text = (event.data?.message?.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return ''
}

function writeWorkspace(root) {
  const workspace = mkdtempSync(join(root, 'workspace-'))
  mkdirSync(join(workspace, 'src'), { recursive: true })
  mkdirSync(join(workspace, 'test'), { recursive: true })
  writeFileSync(join(workspace, 'src/a.mjs'), 'export const a = (value) => value - 1\n')
  writeFileSync(join(workspace, 'src/b.mjs'), 'export const b = (value) => value * 0\n')
  writeFileSync(join(workspace, 'test/a.test.mjs'), [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { a } from '../src/a.mjs'",
    "test('a adds one', () => assert.equal(a(1), 2))",
    '',
  ].join('\n'))
  writeFileSync(join(workspace, 'test/b.test.mjs'), [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { b } from '../src/b.mjs'",
    "test('b doubles', () => assert.equal(b(3), 6))",
    '',
  ].join('\n'))
  const git = (...args) => execFileSync('git', ['-c', 'user.email=bench@local', '-c', 'user.name=bench', ...args], { cwd: workspace, encoding: 'utf8' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'benchmark fixture')
  return workspace
}

function parallelCheck(run) {
  try {
    execFileSync('node', ['--test'], { cwd: run.workspace, stdio: 'pipe', timeout: 60000 })
  } catch (error) {
    return { pass: false, detail: `node --test failed: ${String(error.stderr ?? error.message).slice(0, 400)}` }
  }
  const changed = execFileSync('git', ['status', '--porcelain'], { cwd: run.workspace, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean).map(line => line.slice(3).trim()).sort()
  return { pass: changed.join(',') === 'src/a.mjs,src/b.mjs', detail: `changed: ${changed.join(', ')}` }
}

const tasks = {
  simple: {
    cwd: () => packageRoot,
    prompt: 'Open package.json in this workspace and report its exact "name" and "build" script value. Do not modify files. Answer in one short paragraph.',
    quality: text => text.includes('dsh-roles') && text.includes('tsc -p tsconfig.build.json'),
    check: () => ({ pass: true, detail: 'text assertion' }),
  },
  explore: {
    cwd: () => packageRoot,
    prompt: 'Trace where this repository filters internal agent presets out of the mode selector (ignore node_modules). Read only the minimum files. Answer with: (1) the predicate function that identifies internal preset ids, (2) the constant listing internal preset ids, and (3) at most 5 Key Files with line ranges. Use at most 6 tool calls, do not use todo_write, then answer.',
    quality: text => text.includes('src/index.ts') && /hiddenOrchestrationPreset|ORCHESTRATION_PRESETS/.test(text),
    check: () => ({ pass: true, detail: 'text assertion' }),
  },
  parallel: {
    cwd: options => options.workspace,
    workspace: true,
    prompt: 'In this workspace, two independent tests fail because src/a.mjs and src/b.mjs are wrong. Fix both modules and run `node --test`. Report the changed files and the verification output.',
    quality: text => text.includes('src/a.mjs') && text.includes('src/b.mjs'),
    check: run => parallelCheck(run),
  },
  'explore-forced': {
    cwd: () => packageRoot,
    prompt: 'For this benchmark you must exercise delegation. Call orchestrate_subagent once with role "explore" and thoroughness "standard" to trace where this repository filters internal agent presets out of the mode selector (ignore node_modules). Then read the Key Files it returns and answer with the predicate function, the internal-preset constant, and at most 5 Key Files with line ranges. Do not use todo_write.',
    quality: text => text.includes('src/index.ts') && /hiddenOrchestrationPreset|ORCHESTRATION_PRESETS/.test(text),
    check: () => ({ pass: true, detail: 'text assertion' }),
  },
  'parallel-forced': {
    cwd: options => options.workspace,
    workspace: true,
    prompt: 'This benchmark must exercise orchestration. In this workspace, two independent tests fail. Call orchestrate_subagent twice in one assistant step, both with role "general-purpose": one with writeScope ["src/a.mjs"] to fix src/a.mjs, one with writeScope ["src/b.mjs"] to fix src/b.mjs. After both return, call orchestrate_subagent once with role "fork" to audit src/a.mjs and src/b.mjs, then run `node --test` and report the changed files and verification output.',
    quality: text => text.includes('src/a.mjs') && text.includes('src/b.mjs'),
    check: run => parallelCheck(run),
  },
}

async function runOne(mode, taskName, limits) {
  const task = tasks[taskName]
  const runId = `${mode}-${taskName}-${Date.now()}`
  const root = join(packageRoot, '.bench-tmp', runId)
  mkdirSync(root, { recursive: true })
  const workspace = task.workspace === true ? writeWorkspace(root) : undefined
  const home = join(root, 'dsh')
  process.env.DSH_HOME = home
  process.env.DSH_SESSION_ROOT = join(root, 'sessions')
  process.env.DSH_ME_PROVIDER = gateway.provider
  process.env.DSH_ME_MODEL = gateway.model

  const hostDir = join(root, 'host')
  mkdirSync(hostDir, { recursive: true })
  const anchor = join(hostDir, 'package.json')
  writeFileSync(anchor, JSON.stringify({
    name: 'dsh-benchmark-host',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh-base': '*',
      '@deepseek-ai/dsh-web-app': '*',
    },
  }))
  symlinkSync(join(packageRoot, 'node_modules'), join(hostDir, 'node_modules'), 'dir')

  const directory = join(home, 'profiles', 'live-benchmark')
  initProfile(directory, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...(mode === 'enabled' ? ['dsh-roles'] : [])])
  if (mode === 'enabled') {
    mkdirSync(join(directory, 'node_modules'), { recursive: true })
    symlinkSync(packageRoot, join(directory, 'node_modules', 'dsh-roles'), 'dir')
  }
  const profile = loadProfile('live-benchmark', 'live-benchmark', anchor)
  writeFileSync(join(directory, 'cordis.yml'), '[]\n')
  const gatewayPatch = { id: 'llm-pi-ai', config: { providers: {
    [gateway.provider]: {
      displayName: 'Benchmark Gateway',
      api: 'openai-completions',
      baseURL: gateway.baseURL,
      apiKeyEnv: 'DSH_BENCHMARK_KEY',
      defaultInput: ['text'],
      models: [{ id: gateway.model, name: gateway.model }],
    },
  } } }
  const patches = [
    { id: 'hmr', disabled: true },
    { id: 'web-startup', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'approval', config: { policy: 'never' } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: task.cwd({ workspace }) } },
    { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
    gatewayPatch,
    { id: 'session-persistence-jsonl', config: { root: process.env.DSH_SESSION_ROOT } },
    ...['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-skill', 'skill-filesystem', 'agent-instructions']
      .map(id => ({ id, disabled: false })),
    { id: 'webserver', inject: [], config: { host: '127.0.0.1', port: 0 } },
    { id: 'web-runtime', inject: [], config: { printUrl: false, openBrowser: false, surfaceContext: true, trustedHosts: [] } },
    { id: 'connection', inject: ['webServer'], config: { trustedHosts: [] } },
    { id: 'agent-default-model', config: { provider: gateway.provider, model: gateway.model } },
    { id: 'agent-preset-registry', config: { default: 'standard' } },
  ]
  writeFileSync(profile.patchPath, JSON.stringify(patches))
  const resolution = await createRuntimeResolution({ installAnchor: anchor, profile })

  const taskCwd = task.cwd({ workspace })
  const agentOptions = { provider: gateway.provider, model: gateway.model }
  let ctx
  let parent
  let result
  const startedAt = Date.now()
  try {
    ctx = await boot('live-benchmark', join(directory, 'cordis.yml'), [...profile.layers.flatMap(layer => layer.patches), ...patches], async host => {
      host.provide('profileContext', { name: 'live-benchmark', dir: directory, patchPath: profile.patchPath, installAnchor: anchor, cwd: taskCwd, home, startedBundles: profile.layers.map(layer => layer.packageName), overlays: [] })
      await host.plugin(PluginPackages, { resolution })
    })
    await ctx.get('loader')?.await?.()
    parent = await ctx.agents.create({
      sessionId: randomUUID(),
      meta: { cwd: taskCwd, agentPreset: 'standard' },
      agentOptions,
      setup: async scope => { await scope.get('agentPresets').mount(scope, 'standard') },
    })
    parent.agent.followup(createUserMessage({
      content: [{ type: 'text', text: task.prompt }],
      source: { kind: 'user', rpcId: randomUUID() },
    }))
    const deadline = Date.now() + limits.timeoutMs
    let capped
    const stop = reason => {
      if (capped !== undefined) return
      capped = reason
      try { parent.agent.cancel({ kind: 'user' }) } catch { /* older loop without cancel */ }
    }
    ctx.on('session/event', (session, event) => {
      if (session.id !== parent.agent.id || event.type !== 'step/start') return
      if (event.data.step > limits.maxSteps) stop('steps')
    })
    while (parent.agent.status !== 'idle') {
      if (Date.now() > deadline) stop('time')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const events = parent.agent.session.snapshotEvents()
    const text = finalAssistantText(events)
    result = {
      mode,
      task: taskName,
      wallMs: Date.now() - startedAt,
      qualityText: task.quality(text),
      qualityCheck: task.check({ workspace }),
      finalText: text.slice(0, 4000),
      error: events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'error'),
      capped,
      workspace,
    }
  } finally {
    if (parent !== undefined) await parent.dispose().catch(() => {})
    await ctx?.fiber.dispose().catch(() => {})
  }
  // Session logs are complete only after the Agent and persistence fiber dispose.
  result.scan = scanRoot(process.env.DSH_SESSION_ROOT)
  writeFileSync(join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  return result
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: live-benchmark.mjs [--tasks simple,explore,parallel] [--modes baseline,enabled] [--out report.json]\n')
    return
  }
  process.env.DSH_BENCHMARK_KEY = apiKey()
  const taskNames = (option('tasks', 'simple,explore,parallel')).split(',').filter(Boolean)
  const modes = (option('modes', 'baseline,enabled')).split(',').filter(Boolean)
  const output = option('out', join(packageRoot, '.bench-tmp', 'report.json'))
  const results = []
  for (const task of taskNames) {
    for (const mode of modes) {
      process.stderr.write(`[benchmark] ${mode}/${task}\n`)
      results.push(await runOne(mode, task, {
        maxSteps: Number(option('max-steps', '12')),
        timeoutMs: Number(option('timeout-ms', '240000')),
      }))
    }
  }
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify({ createdAt: new Date().toISOString(), gateway: { provider: gateway.provider, model: gateway.model }, results }, null, 2)}\n`)
  process.stdout.write(`${output}\n`)
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
