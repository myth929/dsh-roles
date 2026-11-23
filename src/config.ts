/**
 * Configuration contract for the standalone `dsh-roles` bundle.
 *
 * All settings provide usable defaults with explicit Loader-row config taking
 * precedence over process environment variables.
 * @module dsh-roles/config
 */

import z from '@deepseek-ai/schemastery'

/** The five Claude-aligned delegation roles exposed by the single orchestration tool. */
export const ORCHESTRATION_ROLES = ['general-purpose', 'explore', 'plan', 'fork', 'dsh-code-guide'] as const
/** Roles whose LLM route or subagent provider may be overridden by configuration. */
export const CONFIGURABLE_MODEL_ROLES = ['general-purpose', 'explore', 'plan', 'dsh-code-guide'] as const
/** Task-size ladder that selects a step budget. */
export const THOROUGHNESS_LEVELS = ['quick', 'standard', 'thorough'] as const

export type OrchestrationRole = typeof ORCHESTRATION_ROLES[number]
export type ConfigurableModelRole = typeof CONFIGURABLE_MODEL_ROLES[number]
export type Thoroughness = typeof THOROUGHNESS_LEVELS[number]
export type RoleBudgets = Readonly<Record<Thoroughness, number>>
export type Budgets = Readonly<Record<OrchestrationRole, RoleBudgets>>
export type BudgetOverrides = Partial<Record<OrchestrationRole, Partial<Record<Thoroughness, number>>>>

/** Resolved LLM route and optional subagent provider binding for one configurable role. */
export interface RoleModelRoute {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly subagentProvider?: string
}

export type RawRoleModelInput = string | RoleModelRoute
export type ModelOverrides = Partial<Record<ConfigurableModelRole, RawRoleModelInput>>
export type ResolvedModels = Readonly<Record<ConfigurableModelRole, RoleModelRoute | undefined>>

/** Value or Cordis `Volatile`-shaped live config cell accepted from a Loader row. */
export type MaybeVolatile<T> = T | { readonly get: () => T }

/** Step budgets that keep every role bounded without any user configuration. */
export const DEFAULT_BUDGETS: Budgets = Object.freeze({
  'general-purpose': Object.freeze({ quick: 8, standard: 16, thorough: 28 }),
  explore: Object.freeze({ quick: 4, standard: 8, thorough: 14 }),
  plan: Object.freeze({ quick: 5, standard: 10, thorough: 18 }),
  fork: Object.freeze({ quick: 5, standard: 10, thorough: 18 }),
  'dsh-code-guide': Object.freeze({ quick: 4, standard: 8, thorough: 14 }),
})

/** Minimum useful budget: one working step followed by one convergence step. */
export const MIN_BUDGET = 2
/** Upper bound guards against a typo silently disabling the budget. */
export const MAX_BUDGET = 200
/** Claude-aligned single-level delegation depth: root -> child. */
export const DELEGATION_MAX_DEPTH = 1

/** Tunable reminder thresholds controlling catalog refresh and mid-turn drift nudges. */
export interface ReminderConfig {
  /** Consecutive direct inspection steps in one turn before each mid-turn nudge fires. */
  readonly nudgeInspectionSteps: number
  /** Maximum mid-turn nudges per turn (0 disables mid-turn nudges). */
  readonly maxNudges: number
  /** User-turn interval between compact tail refreshes while the catalog remains visible (0 disables periodic refresh). */
  readonly catalogRefreshTurns: number
}

export type ReminderOverrides = Partial<ReminderConfig>

/** Default reminder thresholds tuned for proactive-yet-bounded delegation. */
export const DEFAULT_REMINDERS: ReminderConfig = Object.freeze({
  nudgeInspectionSteps: 3,
  maxNudges: 3,
  catalogRefreshTurns: 3,
})

export const MIN_NUDGE_INSPECTION_STEPS = 1
export const MAX_NUDGE_INSPECTION_STEPS = 50
export const MAX_DELEGATION_NUDGES_LIMIT = 20
export const MAX_CATALOG_REFRESH_TURNS = 50

