/** Browser configuration card rendered on the Plugins page for `dsh-orchestration`. */

import { useId } from 'react'
import { SettingsForm, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, ObservableSnapshot, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  CONFIGURABLE_ROLES,
  encodeLlmSelection,
  encodeSubagentSelection,
} from './controller.js'
import type { ConfigurableRole, OrchestrationCardState } from './controller.js'
import { formLabels, NS } from './locales.js'
import type { OrchestrationLocaleKey } from './locales.js'

const CSS_TAG_ID = 'dsh-orchestration/OrchestrationSettingsCard'

const CARD_CSS = `
.dsh-orch-section {
  min-width: 0;
  padding: 18px 0;
  display: grid;
  gap: 14px;
}
.dsh-orch-section:first-child {
  padding-top: 4px;
}
.dsh-orch-section + .dsh-orch-section {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-orch-section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.dsh-orch-section-title-wrap {
  display: grid;
  gap: 4px;
  min-width: 0;
  flex: 1 1 280px;
}
.dsh-orch-heading {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: -0.01em;
  color: var(--dsw-alias-label-primary);
}
.dsh-orch-intro,
.dsh-orch-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-orch-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-2);
  font-size: 11px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.dsh-orch-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-state-success-primary, #10b981);
  flex-shrink: 0;
}
.dsh-orch-banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-lg);
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-2);
  font-size: 12px;
  line-height: 1.55;
  color: var(--dsw-alias-label-secondary);
}
.dsh-orch-banner-body {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.dsh-orch-banner-title {
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dsh-orch-banner[data-tone="info"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 28%, var(--dsw-alias-border-l3));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 6%, var(--dsw-alias-bg-layer-2));
}
.dsh-orch-banner[data-tone="warn"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 32%, var(--dsw-alias-border-l3));
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 7%, var(--dsw-alias-bg-layer-2));
}
.dsh-orch-banner[data-tone="error"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 36%, var(--dsw-alias-border-l3));
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 7%, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
.dsh-orch-role-list {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.dsh-orch-role-card {
  display: grid;
  gap: 10px;
  min-width: 0;
  padding: 14px 16px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-2);
  transition: border-color 140ms ease, background-color 140ms ease;
}
.dsh-orch-role-card:hover {
  border-color: var(--dsw-alias-border-l4);
}
.dsh-orch-role-card[data-overridden="true"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 42%, var(--dsw-alias-border-l3));
  box-shadow: inset 3px 0 0 var(--dsw-alias-state-business-primary, #3b82f6);
}
.dsh-orch-role-card[data-locked="true"] {
  border-style: dashed;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 70%, transparent);
}
.dsh-orch-role-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  flex-wrap: wrap;
}
.dsh-orch-role-identity {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.dsh-orch-role-icon {
  width: 30px;
  height: 30px;
  border-radius: var(--dsw-radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-secondary);
}
.dsh-orch-role-icon[data-accent="strong"] {
  color: var(--dsw-alias-state-business-primary, #3b82f6);
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 28%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 11%, var(--dsw-alias-bg-layer-3));
}
.dsh-orch-role-icon[data-accent="fast"] {
  color: var(--dsw-alias-state-success-primary, #10b981);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #10b981) 28%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #10b981) 11%, var(--dsw-alias-bg-layer-3));
}
.dsh-orch-role-icon[data-accent="reasoning"] {
  color: var(--dsw-alias-state-warn-primary, #f59e0b);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 30%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 12%, var(--dsw-alias-bg-layer-3));
}
.dsh-orch-role-icon[data-accent="docs"] {
  color: var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary, #3b82f6));
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 24%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3b82f6) 9%, var(--dsw-alias-bg-layer-3));
}
.dsh-orch-role-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.dsh-orch-role-label {
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--dsw-alias-label-primary);
}
.dsh-orch-role-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--dsw-radius-sm, 5px);
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-tertiary);
}
.dsh-orch-cap-chip {
  font-size: 11px;
  line-height: 1.4;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-orch-badges {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.dsh-orch-link-btn {
  border: 0;
  padding: 2px 6px;
  border-radius: var(--dsw-radius-sm, 5px);
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary);
  transition: color 120ms ease, background-color 120ms ease;
}
.dsh-orch-link-btn:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-4));
}
.dsh-orch-link-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.dsh-orch-role-desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--dsw-alias-label-secondary);
}
.dsh-orch-advice {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 7px 10px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  border: 0.5px solid var(--dsw-alias-border-l2);
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-orch-advice-icon {
  width: 14px;
  height: 14px;
  margin-top: 2px;
  flex-shrink: 0;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-orch-advice[data-accent="strong"] .dsh-orch-advice-icon {
  color: var(--dsw-alias-state-business-primary, #3b82f6);
}
.dsh-orch-advice[data-accent="fast"] .dsh-orch-advice-icon {
  color: var(--dsw-alias-state-success-primary, #10b981);
}
.dsh-orch-advice[data-accent="reasoning"] .dsh-orch-advice-icon {
  color: var(--dsw-alias-state-warn-primary, #f59e0b);
}
.dsh-orch-advice[data-accent="docs"] .dsh-orch-advice-icon {
  color: var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary, #3b82f6));
}
.dsh-orch-controls {
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr);
}
.dsh-orch-controls[data-has-effort="true"] {
  grid-template-columns: minmax(0, 1.6fr) minmax(150px, 1fr);
}
@media (max-width: 560px) {
  .dsh-orch-controls[data-has-effort="true"] {
    grid-template-columns: minmax(0, 1fr);
  }
}
.dsh-orch-field {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.dsh-orch-field-label {
  font-size: 11px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-orch-select-wrap {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
}
.dsh-orch-select {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  min-width: 0;
  height: 36px;
  padding: 0 32px 0 11px;
  border-radius: var(--dsw-radius-md);
  border: 0.5px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-layer-3));
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}
.dsh-orch-select:hover:not(:disabled) {
  border-color: var(--dsw-alias-label-tertiary);
}
.dsh-orch-select:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
}
.dsh-orch-select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.dsh-orch-select-chevron {
  position: absolute;
  right: 10px;
  width: 14px;
  height: 14px;
  pointer-events: none;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-orch-locked-bar {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: fit-content;
  max-width: 100%;
  padding: 6px 10px;
  border-radius: var(--dsw-radius-md);
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-3);
  font-size: 12px;
  line-height: 1.4;
  color: var(--dsw-alias-label-tertiary);
}
`

