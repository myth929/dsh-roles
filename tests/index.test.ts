import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  apply,
  GUIDANCE_SECTION_NAME,
  hiddenOrchestrationPreset,
  ORCHESTRATION_PRESETS,
  shouldInjectGuidance,
} from '../src/index.js'
import { resolveOrchestrationConfig } from '../src/config.js'
import { formatRootSchedulingGuidance, ROOT_SCHEDULING_GUIDANCE } from '../src/roles.js'

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
    expect(GUIDANCE_SECTION_NAME).toBe('dsh-roles:guidance')
  })

  it('adapts root scheduling guidance when dedicated role backends are configured while keeping trivial tasks direct', () => {
    expect(ROOT_SCHEDULING_GUIDANCE).toContain('multi-file or multi-step code implementation')
    expect(ROOT_SCHEDULING_GUIDANCE).toContain('Keep trivial, self-contained tasks direct')
    expect(ROOT_SCHEDULING_GUIDANCE).not.toContain('configured as a dedicated execution backend')

    const configured = resolveOrchestrationConfig({
      models: {
        'general-purpose': { subagentProvider: 'oar-codex' },
        plan: { provider: 'openai', model: 'gpt-5.4' },
      },
    }, {})
    const adapted = formatRootSchedulingGuidance(configured.models)
    expect(adapted).toContain('`general-purpose` (oar-codex) is configured as a dedicated execution backend')
    expect(adapted).toContain('`plan` (openai/gpt-5.4)')
    expect(adapted).toContain('hand non-trivial implementation directly to `general-purpose`')
    expect(adapted).toContain('synthesize the subagent report directly')
    expect(adapted).toContain('Keep trivial, self-contained tasks direct even when dedicated backends are configured')
  })

  it('identifies all 4 internal orchestration presets so mode selectors hide them', () => {
    expect(ORCHESTRATION_PRESETS).toEqual([
      'dsh-roles-general-purpose',
      'dsh-roles-explore',
      'dsh-roles-plan',
      'dsh-roles-guide',
    ])
    for (const preset of ORCHESTRATION_PRESETS) expect(hiddenOrchestrationPreset(preset)).toBe(true)
    expect(hiddenOrchestrationPreset('standard')).toBe(false)
    expect(hiddenOrchestrationPreset('cordis')).toBe(false)
  })

  it('binds optional ctx.worktrees and invokes worktrees.create on the child agent during agent/created without touching parent', async () => {
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-roles-index-wt-')))
    try {
      const run = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'test-user',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'test-user',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      }).trim()
      run(['init', '-b', 'main'])
      writeFileSync(join(repoRoot, 'file.ts'), 'export const x = 1\n')
      run(['add', '.'])
      run(['commit', '-m', 'init'])
      const baseCommit = run(['rev-parse', 'HEAD'])

      const listeners = new Map<string, (...args: any[]) => any>()
      let registeredTool: ToolDefinition | undefined
      const worktreeCreate = vi.fn(async (targetAgent: Agent, req?: { name?: string }) => {
        const branch = req?.name ?? 'dsh-generated-1'
        const wtPath = join(repoRoot, '.agents', 'worktrees', branch)
        run(['worktree', 'add', '-b', branch, '--', wtPath, baseCommit])
        ;(targetAgent.session.header as { cwd?: string }).cwd = wtPath
        return { path: wtPath, branch, baseCommit, repositoryRoot: repoRoot }
      })

      let childAgent: Agent | undefined
      const hostCtx = {
        logger: { info: vi.fn(), warn: vi.fn() },
        effect: vi.fn((fn: () => unknown) => { fn() }),
        on: vi.fn((event: string, listener: (...args: any[]) => any) => {
          listeners.set(event, listener)
          return () => { listeners.delete(event) }
        }),
        inject: vi.fn((deps: readonly string[], fn: (scope: any) => void) => {
          if (deps.includes('worktrees')) {
            fn({ worktrees: { create: worktreeCreate }, effect: vi.fn() })
            return () => {}
          }
          if (deps.includes('tools')) {
            fn({
              tools: {
                register: vi.fn((def: ToolDefinition) => { registeredTool = def; return () => {} }),
                get: vi.fn(() => registeredTool),
              },
              subagents: {
                startActivation: vi.fn(async (spec: { childId: string }) => {
                  childAgent = {
                    id: spec.childId,
                    options: { subagentDepth: 1 },
                    session: {
                      id: spec.childId,
                      header: { version: 4, id: spec.childId, createdAt: 0, isSeeded: false, cwd: repoRoot, origin: 'subagent' },
                    },
                    ctx: {
                      tools: {
                        definitions: vi.fn(() => [{ name: 'read' }, { name: 'write' }, { name: 'bash' }]),
                        restrict: vi.fn(() => () => {}),
                        guard: vi.fn(() => () => {}),
                      },
                      on: vi.fn(() => () => {}),
                      logger: { warn: vi.fn(), info: vi.fn() },
                    },
                  } as unknown as Agent
                  await listeners.get('agent/created')?.({ agent: childAgent, source: 'startup' })
                  writeFileSync(join((childAgent.session.header as { cwd: string }).cwd, 'file.ts'), 'export const x = 2\n')
                  return {
                    childId: spec.childId,
                    name: 'wt-child',
                    result: Promise.resolve({ output: [{ type: 'text', text: 'edited x' }], stopReason: 'completed' }),
                    dispose: vi.fn(async () => {}),
                  }
                }),
              },
              systemPrompt: {
                section: vi.fn(() => () => {}),
                getSectionOrder: vi.fn(() => 10),
              },
              on: vi.fn(() => () => {}),
              logger: { info: vi.fn(), warn: vi.fn() },
              get: vi.fn(() => undefined),
            })
          }
          return () => {}
        }),
        get: vi.fn(() => undefined),
      } as unknown as Context

      apply(hostCtx, {})
      expect(registeredTool).toBeDefined()

      const parent = {
        id: 'parent-root',
        options: {},
        session: {
          id: 'parent-root',
          header: { version: 4, id: 'parent-root', createdAt: 0, isSeeded: false, cwd: repoRoot },
        },
      } as unknown as Agent

      const outcome = await registeredTool!.execute({
        role: 'general-purpose',
        isolation: 'worktree',
        name: 'child-x',
        description: 'change x to 2',
        prompt: 'Set x = 2.',
      }, {
        callId: 'call-wt-1',
        rootCallId: 'call-wt-1',
        name: 'orchestrate_subagent',
        arguments: {},
        agent: parent,
        signal: new AbortController().signal,
        token: Symbol('exec'),
        deferContext: vi.fn(),
        concludeTurn: vi.fn(),
      } as unknown as ToolRunContext) as { kind: string; worktree?: { status: string; branch: string; autoCommitted?: boolean } }

      expect(worktreeCreate).toHaveBeenCalledTimes(1)
      expect(worktreeCreate.mock.calls[0]?.[0]).toBe(childAgent)
      expect(worktreeCreate.mock.calls[0]?.[0]).not.toBe(parent)
      expect(parent.session.header.cwd).toBe(repoRoot)
      expect(outcome.kind).toBe('result')
      expect(outcome.worktree?.status).toBe('ready-to-merge')
      expect(outcome.worktree?.autoCommitted).toBe(true)

      // Cold resume does not invoke worktrees.create a second time.
      await listeners.get('agent/created')?.({ agent: childAgent!, source: 'resume' })
      expect(worktreeCreate).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