/** Row configuration accepted by the bundle's Loader entry. */
export interface PluginConfig {
  /** Legacy provider override for `explore`; prefer `models.explore`. */
  exploreProvider?: string
  /** Legacy model override for `explore`; prefer `models.explore`. */
  exploreModel?: string
  /** JSON or object overriding per-role model or subagent provider routes. */
  models?: string | ModelOverrides
  /** JSON or object overriding one or more role/thoroughness budgets. */
  budgets?: string | BudgetOverrides
  /** JSON or object overriding reminder thresholds (`nudgeInspectionSteps`, `maxNudges`, `catalogRefreshTurns`). */
  reminders?: string | ReminderOverrides
}

/** Loader row input after Cordis resolves `.volatile()` fields into live accessors. */
export interface PluginConfigInput {
  /** Legacy provider override for `explore`; prefer `models.explore`. */
  exploreProvider?: MaybeVolatile<string | undefined>
  /** Legacy model override for `explore`; prefer `models.explore`. */
  exploreModel?: MaybeVolatile<string | undefined>
  /** JSON or object overriding per-role model or subagent provider routes. */
  models?: MaybeVolatile<string | ModelOverrides | undefined>
  /** JSON or object overriding one or more role/thoroughness budgets. */
  budgets?: MaybeVolatile<string | BudgetOverrides | undefined>
  /** JSON or object overriding reminder thresholds. */
  reminders?: MaybeVolatile<string | ReminderOverrides | undefined>
}

/** Validated configuration consumed by the plugin runtime. */
export interface ResolvedConfig {
  readonly exploreRoute: Readonly<{ provider: string; model: string }> | undefined
  readonly models: ResolvedModels
  readonly budgets: Budgets
  readonly reminders: ReminderConfig
}

export const RoleModelRouteSchema: z<RoleModelRoute> = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  subagentProvider: z.string().min(1),
}) as z<RoleModelRoute>

export const RoleModelInputSchema: z<RawRoleModelInput> = z.union([z.string().min(1), RoleModelRouteSchema])

export const ModelsOverrideSchema: z<ModelOverrides> = z.object({
  'general-purpose': RoleModelInputSchema,
  explore: RoleModelInputSchema,
  plan: RoleModelInputSchema,
  'dsh-code-guide': RoleModelInputSchema,
}) as z<ModelOverrides>

export const RoleBudgetOverrideSchema = z.object({
  quick: z.number().step(1).min(MIN_BUDGET).max(MAX_BUDGET),
  standard: z.number().step(1).min(MIN_BUDGET).max(MAX_BUDGET),
  thorough: z.number().step(1).min(MIN_BUDGET).max(MAX_BUDGET),
})

export const BudgetsOverrideSchema = z.object({
  'general-purpose': RoleBudgetOverrideSchema,
  explore: RoleBudgetOverrideSchema,
  plan: RoleBudgetOverrideSchema,
  fork: RoleBudgetOverrideSchema,
  'dsh-code-guide': RoleBudgetOverrideSchema,
})

export const ReminderOverrideSchema: z<ReminderOverrides> = z.object({
  nudgeInspectionSteps: z.number().step(1).min(MIN_NUDGE_INSPECTION_STEPS).max(MAX_NUDGE_INSPECTION_STEPS),
  maxNudges: z.number().step(1).min(0).max(MAX_DELEGATION_NUDGES_LIMIT),
  catalogRefreshTurns: z.number().step(1).min(0).max(MAX_CATALOG_REFRESH_TURNS),
}) as z<ReminderOverrides>

export const Config: z<PluginConfigInput> = z.object({
  exploreProvider: z.string().min(1),
  exploreModel: z.string().min(1),
  models: z.union([z.string(), ModelsOverrideSchema]).volatile(),
  budgets: z.union([z.string(), BudgetsOverrideSchema]).volatile(),
  reminders: z.union([z.string(), ReminderOverrideSchema]).volatile(),
}) as z<PluginConfigInput>

function readVolatile<T>(value: MaybeVolatile<T> | undefined): T | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { readonly get: () => T }).get()
  }
  return value as T | undefined
}

/**
 * Unwrap Cordis `Volatile`-backed Loader config cells into plain values.
 * @param raw - raw plugin configuration or resolved Cordis config object.
 * @returns plain detached configuration object.
 */
