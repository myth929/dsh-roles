/** Browser plugin entry registering `dsh-roles`'s configuration page into `plugins.bundle.config`. */

import type { BrowserClientContext } from './browser-types.js'
import { OrchestrationSettingsController, ORCHESTRATION_NS } from './controller.js'
import type { HostOptionsView, OrchestrationFormValues } from './controller.js'
import { en, NS, zh } from './locales.js'
import type { OrchestrationLocaleKey } from './locales.js'
import { OrchestrationSettingsCard } from './OrchestrationSettingsCard.js'
import type { OrchestrationCardFace } from './OrchestrationSettingsCard.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    dshRoles: OrchestrationLocaleKey
  }
}

export {
  CONFIGURABLE_ROLES,
  OFFICIAL_NATIVE_SUBAGENT_PLUGINS,
  ORCHESTRATION_NS,
  OrchestrationSettingsController,
  decodeRoleSelection,
  encodeLlmSelection,
  encodeSubagentSelection,
  partitionExternalProviders,
  shortPluginName,
} from './controller.js'
export type {
  CatalogModelItem,
  ConfigurableRole,
  ExternalProviderItem,
  HostOptionsView,
  ModelCatalogView,
  ModelProviderGroup,
  NativePluginCatalogEntry,
  OrchestrationCardDeps,
  OrchestrationCardState,
  OrchestrationFormValues,
  RoleFieldView,
} from './controller.js'
export type { OrchestrationCardFace, OrchestrationSettingsCardProps } from './OrchestrationSettingsCard.js'
export { OrchestrationSettingsCard } from './OrchestrationSettingsCard.js'
export { NS, en, zh } from './locales.js'

/** Required browser host services for plugin settings and live model/OAR discovery. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'remote.session', 'configForms']

/**
 * Mount the `dsh-roles` configuration form on the DSH Plugins page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: BrowserClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-roles: dictionaries')

  const controller = new OrchestrationSettingsController(
    ctx.configForms.get<OrchestrationFormValues>(ORCHESTRATION_NS),
    {
      loadCatalog: async () => {
        const res = await ctx.remote.session.modelCatalog()
        if (!res.ok) throw new Error(res.error.message)
        return res.value
      },
      loadHostOptions: async () => {
        const res = await ctx.connection.rpc.call('/dsh-roles', 'options', {})
        if (!res.ok) throw new Error(res.error.message)
        const value = res.value as Partial<HostOptionsView> | undefined
        return {
          externalProviders: Array.isArray(value?.externalProviders) ? value.externalProviders : [],
        }
      },
    },
  )

  ctx.effect(() => () => { controller.dispose() }, 'dsh-roles: controller')

  ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => {
    void controller.refreshCatalog()
  }), 'dsh-roles: adapter invalidations')

  ctx.effect(() => ctx.remote.$on('llm/models-updated', () => {
    void controller.refreshCatalog()
  }), 'dsh-roles: model invalidations')

  ctx.effect(() => ctx.remote.$on('settings/document-updated', () => {
    void controller.refreshCatalog()
  }), 'dsh-roles: settings invalidations')

  ctx.effect(() => ctx.remote.$on('plugin-manager/changed', () => {
    void controller.refreshCatalog()
  }), 'dsh-roles: plugin invalidations')

  ctx.effect(() => ctx.on('connection/reset', () => {
    controller.resetConnection()
  }), 'dsh-roles: connection reset')

  const face: OrchestrationCardFace = {
    hooks: { orchestrationCard: controller.card },
    selectRoleRoute: (role, selection) => { controller.selectRoleRoute(role, selection) },
    selectRoleEffort: (role, effort) => { controller.selectRoleEffort(role, effort) },
    resetRole: (role) => { controller.resetRole(role) },
    retryCatalog: () => { controller.retryCatalog() },
    save: () => { void controller.save() },
    discard: () => { controller.discard() },
  }

  ctx.effect(() => ctx.configForms.whileServed([ORCHESTRATION_NS], () =>
    ctx.slots.inject('plugins.bundle.config', () =>
      ctx.slots.register({
        name: 'plugins.bundle.config',
        key: ORCHESTRATION_NS,
        locale: NS,
        inject: () => face,
      }, OrchestrationSettingsCard),
    ),
  ), 'dsh-roles: bundle config page')
}