function ensureStylesInjected(): void {
  if (typeof document === 'undefined') return
  const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`)
  if (existing !== null) {
    if (existing.textContent !== CARD_CSS) existing.textContent = CARD_CSS
    return
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-orchestration'
  tag.dataset.pluginCss = CSS_TAG_ID
  tag.textContent = CARD_CSS
  document.head.appendChild(tag)
}

ensureStylesInjected()

type RoleAccent = 'strong' | 'fast' | 'reasoning' | 'docs' | 'locked'
type RoleTagTone = 'info' | 'success' | 'warning' | 'neutral'

interface RolePresentation {
  readonly label: OrchestrationLocaleKey
  readonly hint: OrchestrationLocaleKey
  readonly advice: OrchestrationLocaleKey
  readonly tierLabel: OrchestrationLocaleKey
  readonly tierTone: RoleTagTone
  readonly capability: OrchestrationLocaleKey
  readonly accent: RoleAccent
}

const ROLE_PRESENTATION: Record<ConfigurableRole, RolePresentation> = {
  'general-purpose': {
    label: 'roleGeneralPurposeLabel',
    hint: 'roleGeneralPurposeHint',
    advice: 'roleGeneralPurposeAdvice',
    tierLabel: 'tierStrong',
    tierTone: 'info',
    capability: 'capReadWriteShell',
    accent: 'strong',
  },
  explore: {
    label: 'roleExploreLabel',
    hint: 'roleExploreHint',
    advice: 'roleExploreAdvice',
    tierLabel: 'tierFast',
    tierTone: 'success',
    capability: 'capReadOnly',
    accent: 'fast',
  },
  plan: {
    label: 'rolePlanLabel',
    hint: 'rolePlanHint',
    advice: 'rolePlanAdvice',
    tierLabel: 'tierReasoning',
    tierTone: 'warning',
    capability: 'capArchitect',
    accent: 'reasoning',
  },
  'dsh-code-guide': {
    label: 'roleGuideLabel',
    hint: 'roleGuideHint',
    advice: 'roleGuideAdvice',
    tierLabel: 'tierBalanced',
    tierTone: 'success',
    capability: 'capDocs',
    accent: 'docs',
  },
}

function RoleGlyph({ role }: { role: ConfigurableRole | 'fork' }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (role) {
    case 'general-purpose':
      return (
        <svg {...common}>
          <path d="M5.5 4.5 2.5 8l3 3.5" />
          <path d="M10.5 4.5 13.5 8l-3 3.5" />
          <path d="M9 3 7 13" />
        </svg>
      )
    case 'explore':
      return (
        <svg {...common}>
          <circle cx="7.25" cy="7.25" r="4.5" />
          <path d="m10.75 10.75 2.75 2.75" />
        </svg>
      )
    case 'plan':
      return (
        <svg {...common}>
          <path d="M8 2.25 13.25 5 8 7.75 2.75 5 8 2.25Z" />
          <path d="m2.75 8.25 5.25 2.75 5.25-2.75" />
          <path d="m2.75 11.25 5.25 2.75 5.25-2.75" />
        </svg>
      )
    case 'dsh-code-guide':
      return (
        <svg {...common}>
          <path d="M3 3.25A1.25 1.25 0 0 1 4.25 2H12.5v11.5H4.25A1.25 1.25 0 0 0 3 14.75V3.25Z" />
          <path d="M3 12.25h9.5" />
          <path d="M6 5.25h4" />
        </svg>
      )
    case 'fork':
      return (
        <svg {...common}>
          <circle cx="4.5" cy="3.5" r="1.5" />
          <circle cx="11.5" cy="3.5" r="1.5" />
          <circle cx="8" cy="12.5" r="1.5" />
          <path d="M4.5 5v1.5c0 1.4 1.1 2 3.5 2s3.5-.6 3.5-2V5" />
          <path d="M8 8.5V11" />
        </svg>
      )
  }
}

function SparkIcon() {
  return (
    <svg
      className="dsh-orch-advice-icon"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.25 9.35 6.1 13.25 7.5 9.35 8.9 8 12.75 6.65 8.9 2.75 7.5 6.65 6.1 8 2.25Z" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg
      className="dsh-orch-select-chevron"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4.25 6.25 3.75 3.75 3.75-3.75" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.25" y="7.25" width="9.5" height="6.5" rx="1.5" />
      <path d="M5.5 7.25V5a2.5 2.5 0 0 1 5 0v2.25" />
    </svg>
  )
}

export interface OrchestrationCardFace {
  hooks: {
    orchestrationCard: ObservableSnapshot<OrchestrationCardState>
  }
  selectRoleRoute: (role: ConfigurableRole, selection: string) => void
  selectRoleEffort: (role: ConfigurableRole, reasoningEffort: string) => void
  resetRole: (role: ConfigurableRole) => void
  retryCatalog: () => void
  save: () => void
  discard: () => void
}

export type OrchestrationSettingsCardProps = PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<typeof NS>
  & InjectFace<OrchestrationCardFace>

export function OrchestrationSettingsCard(props: OrchestrationSettingsCardProps) {
  const { t } = props
  const state = props.useOrchestrationCard(snapshot => snapshot)
  const baseId = useId()

  if (props.view === 'summary') return t('roleModelsIntro')

  const editable = state.writable && !state.saving
  const oarProviders = state.externalProviders.filter(provider => provider.isOar)
  const otherExternalProviders = state.externalProviders.filter(provider => !provider.isOar)
  const catalogEmpty = state.catalogStatus === 'ready'
    && state.externalProviders.length === 0
    && state.llmGroups.length === 0

  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <section className="dsh-orch-section" aria-labelledby={`${baseId}-roles`}>
        <div className="dsh-orch-section-head">
          <div className="dsh-orch-section-title-wrap">
            <h3 className="dsh-orch-heading" id={`${baseId}-roles`}>{t('roleModelsTitle')}</h3>
            <p className="dsh-orch-intro">{t('roleModelsIntro')}</p>
          </div>
          {state.catalogStatus === 'ready' && !catalogEmpty
            ? (
              <span className="dsh-orch-status-pill">
                <span className="dsh-orch-status-dot" aria-hidden="true" />
                {oarProviders.length > 0
                  ? t('statusRuntimesReady', {
                      oarCount: String(oarProviders.length),
                      providerCount: String(state.llmGroups.length),
                    })
                  : t('statusProvidersOnly', {
                      providerCount: String(state.llmGroups.length),
                    })}
              </span>
            )
            : null}
        </div>

        {state.catalogStatus === 'loading'
          ? (
            <div className="dsh-orch-banner" role="status">
              <span>{t('loadingCatalog')}</span>
            </div>
          )
          : null}

        {state.catalogStatus === 'error'
          ? (
            <div className="dsh-orch-banner" data-tone="error" role="alert">
              <span>{t('catalogLoadFailed')}</span>
              <button
                type="button"
                className="dsh-orch-link-btn"
                disabled={state.saving}
                onClick={props.retryCatalog}
              >
                {t('retry')}
              </button>
            </div>
          )
          : null}

        {state.catalogPartial
          ? (
            <div className="dsh-orch-banner" data-tone="warn">
              <span>{t('catalogPartial')}</span>
            </div>
          )
          : null}

        {catalogEmpty
          ? (
            <div className="dsh-orch-banner" data-tone="warn">
              <span>{t('catalogEmpty')}</span>
            </div>
          )
          : null}

        {state.catalogStatus === 'ready' && !state.officialOarInstalled
          ? (
            <div className="dsh-orch-banner" data-tone="info">
              <div className="dsh-orch-banner-body">
                <span className="dsh-orch-banner-title">{t('oarInstallHintTitle')}</span>
                <span>{t('oarInstallHint')}</span>
              </div>
            </div>
          )
          : null}

        {state.conflicted
          ? (
            <div className="dsh-orch-banner" data-tone="error" role="alert">
              <span>{t('conflict')}</span>
            </div>
          )
          : null}

        <div className="dsh-orch-role-list">
          {CONFIGURABLE_ROLES.map((role) => {
            const roleState = state.roles[role]
            const meta = ROLE_PRESENTATION[role]
            const selectId = `${baseId}-role-${role}`
            const effortId = `${baseId}-effort-${role}`
            const showEffort = roleState.efforts.length > 0 || roleState.reasoningEffort !== ''
            const hasKnownEffort = roleState.reasoningEffort === ''
              || roleState.efforts.some(effort => effort.id === roleState.reasoningEffort)

            return (
              <div
                className="dsh-orch-role-card"
                key={role}
                data-overridden={roleState.overridden ? 'true' : 'false'}
              >
                <div className="dsh-orch-role-head">
                  <div className="dsh-orch-role-identity">
                    <span className="dsh-orch-role-icon" data-accent={meta.accent}>
                      <RoleGlyph role={role} />
                    </span>
                    <div className="dsh-orch-role-meta">
                      <label className="dsh-orch-role-label" htmlFor={selectId}>{t(meta.label)}</label>
                      <code className="dsh-orch-role-code">{role}</code>
                      <span className="dsh-orch-cap-chip">{t(meta.capability)}</span>
                    </div>
                  </div>
                  <span className="dsh-orch-badges">
                    <Tag tone={meta.tierTone}>{t(meta.tierLabel)}</Tag>
                    {roleState.overridden
                      ? (
                        <>
                          <Tag tone="solid">{t('overridden')}</Tag>
                          <button
                            type="button"
                            className="dsh-orch-link-btn"
                            disabled={!editable}
                            onClick={() => props.resetRole(role)}
                          >
                            {t('reset')}
                          </button>
                        </>
                      )
                      : null}
                  </span>
                </div>

                <p className="dsh-orch-role-desc">{t(meta.hint)}</p>

                <div className="dsh-orch-advice" data-accent={meta.accent}>
                  <SparkIcon />
                  <span>{t(meta.advice)}</span>
                </div>

                <div className="dsh-orch-controls" data-has-effort={showEffort ? 'true' : 'false'}>
                  <div className="dsh-orch-field">
                    {showEffort
                      ? <span className="dsh-orch-field-label">{t('routeFieldLabel')}</span>
                      : null}
                    <div className="dsh-orch-select-wrap">
                      <select
                        id={selectId}
                        className="dsh-orch-select"
                        value={roleState.selection}
                        disabled={!editable}
                        onChange={(event: { currentTarget: { value: string } }) => {
                          props.selectRoleRoute(role, event.currentTarget.value)
                        }}
                      >
                        <option value="">{t('inheritDefault')}</option>

                        {!roleState.available && roleState.selection !== ''
                          ? (
                            <optgroup label={t('unavailableGroup')}>
                              <option value={roleState.selection}>
                                {t('unavailableOption', { value: roleState.unavailableLabel ?? roleState.selection })}
                              </option>
                            </optgroup>
                          )
                          : null}

                        {oarProviders.length > 0
                          ? (
                            <optgroup label={t('oarGroup')}>
                              {oarProviders.map(provider => (
                                <option key={provider.id} value={encodeSubagentSelection(provider.id)}>
                                  {provider.label}
                                </option>
                              ))}
                            </optgroup>
                          )
                          : null}

                        {otherExternalProviders.length > 0
                          ? (
                            <optgroup label={t('externalGroup')}>
                              {otherExternalProviders.map(provider => (
                                <option key={provider.id} value={encodeSubagentSelection(provider.id)}>
                                  {provider.label}
                                </option>
                              ))}
                            </optgroup>
                          )
                          : null}

                        {state.llmGroups.map(group => (
                          <optgroup key={group.id} label={group.name}>
                            {group.models.map(model => (
                              <option
                                key={`${group.id}/${model.id}`}
                                value={encodeLlmSelection(group.id, model.id)}
                              >
                                {`${model.name} (${group.id}/${model.id})`}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      <ChevronIcon />
                    </div>
                  </div>

                  {showEffort
                    ? (
                      <div className="dsh-orch-field">
                        <label className="dsh-orch-field-label" htmlFor={effortId}>{t('reasoningLabel')}</label>
                        <div className="dsh-orch-select-wrap">
                          <select
                            id={effortId}
                            aria-label={`${t(meta.label)} · ${t('reasoningLabel')}`}
                            className="dsh-orch-select"
                            value={roleState.reasoningEffort}
                            disabled={!editable}
                            onChange={(event: { currentTarget: { value: string } }) => {
                              props.selectRoleEffort(role, event.currentTarget.value)
                            }}
                          >
                            <option value="">{t('reasoningDefault')}</option>
                            {!hasKnownEffort
                              ? (
                                <option value={roleState.reasoningEffort}>
                                  {t('unavailableOption', { value: roleState.reasoningEffort })}
                                </option>
                              )
                              : null}
                            {roleState.efforts.map(effort => (
                              <option key={effort.id} value={effort.id}>{effort.name}</option>
                            ))}
                          </select>
                          <ChevronIcon />
                        </div>
                      </div>
                    )
                    : null}
                </div>
              </div>
            )
          })}

          <div className="dsh-orch-role-card" data-locked="true">
            <div className="dsh-orch-role-head">
              <div className="dsh-orch-role-identity">
                <span className="dsh-orch-role-icon" data-accent="locked">
                  <RoleGlyph role="fork" />
                </span>
                <div className="dsh-orch-role-meta">
                  <span className="dsh-orch-role-label">{t('roleForkLabel')}</span>
                  <code className="dsh-orch-role-code">fork</code>
                  <span className="dsh-orch-cap-chip">{t('capFork')}</span>
                </div>
              </div>
              <span className="dsh-orch-badges">
                <Tag tone="neutral">{t('tierLocked')}</Tag>
              </span>
            </div>

            <p className="dsh-orch-role-desc">{t('roleForkHint')}</p>

            <div className="dsh-orch-advice" data-accent="locked">
              <SparkIcon />
              <span>{t('roleForkAdvice')}</span>
            </div>

            <div className="dsh-orch-locked-bar" aria-label={t('roleForkLabel')}>
              <LockIcon />
              <span>{t('roleForkFixed')}</span>
            </div>
          </div>
        </div>
      </section>
    </SettingsForm>
  )
}