export function unwrapPluginConfig(raw: PluginConfigInput = {}): PluginConfig {
  return {
    exploreProvider: readVolatile(raw.exploreProvider),
    exploreModel: readVolatile(raw.exploreModel),
    models: readVolatile(raw.models),
    budgets: readVolatile(raw.budgets),
    reminders: readVolatile(raw.reminders),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function budgetValue(role: string, level: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_BUDGET || value > MAX_BUDGET) {
    throw new Error(
      `DSH_ROLES_BUDGETS: ${role}.${level} must be an integer between ${MIN_BUDGET} and ${MAX_BUDGET}`,
    )
  }
  return value
}

/**
 * Validate a partial role/thoroughness budget override.
 * @param raw - parsed JSON, a Loader-row object, or `undefined`.
 * @returns the checked override, preserving only provided leaves.
 * @throws when a role, level, or value is outside the supported shape.
 */
export function parseBudgetOverrides(raw: unknown): BudgetOverrides {
  if (raw === undefined || raw === null) return {}
  let value = raw
  if (typeof raw === 'string') {
    if (raw.trim() === '') return {}
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('DSH_ROLES_BUDGETS must be valid JSON')
    }
  }
  if (!isRecord(value)) throw new Error('DSH_ROLES_BUDGETS must be a JSON object')
  const overrides: Record<string, Partial<Record<string, number>>> = {}
  for (const [role, levels] of Object.entries(value)) {
    if (!(ORCHESTRATION_ROLES as readonly string[]).includes(role)) {
      throw new Error(`DSH_ROLES_BUDGETS: unknown role "${role}"; expected ${ORCHESTRATION_ROLES.join(', ')}`)
    }
    if (!isRecord(levels)) throw new Error(`DSH_ROLES_BUDGETS: ${role} must be an object`)
    const checked: Partial<Record<string, number>> = {}
    for (const [level, budget] of Object.entries(levels)) {
      if (!(THOROUGHNESS_LEVELS as readonly string[]).includes(level)) {
        throw new Error(`DSH_ROLES_BUDGETS: unknown thoroughness "${level}" for role "${role}"`)
      }
      checked[level] = budgetValue(role, level, budget)
    }
    overrides[role] = checked
  }
  return overrides as BudgetOverrides
}

/**
 * Merge a validated override over the shipped budget table.
 * @param overrides - checked partial override.
 * @returns a complete, frozen budget table.
 */
export function resolveBudgets(overrides: BudgetOverrides = {}): Budgets {
  const resolved: Record<string, RoleBudgets> = {}
  for (const role of ORCHESTRATION_ROLES) {
    const base = DEFAULT_BUDGETS[role]
    const override = overrides[role] ?? {}
    resolved[role] = Object.freeze({
      quick: override.quick ?? base.quick,
      standard: override.standard ?? base.standard,
      thorough: override.thorough ?? base.thorough,
    })
  }
  return Object.freeze(resolved as unknown as Record<OrchestrationRole, RoleBudgets>)
}

const ALLOWED_MODEL_ROUTE_KEYS = new Set(['provider', 'model', 'reasoningEffort', 'subagentProvider'])

function nonEmptyField(role: string, field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`DSH_ROLES_MODELS: ${role}.${field} must be a non-empty string`)
  }
  return value.trim()
}

