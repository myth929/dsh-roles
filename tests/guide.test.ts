import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveOrchestrationConfig } from '../src/config.js'
import {
  buildDshGuideContext,
  listExternalSubagentProviders,
  resolveDshPackageRoots,
} from '../src/guide.js'

describe('dsh-code-guide environment discovery', () => {
  it('discovers installed @deepseek-ai/* package doc roots without throwing', () => {
    const packages = resolveDshPackageRoots(process.cwd())
    const names = packages.map(pkg => pkg.name)
    expect(names).toContain('@deepseek-ai/dsh-agent')
    expect(names).toContain('@deepseek-ai/dsh-subagent')
    expect(names).toContain('@deepseek-ai/dsh-tools')
    const subagent = packages.find(pkg => pkg.name === '@deepseek-ai/dsh-subagent')
    expect(subagent?.readmeEn).toBe(true)
    expect(subagent?.typesDir).toBe(true)
  })

  it('builds a sanitized # Current DSH Environment block with presets, providers, inspect, tools, MCP, and config', async () => {
    const config = resolveOrchestrationConfig({
      models: {
        explore: 'deepseek/deepseek-chat',
        'general-purpose': { subagentProvider: 'oar-codex' },
      },
    }, {})
    const ctx = {
      get: (key: string) => {
        if (key === 'agentPresets') {
          return {
            list: async () => [{ id: 'standard', name: 'Standard' }],
          }
        }
        if (key === 'cordisInspect') {
          return {
            list: () => [{ id: 'Service', platform: 'host' }],
          }
        }
        return undefined
      },
      subagents: {
        getProvider: (name: string) => name === 'spawn'
          ? {
              name: 'spawn',
              capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
              inheritsParentContext: false,
              prepareContinuable: async () => ({}),
            }
          : undefined,
      },
    } as unknown as Context
    const parent = {
      id: 'root',
      session: { header: { cwd: process.cwd() } },
      ctx: {
        tools: {
          definitions: () => [
            { name: 'read' },
            { name: 'orchestrate_subagent' },
            { name: 'mcp__nexus_dsh__list_tools' },
          ],
        },
      },
    } as unknown as Agent

    const text = await buildDshGuideContext(ctx, parent, config)
    expect(text).toContain('# Current DSH Environment')
    expect(text).toContain('standard (Standard)')
    expect(text).toContain('spawn (local; inheritsContext=false')
    expect(text).toContain('host:Service')
    expect(text).toContain('orchestrate_subagent, read')
    expect(text).toContain('Configured MCP servers**: nexus_dsh')
    expect(text).toContain('oar-codex')
    expect(text).toContain('## Installed `@deepseek-ai/*` Packages')
  })

  it('lists oar-antigravity alongside oar-codex/oar-claude', () => {
    const config = resolveOrchestrationConfig({}, {})
    const providers = new Map<string, unknown>([
      ['oar-antigravity', { name: 'oar-antigravity', capabilities: {}, inheritsParentContext: false }],
      ['oar-codex', { name: 'oar-codex', capabilities: {}, inheritsParentContext: false }],
    ])
    const ctxWithoutOfficial = {
      subagents: { getProvider: (name: string) => name === 'oar-antigravity' ? providers.get(name) : undefined },
    } as unknown as Context
    const builtinOnly = listExternalSubagentProviders(ctxWithoutOfficial, config)
    expect(builtinOnly).toEqual([
      { id: 'oar-antigravity', label: 'OAR · Antigravity', runtime: 'antigravity', isOar: true },
    ])

    const ctxWithOfficial = {
      subagents: { getProvider: (name: string) => providers.get(name) },
    } as unknown as Context
    const combined = listExternalSubagentProviders(ctxWithOfficial, config)
    expect(combined.map(item => item.id)).toEqual(['oar-antigravity', 'oar-codex'])
  })

  it('includes source plugin package metadata from loader entries so native plugins are distinguished from OAR', () => {
    const config = resolveOrchestrationConfig({}, {})
    const providers = new Map<string, unknown>([
      ['oar-codex', { name: 'oar-codex', capabilities: {}, inheritsParentContext: false }],
      ['codex', { name: 'codex', capabilities: {}, inheritsParentContext: false }],
      ['claude-code', { name: 'claude-code', capabilities: {}, inheritsParentContext: false }],
    ])
    const ctx = {
      get: (key: string) => key === 'loader'
        ? {
            entries: () => [
              {
                options: {
                  name: '@deepseek-ai/dsh-experimental-subagent-oar',
                  config: { runtime: 'codex', providerName: 'oar-codex' },
                },
              },
              {
                options: {
                  name: '@deepseek-ai/dsh-subagent-codex',
                },
              },
              {
                options: {
                  name: '@deepseek-ai/dsh-subagent-claude-code',
                },
              },
            ],
          }
        : undefined,
      subagents: { getProvider: (name: string) => providers.get(name) },
    } as unknown as Context

    const discovered = listExternalSubagentProviders(ctx, config)
    expect(discovered).toEqual([
      {
        id: 'oar-codex',
        label: 'OAR · Codex',
        runtime: 'codex',
        plugin: '@deepseek-ai/dsh-experimental-subagent-oar',
        isOar: true,
      },
      {
        id: 'claude-code',
        label: 'Claude Code',
        runtime: 'claude',
        plugin: '@deepseek-ai/dsh-subagent-claude-code',
        isOar: false,
      },
      {
        id: 'codex',
        label: 'Codex',
        runtime: 'codex',
        plugin: '@deepseek-ai/dsh-subagent-codex',
        isOar: false,
      },
    ])
  })
})
