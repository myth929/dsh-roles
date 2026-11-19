import { describe, expect, it } from 'vitest'
import {
  Config,
  DEFAULT_BUDGETS,
  MIN_BUDGET,
  ORCHESTRATION_ROLES,
  parseBudgetOverrides,
  parseModelOverrides,
  resolveBudgets,
  resolveOrchestrationConfig,
  stepBudget,
  unwrapPluginConfig,
} from '../src/config.js'

describe('dsh-orchestration defaults', () => {
  it('is usable with no configuration at all across all 5 Claude-aligned roles', () => {
    const config = resolveOrchestrationConfig({}, {})
    expect(config.exploreRoute).toBeUndefined()
    expect(config.models).toEqual({
      'general-purpose': undefined,
      explore: undefined,
      plan: undefined,
      'dsh-code-guide': undefined,
    })
    expect(config.budgets).toEqual(DEFAULT_BUDGETS)
    expect(ORCHESTRATION_ROLES).toEqual(['general-purpose', 'explore', 'plan', 'fork', 'dsh-code-guide'])
    expect(stepBudget(config.budgets, 'explore', 'quick')).toBe(4)
    expect(stepBudget(config.budgets, 'general-purpose', 'thorough')).toBe(28)
    expect(stepBudget(config.budgets, 'plan', 'standard')).toBe(10)
    expect(stepBudget(config.budgets, 'fork', 'standard')).toBe(10)
    expect(stepBudget(config.budgets, 'dsh-code-guide', 'quick')).toBe(4)
  })

  it('defaults every configurable role to follow the parent model even when DSH_ME_* is set, while honoring explicit overrides', () => {
    const env = { DSH_ME_PROVIDER: 'custom-provider', DSH_ME_MODEL: 'fast-model' }
    const resolved = resolveOrchestrationConfig({}, env)
    expect(resolved.exploreRoute).toBeUndefined()
    expect(resolved.models).toEqual({
      'general-purpose': undefined,
      explore: undefined,
      plan: undefined,
      'dsh-code-guide': undefined,
    })

    expect(resolveOrchestrationConfig({}, {
      ...env,
      DSH_ORCHESTRATION_EXPLORE_PROVIDER: 'other-provider',
      DSH_ORCHESTRATION_EXPLORE_MODEL: 'other-model',
    }).exploreRoute).toEqual({ provider: 'other-provider', model: 'other-model' })
  })

  it('rejects a half-configured legacy explore route instead of silently inheriting', () => {
    expect(() => resolveOrchestrationConfig({}, { DSH_ORCHESTRATION_EXPLORE_PROVIDER: 'only-provider' })).toThrow(/requires both/)
    expect(() => resolveOrchestrationConfig({}, { DSH_ORCHESTRATION_EXPLORE_MODEL: 'only-model' })).toThrow(/requires both/)
  })

  it('parses per-role models shorthand, objects with slashes, and subagentProvider with config precedence', () => {
    const parsed = parseModelOverrides({
      explore: 'deepseek/deepseek-chat',
      plan: 'openrouter/anthropic/claude-sonnet-4',
      'general-purpose': {
        provider: 'openai',
        model: 'gpt-5.4',
        reasoningEffort: 'high',
        subagentProvider: 'oar-codex',
      },
      'dsh-code-guide': { subagentProvider: 'spawn', provider: 'anthropic', model: 'claude-haiku' },
    })
    expect(parsed.explore).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(parsed.plan).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' })
    expect(parsed['general-purpose']).toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      subagentProvider: 'oar-codex',
    })

    const merged = resolveOrchestrationConfig(
      { models: { explore: 'loader-provider/loader-model' } },
      { DSH_ORCHESTRATION_MODELS: '{"explore":"env-p/env-m","plan":"anthropic/claude-opus"}' },
    )
    expect(merged.models.explore).toEqual({ provider: 'loader-provider', model: 'loader-model' })
    expect(merged.models.plan).toEqual({ provider: 'anthropic', model: 'claude-opus' })
    expect(merged.exploreRoute).toEqual({ provider: 'loader-provider', model: 'loader-model' })
  })

  it('rejects invalid model entries including fork overrides, half-routes, effort without model, and bad JSON', () => {
    expect(() => parseModelOverrides({ fork: 'deepseek/deepseek-chat' })).toThrow(/fork.*inherits the parent model/)
    expect(() => parseModelOverrides({ unknown: 'deepseek/deepseek-chat' })).toThrow(/unknown role/)
    expect(() => parseModelOverrides({ explore: 'no-slash' })).toThrow(/provider\/model/)
    expect(() => parseModelOverrides({ explore: '/only-model' })).toThrow(/provider\/model/)
    expect(() => parseModelOverrides({ explore: { provider: 'only-provider' } })).toThrow(/requires both/)
    expect(() => parseModelOverrides({ plan: { reasoningEffort: 'high' } })).toThrow(/requires both/)
    expect(() => parseModelOverrides({ plan: {} })).toThrow(/must specify at least/)
    expect(() => parseModelOverrides({ plan: { subagentProvider: 'oar', extra: true } })).toThrow(/unknown key/)
    expect(() => parseModelOverrides('not-json')).toThrow(/valid JSON/)
  })

  it('rejects unknown roles, levels, and out-of-range budgets', () => {
    expect(() => parseBudgetOverrides('{"reviewer":{"quick":3}}')).toThrow(/unknown role/)
    expect(() => parseBudgetOverrides('{"explore":{"fast":3}}')).toThrow(/unknown thoroughness/)
    expect(() => parseBudgetOverrides(`{"explore":{"quick":${MIN_BUDGET - 1}}}`)).toThrow(/between/)
    expect(() => parseBudgetOverrides('not-json')).toThrow(/valid JSON/)
  })

  it('merges partial overrides without dropping untouched defaults', () => {
    const budgets = resolveBudgets(parseBudgetOverrides('{"explore":{"quick":2},"general-purpose":{"standard":20},"plan":{"thorough":22}}'))
    expect(budgets.explore).toEqual({ quick: 2, standard: 8, thorough: 14 })
    expect(budgets['general-purpose']).toEqual({ quick: 8, standard: 20, thorough: 28 })
    expect(budgets.plan).toEqual({ quick: 5, standard: 10, thorough: 22 })
    expect(budgets.fork).toEqual(DEFAULT_BUDGETS.fork)
    expect(budgets['dsh-code-guide']).toEqual(DEFAULT_BUDGETS['dsh-code-guide'])
  })

  it('unwraps Cordis Volatile accessors dynamically and preserves env fallback when undefined', () => {
    let liveModels: Record<string, unknown> | undefined
    let liveBudgets: Record<string, unknown> | undefined
    const volatileConfig = {
      models: { get: () => liveModels },
      budgets: { get: () => liveBudgets },
    }
    const env = {
      DSH_ME_PROVIDER: 'me-p',
      DSH_ME_MODEL: 'me-m',
    }

    const before = resolveOrchestrationConfig(volatileConfig, env)
    expect(before.models.explore).toBeUndefined()

    liveModels = {
      explore: { subagentProvider: 'oar-codex' },
      plan: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'high' },
    }
    liveBudgets = { explore: { quick: 2 } }

    const after = resolveOrchestrationConfig(volatileConfig, env)
    expect(after.models.explore).toEqual({ subagentProvider: 'oar-codex' })
    expect(after.models.plan).toEqual({ provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'high' })
    expect(after.budgets.explore.quick).toBe(2)
    expect(unwrapPluginConfig({ exploreProvider: 'p' })).toEqual({
      exploreProvider: 'p',
      exploreModel: undefined,
      models: undefined,
      budgets: undefined,
    })
  })

  it('exposes volatile schema fields on Config and validates OAR/LLM models overrides', () => {
    const dict = Config.dict as Record<string, { meta?: { volatile?: boolean } }>
    expect(dict.models?.meta?.volatile).toBe(true)
    expect(dict.budgets?.meta?.volatile).toBe(true)
    expect(dict.exploreProvider?.meta?.volatile).not.toBe(true)

    const resolved = Config({
      models: {
        'general-purpose': { subagentProvider: 'oar-codex' },
        plan: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'high' },
      },
    })
    expect(resolved).toBeDefined()
  })
})