function parseRoleModelEntry(role: string, rawSpec: unknown): RoleModelRoute {
  if (typeof rawSpec === 'string') {
    const trimmed = rawSpec.trim()
    const slash = trimmed.indexOf('/')
    if (slash <= 0 || slash === trimmed.length - 1) {
      throw new Error(`DSH_ROLES_MODELS: ${role} string route must be "provider/model"`)
    }
    const provider = trimmed.slice(0, slash).trim()
    const model = trimmed.slice(slash + 1).trim()
    if (provider === '' || model === '') {
      throw new Error(`DSH_ROLES_MODELS: ${role} string route must be "provider/model"`)
    }
    return Object.freeze({ provider, model })
  }
  if (!isRecord(rawSpec)) {
    throw new Error(`DSH_ROLES_MODELS: ${role} must be a "provider/model" string or an object`)
  }
  for (const key of Object.keys(rawSpec)) {
    if (!ALLOWED_MODEL_ROUTE_KEYS.has(key)) {
      throw new Error(`DSH_ROLES_MODELS: unknown key "${key}" for role "${role}"`)
    }
  }
  const provider = nonEmptyField(role, 'provider', rawSpec.provider)
  const model = nonEmptyField(role, 'model', rawSpec.model)
  const reasoningEffort = nonEmptyField(role, 'reasoningEffort', rawSpec.reasoningEffort)
  const subagentProvider = nonEmptyField(role, 'subagentProvider', rawSpec.subagentProvider)
  if ((provider !== undefined) !== (model !== undefined)) {
    throw new Error(`DSH_ROLES_MODELS: ${role} requires both "provider" and "model"`)
  }
  if (reasoningEffort !== undefined && (provider === undefined || model === undefined)) {
    throw new Error(`DSH_ROLES_MODELS: ${role}.reasoningEffort requires both "provider" and "model"`)
  }
  if (provider === undefined && model === undefined && subagentProvider === undefined) {
    throw new Error(`DSH_ROLES_MODELS: ${role} must specify at least "provider"/"model" or "subagentProvider"`)
  }
  return Object.freeze({
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(subagentProvider === undefined ? {} : { subagentProvider }),
  })
}

/**
 * Validate per-role model and subagent-provider overrides.
 * @param raw - parsed JSON, a Loader-row object, or `undefined`.
 * @returns checked overrides keyed by configurable role.
 */
export function parseModelOverrides(raw: unknown): Partial<Record<ConfigurableModelRole, RoleModelRoute>> {
  if (raw === undefined || raw === null) return {}
  let value = raw
  if (typeof raw === 'string') {
    if (raw.trim() === '') return {}
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('DSH_ROLES_MODELS must be valid JSON')
    }
  }
  if (!isRecord(value)) throw new Error('DSH_ROLES_MODELS must be a JSON object')
  const overrides: Partial<Record<ConfigurableModelRole, RoleModelRoute>> = {}
  for (const [role, spec] of Object.entries(value)) {
    if (role === 'fork') {
      throw new Error(
        'DSH_ROLES_MODELS: role "fork" always inherits the parent model and local fork provider for KV-cache reuse',
      )
    }
    if (!(CONFIGURABLE_MODEL_ROLES as readonly string[]).includes(role)) {
      throw new Error(
        `DSH_ROLES_MODELS: unknown role "${role}"; expected ${CONFIGURABLE_MODEL_ROLES.join(', ')}`,
      )
    }
    overrides[role as ConfigurableModelRole] = parseRoleModelEntry(role, spec)
  }
  return overrides
}

const ALLOWED_REMINDER_KEYS = new Set(['nudgeInspectionSteps', 'maxNudges', 'catalogRefreshTurns'])

function boundedInteger(field: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`DSH_ROLES_REMINDERS: ${field} must be an integer between ${min} and ${max}`)
  }
  return value
}

/**
 * Validate partial reminder threshold overrides (`nudgeInspectionSteps`, `maxNudges`, `catalogRefreshTurns`).
 * @param raw - parsed JSON, a Loader-row object, or `undefined`.
 * @returns checked partial override.
 */
export function parseReminderOverrides(raw: unknown): ReminderOverrides {
  if (raw === undefined || raw === null) return {}
  let value = raw
  if (typeof raw === 'string') {
    if (raw.trim() === '') return {}
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('DSH_ROLES_REMINDERS must be valid JSON')
    }
  }
  if (!isRecord(value)) throw new Error('DSH_ROLES_REMINDERS must be a JSON object')
  for (const key of Object.keys(value)) {
    if (!ALLOWED_REMINDER_KEYS.has(key)) {
      throw new Error(`DSH_ROLES_REMINDERS: unknown key "${key}"`)
    }
  }
  const overrides: {
    nudgeInspectionSteps?: number
    maxNudges?: number
    catalogRefreshTurns?: number
  } = {}
  if (value.nudgeInspectionSteps !== undefined) {
    overrides.nudgeInspectionSteps = boundedInteger(
      'nudgeInspectionSteps',
      value.nudgeInspectionSteps,
      MIN_NUDGE_INSPECTION_STEPS,
      MAX_NUDGE_INSPECTION_STEPS,
    )
  }
  if (value.maxNudges !== undefined) {
    overrides.maxNudges = boundedInteger('maxNudges', value.maxNudges, 0, MAX_DELEGATION_NUDGES_LIMIT)
  }
  if (value.catalogRefreshTurns !== undefined) {
    overrides.catalogRefreshTurns = boundedInteger(
      'catalogRefreshTurns',
      value.catalogRefreshTurns,
      0,
      MAX_CATALOG_REFRESH_TURNS,
    )
  }
  return overrides
}

