/** Staged configuration controller for the `dsh-orchestration` plugin page. */

import type { SettingsFormPathOp, SettingsFormScope, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-ui-slots'

export const ORCHESTRATION_NS = 'dsh-orchestration'
export const CONFIGURABLE_ROLES = ['general-purpose', 'explore', 'plan', 'dsh-code-guide'] as const
export type ConfigurableRole = typeof CONFIGURABLE_ROLES[number]

export interface ModelReasoningEffortOption {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface CatalogModelItem {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: {
    readonly efforts?: readonly ModelReasoningEffortOption[]
  }
}

export interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly CatalogModelItem[]
}

export interface ModelCatalogView {
  readonly default: { readonly provider: string; readonly model: string }
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
}

export interface ExternalProviderItem {
  readonly id: string
  readonly label: string
  readonly runtime?: string
  readonly model?: string
  readonly isOar: boolean
}

export interface HostOptionsView {
  readonly externalProviders: readonly ExternalProviderItem[]
  readonly officialOarInstalled: boolean
}

export interface OrchestrationFormValues {
  exploreProvider?: string
  exploreModel?: string
  models?: unknown
  budgets?: unknown
}

export interface RoleDraft {
  readonly selection: string
  readonly reasoningEffort: string
}

export interface RoleFieldView {
  readonly role: ConfigurableRole
  readonly selection: string
  readonly reasoningEffort: string
  readonly overridden: boolean
  readonly available: boolean
  readonly unavailableLabel?: string
  readonly efforts: readonly ModelReasoningEffortOption[]
}

export interface OrchestrationCardState extends SettingsFormShell {
  readonly conflicted: boolean
  readonly catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  readonly catalogPartial: boolean
  readonly externalProviders: readonly ExternalProviderItem[]
  readonly officialOarInstalled: boolean
  readonly llmGroups: readonly ModelProviderGroup[]
  readonly roles: Readonly<Record<ConfigurableRole, RoleFieldView>>
}

export interface OrchestrationCardDeps {
  readonly loadCatalog: () => Promise<ModelCatalogView>
  readonly loadHostOptions: () => Promise<HostOptionsView>
}

interface InternalStore<T> extends ObservableSnapshot<T> {
  set(next: T): void
}

function createStore<T>(initial: T): InternalStore<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      if (Object.is(state, next)) return
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const EMPTY_ROLE: RoleDraft = { selection: '', reasoningEffort: '' }

/** Encode an LLM provider/model pair into one select option value. */
export function encodeLlmSelection(provider: string, model: string): string {
  return `llm:${provider}\0${model}`
}

/** Encode an external/OAR subagent provider into one select option value. */
export function encodeSubagentSelection(providerId: string): string {
  return `subagent:${providerId}`
}

/** Decode a select option value into either a subagent runtime or an LLM provider/model pair. */
export function decodeRoleSelection(selection: string):
  | { readonly kind: 'inherit' }
  | { readonly kind: 'subagent'; readonly subagentProvider: string }
  | { readonly kind: 'llm'; readonly provider: string; readonly model: string } {
  if (selection === '') return { kind: 'inherit' }
  if (selection.startsWith('subagent:')) {
    return { kind: 'subagent', subagentProvider: selection.slice('subagent:'.length) }
  }
  if (selection.startsWith('llm:')) {
    const rest = selection.slice('llm:'.length)
    const sep = rest.indexOf('\0')
    if (sep > 0 && sep < rest.length - 1) {
      return { kind: 'llm', provider: rest.slice(0, sep), model: rest.slice(sep + 1) }
    }
  }
  return { kind: 'inherit' }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRoleSpec(raw: unknown): RoleDraft | undefined {
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    const slash = trimmed.indexOf('/')
    if (slash <= 0 || slash === trimmed.length - 1) return undefined
    const provider = trimmed.slice(0, slash).trim()
    const model = trimmed.slice(slash + 1).trim()
    if (provider === '' || model === '') return undefined
    return { selection: encodeLlmSelection(provider, model), reasoningEffort: '' }
  }
  if (!isPlainObject(raw)) return undefined
  if (typeof raw.subagentProvider === 'string' && raw.subagentProvider.trim() !== '') {
    return { selection: encodeSubagentSelection(raw.subagentProvider.trim()), reasoningEffort: '' }
  }
  if (typeof raw.provider === 'string' && raw.provider.trim() !== '' && typeof raw.model === 'string' && raw.model.trim() !== '') {
    const effort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : ''
    return {
      selection: encodeLlmSelection(raw.provider.trim(), raw.model.trim()),
      reasoningEffort: effort,
    }
  }
  return undefined
}

function parseStoredModels(layer: unknown): Partial<Record<ConfigurableRole, RoleDraft>> {
  if (!isPlainObject(layer)) return {}
  let rawModels = layer.models
  if (typeof rawModels === 'string') {
    if (rawModels.trim() === '') rawModels = {}
    else {
      try {
        rawModels = JSON.parse(rawModels)
      } catch {
        rawModels = {}
      }
    }
  }
  const result: Partial<Record<ConfigurableRole, RoleDraft>> = {}
  if (isPlainObject(rawModels)) {
    for (const role of CONFIGURABLE_ROLES) {
      const parsed = parseRoleSpec(rawModels[role])
      if (parsed !== undefined) result[role] = parsed
    }
  }
  if (
    result.explore === undefined
    && typeof layer.exploreProvider === 'string' && layer.exploreProvider.trim() !== ''
    && typeof layer.exploreModel === 'string' && layer.exploreModel.trim() !== ''
  ) {
    result.explore = {
      selection: encodeLlmSelection(layer.exploreProvider.trim(), layer.exploreModel.trim()),
      reasoningEffort: '',
    }
  }
  return result
}

function sameDraft(a: RoleDraft, b: RoleDraft): boolean {
  return a.selection === b.selection && a.reasoningEffort === b.reasoningEffort
}

function serializeRoleDraft(draft: RoleDraft): Record<string, string> | undefined {
  const decoded = decodeRoleSelection(draft.selection)
  if (decoded.kind === 'inherit') return undefined
  if (decoded.kind === 'subagent') return { subagentProvider: decoded.subagentProvider }
  return {
    provider: decoded.provider,
    model: decoded.model,
    ...(draft.reasoningEffort === '' ? {} : { reasoningEffort: draft.reasoningEffort }),
  }
}

export class OrchestrationSettingsController {
  private llmGroups: readonly ModelProviderGroup[] = []
  private externalProviders: readonly ExternalProviderItem[] = []
  private officialOarInstalled = false
  private catalogStatus: OrchestrationCardState['catalogStatus'] = 'idle'
  private catalogPartial = false

  private draftRoles = new Map<ConfigurableRole, RoleDraft>()
  private resetRoles = new Set<ConfigurableRole>()
  private draftRevision: number | undefined

  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private catalogGeneration = 0
  private readonly store: InternalStore<OrchestrationCardState>
  private readonly unsubscribe: () => void

  constructor(
    private readonly scope: SettingsFormScope<OrchestrationFormValues>,
    private readonly deps: OrchestrationCardDeps,
  ) {
    this.store = createStore(this.project())
    this.unsubscribe = scope.subscribe(() => {
      if (this.disposed) return
      const snap = this.scope.getSnapshot()
      if (this.hasDrafts() && this.draftRevision !== undefined && snap.revision !== this.draftRevision) {
        this.conflicted = true
      }
      this.publish()
    })
    void this.refreshCatalog()
  }

  get card(): ObservableSnapshot<OrchestrationCardState> {
    return this.store
  }

  dispose(): void {
    this.disposed = true
    this.catalogGeneration += 1
    this.unsubscribe()
  }

  resetConnection(): void {
    if (this.disposed) return
    this.catalogStatus = 'idle'
    this.publish()
    void this.refreshCatalog()
  }

  retryCatalog(): void {
    if (this.disposed) return
    void this.refreshCatalog()
  }

  async refreshCatalog(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.catalogGeneration
    this.catalogStatus = 'loading'
    this.publish()

    const [catalogOutcome, optionsOutcome] = await Promise.allSettled([
      this.deps.loadCatalog(),
      this.deps.loadHostOptions(),
    ])
    if (this.disposed || generation !== this.catalogGeneration) return

    if (catalogOutcome.status === 'fulfilled') {
      this.llmGroups = catalogOutcome.value.groups
        .filter(group => !group.id.startsWith('relay-') && group.models.length > 0)
      this.catalogPartial = catalogOutcome.value.failures.length > 0
    }
    if (optionsOutcome.status === 'fulfilled') {
      this.externalProviders = optionsOutcome.value.externalProviders
      this.officialOarInstalled = optionsOutcome.value.officialOarInstalled
    }

    if (catalogOutcome.status === 'rejected' && optionsOutcome.status === 'rejected') {
      this.catalogStatus = 'error'
    } else {
      this.catalogStatus = 'ready'
      if (catalogOutcome.status === 'rejected' || optionsOutcome.status === 'rejected') {
        this.catalogPartial = true
      }
    }
    this.publish()
  }

  selectRoleRoute(role: ConfigurableRole, selection: string): void {
    if (this.disposed || this.saving) return
    const snap = this.scope.getSnapshot()
    if (snap.status !== 'ready' || !snap.writable) return
    this.stageDraftRevision(snap.revision)
    const decoded = decodeRoleSelection(selection)
    if (decoded.kind === 'inherit') {
      this.resetRoles.add(role)
      this.draftRoles.set(role, EMPTY_ROLE)
    } else {
      this.resetRoles.delete(role)
      const existing = this.draftRoles.get(role)
      const keepEffort = decoded.kind === 'llm' && existing?.selection === selection ? existing.reasoningEffort : ''
      this.draftRoles.set(role, { selection, reasoningEffort: keepEffort })
    }
    this.failed = false
    this.publish()
  }

  selectRoleEffort(role: ConfigurableRole, reasoningEffort: string): void {
    if (this.disposed || this.saving) return
    const snap = this.scope.getSnapshot()
    if (snap.status !== 'ready' || !snap.writable) return
    this.stageDraftRevision(snap.revision)
    const current = this.currentRoleDraft(role, snap)
    if (!current.selection.startsWith('llm:')) return
    this.resetRoles.delete(role)
    this.draftRoles.set(role, { selection: current.selection, reasoningEffort })
    this.failed = false
    this.publish()
  }

  resetRole(role: ConfigurableRole): void {
    if (this.disposed || this.saving) return
    const snap = this.scope.getSnapshot()
    if (snap.status !== 'ready' || !snap.writable) return
    this.stageDraftRevision(snap.revision)
    const baseModels = parseStoredModels(snap.base)
    this.resetRoles.add(role)
    this.draftRoles.set(role, baseModels[role] ?? EMPTY_ROLE)
    this.failed = false
    this.publish()
  }

  discard(): void {
    if (this.disposed || this.saving) return
    this.clearDrafts()
    this.publish()
  }

  async save(): Promise<void> {
    if (this.disposed || this.saving) return
    const state = this.store.getSnapshot()
    if (!state.available || !state.writable || !state.dirty || state.invalid) return
    const snap = this.scope.getSnapshot()
    const baseModels = parseStoredModels(snap.base)
    const userModels = parseStoredModels(snap.user)
    const effectiveModels = parseStoredModels(snap.value)

    const ops: SettingsFormPathOp[] = []

    // Compute per-role model map updates over the user layer.
    const nextUserModels: Record<string, unknown> = {}
    let rolesDirty = false
    for (const role of CONFIGURABLE_ROLES) {
      const staged = this.draftRoles.get(role)
      const isReset = this.resetRoles.has(role)
      const baseRole = baseModels[role] ?? EMPTY_ROLE
      const existingEffective = effectiveModels[role] ?? baseRole
      const draft = staged ?? existingEffective
      const wasUserOverridden = userModels[role] !== undefined
      if (isReset) {
        if (wasUserOverridden) rolesDirty = true
        continue
      }
      if (staged !== undefined) {
        if (!sameDraft(staged, existingEffective)) rolesDirty = true
        const serialized = serializeRoleDraft(draft)
        if (serialized !== undefined) nextUserModels[role] = serialized
        else if (wasUserOverridden) rolesDirty = true
      } else if (wasUserOverridden) {
        const serialized = serializeRoleDraft(userModels[role]!)
        if (serialized !== undefined) nextUserModels[role] = serialized
      }
    }

    if (rolesDirty || this.draftRoles.size > 0) {
      if (Object.keys(nextUserModels).length === 0) ops.push({ op: 'unset', path: ['models'] })
      else ops.push({ op: 'set', path: ['models'], value: nextUserModels })
    }

    if (ops.length === 0) {
      this.clearDrafts()
      this.publish()
      return
    }

    this.saving = true
    this.failed = false
    this.publish()
    try {
      const accepted = await this.scope.mutate(ops, this.draftRevision ?? snap.revision)
      if (this.disposed) return
      if (accepted) {
        this.clearDrafts()
      } else {
        this.failed = true
      }
    } catch {
      if (!this.disposed) this.failed = true
    } finally {
      if (!this.disposed) {
        this.saving = false
        this.publish()
      }
    }
  }

  private hasDrafts(): boolean {
    return this.draftRoles.size > 0 || this.resetRoles.size > 0
  }

  private stageDraftRevision(revision: number | undefined): void {
    if (!this.hasDrafts()) this.draftRevision = revision
  }

  private clearDrafts(): void {
    this.draftRoles.clear()
    this.resetRoles.clear()
    this.draftRevision = undefined
    this.failed = false
    this.conflicted = false
  }

  private currentRoleDraft(role: ConfigurableRole, snap: ReturnType<SettingsFormScope<OrchestrationFormValues>['getSnapshot']>): RoleDraft {
    const staged = this.draftRoles.get(role)
    if (staged !== undefined) return staged
    const effective = parseStoredModels(snap.value)[role]
    if (effective !== undefined) return effective
    return parseStoredModels(snap.base)[role] ?? EMPTY_ROLE
  }

  private publish(): void {
    this.store.set(this.project())
  }

  private project(): OrchestrationCardState {
    const snap = this.scope.getSnapshot()
    const available = snap.status === 'ready'
    const baseModels = parseStoredModels(snap.base)
    const userModels = parseStoredModels(snap.user)
    const effectiveModels = parseStoredModels(snap.value)

    const roleViews = {} as Record<ConfigurableRole, RoleFieldView>
    let anyRoleDirty = false

    for (const role of CONFIGURABLE_ROLES) {
      const staged = this.draftRoles.get(role)
      const isReset = this.resetRoles.has(role)
      const baseRole = baseModels[role] ?? EMPTY_ROLE
      const effectiveRole = effectiveModels[role] ?? baseRole
      const draft = staged ?? effectiveRole
      const userHasRole = userModels[role] !== undefined

      const overridden = isReset
        ? false
        : (staged === undefined ? userHasRole : (draft.selection !== '' && (!sameDraft(draft, baseRole) || userHasRole)))
      if ((staged !== undefined && !sameDraft(draft, effectiveRole)) || (isReset && userHasRole)) {
        anyRoleDirty = true
      }

      const decoded = decodeRoleSelection(draft.selection)
      let isRouteAvailable = true
      let unavailableLabel: string | undefined
      let efforts: readonly ModelReasoningEffortOption[] = []

      if (decoded.kind === 'subagent') {
        isRouteAvailable = this.externalProviders.some(provider => provider.id === decoded.subagentProvider)
        if (!isRouteAvailable && this.catalogStatus === 'ready') unavailableLabel = decoded.subagentProvider
        else if (!isRouteAvailable && this.catalogStatus !== 'ready') isRouteAvailable = true
      } else if (decoded.kind === 'llm') {
        const group = this.llmGroups.find(item => item.id === decoded.provider)
        const model = group?.models.find(item => item.id === decoded.model)
        if (model !== undefined) {
          efforts = model.reasoning?.efforts ?? []
        } else if (this.catalogStatus === 'ready') {
          isRouteAvailable = false
          unavailableLabel = `${decoded.provider}/${decoded.model}`
        }
      }

      roleViews[role] = {
        role,
        selection: draft.selection,
        reasoningEffort: draft.reasoningEffort,
        overridden,
        available: isRouteAvailable,
        ...(unavailableLabel === undefined ? {} : { unavailableLabel }),
        efforts,
      }
    }

    return {
      available,
      writable: snap.writable,
      dirty: available && anyRoleDirty,
      invalid: this.conflicted && available,
      saving: this.saving,
      failed: this.failed,
      conflicted: this.conflicted,
      catalogStatus: this.catalogStatus,
      catalogPartial: this.catalogPartial,
      externalProviders: this.externalProviders,
      officialOarInstalled: this.officialOarInstalled,
      llmGroups: this.llmGroups,
      roles: roleViews,
    }
  }
}