/**
 * Merge validated reminder overrides over the shipped defaults.
 * @param overrides - checked partial override.
 * @returns complete, frozen reminder configuration.
 */
export function resolveReminders(overrides: ReminderOverrides = {}): ReminderConfig {
  return Object.freeze({
    nudgeInspectionSteps: overrides.nudgeInspectionSteps ?? DEFAULT_REMINDERS.nudgeInspectionSteps,
    maxNudges: overrides.maxNudges ?? DEFAULT_REMINDERS.maxNudges,
    catalogRefreshTurns: overrides.catalogRefreshTurns ?? DEFAULT_REMINDERS.catalogRefreshTurns,
  })
}

function route(
  provider: string | undefined,
  model: string | undefined,
  source: string,
): Readonly<{ provider: string; model: string }> | undefined {
  if (provider === undefined && model === undefined) return undefined
  if (provider === undefined || model === undefined) {
    throw new Error(`${source} requires both a provider and a model`)
  }
  return Object.freeze({ provider, model })
}

/**
 * Resolve the plugin's effective configuration: explicit Loader-row values
 * first, then environment defaults, then the shipped values.
 * Every configurable role inherits the parent session's model unless
 * explicitly overridden.
 * @param config - the Loader row configuration (plain or Volatile-wrapped).
 * @param env - process environment, injectable for tests.
 * @returns validated configuration with per-role routes, budgets, and reminders.
 */
export function resolveOrchestrationConfig(
  config: PluginConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const plain = unwrapPluginConfig(config)
  const envModels = parseModelOverrides(env.DSH_ROLES_MODELS)
  const configModels = parseModelOverrides(plain.models)
  const legacyExploreRoute = route(
    plain.exploreProvider ?? env.DSH_ROLES_EXPLORE_PROVIDER,
    plain.exploreModel ?? env.DSH_ROLES_EXPLORE_MODEL,
    'DSH_ROLES_EXPLORE_PROVIDER / DSH_ROLES_EXPLORE_MODEL',
  )
  const models: ResolvedModels = Object.freeze({
    'general-purpose': configModels['general-purpose'] ?? envModels['general-purpose'],
    explore: configModels.explore ?? envModels.explore ?? legacyExploreRoute,
    plan: configModels.plan ?? envModels.plan,
    'dsh-code-guide': configModels['dsh-code-guide'] ?? envModels['dsh-code-guide'],
  })
  const exploreRoute = models.explore?.provider !== undefined && models.explore?.model !== undefined
    ? Object.freeze({ provider: models.explore.provider, model: models.explore.model })
    : undefined
  const overrides = plain.budgets === undefined
    ? parseBudgetOverrides(env.DSH_ROLES_BUDGETS)
    : parseBudgetOverrides(plain.budgets)
  const reminderOverrides = plain.reminders === undefined
    ? parseReminderOverrides(env.DSH_ROLES_REMINDERS)
    : parseReminderOverrides(plain.reminders)
  return Object.freeze({
    exploreRoute,
    models,
    budgets: resolveBudgets(overrides),
    reminders: resolveReminders(reminderOverrides),
  })
}

/**
 * Resolve one role and thoroughness to its step budget.
 * @param budgets - complete budget table.
 * @param role - delegated role.
 * @param thoroughness - selected task size.
 * @returns the maximum admitted step.
 */
export function stepBudget(budgets: Budgets, role: OrchestrationRole, thoroughness: Thoroughness): number {
  return budgets[role][thoroughness]
}
