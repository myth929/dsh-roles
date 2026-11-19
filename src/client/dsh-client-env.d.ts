/**
 * Ambient declarations for browser shell singletons externalized by `scripts/build-client.mjs`
 * and provided by DSH's `window.__ModuleLoader__` at runtime.
 */

declare module 'react' {
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useId(): string
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useRef<T>(initialValue: T): { current: T }
  export type ReactNode = unknown
}

declare module 'react/jsx-runtime' {
  export function jsx(type: unknown, props: Record<string, unknown>, key?: unknown): unknown
  export function jsxs(type: unknown, props: Record<string, unknown>, key?: unknown): unknown
  export const Fragment: unknown
}

declare namespace JSX {
  type Element = unknown
  interface IntrinsicElements {
    [elemName: string]: Record<string, unknown>
  }
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  export interface SettingsFormShell {
    available: boolean
    writable: boolean
    dirty: boolean
    invalid: boolean
    saving: boolean
    failed: boolean
  }

  export interface SettingsFormLabels {
    unavailable: string
    readOnly: string
    saveFailed: string
    save: string
    saving: string
  }

  export interface SettingsFieldState {
    text: string
    overridden: boolean
    invalid: boolean
  }

  export interface SettingsFormPathOp {
    op: 'set' | 'unset'
    path: readonly string[]
    value?: unknown
  }

  export interface SettingsFormScopeSnapshot<T> {
    status: 'loading' | 'ready' | 'unavailable'
    value: T | undefined
    base: unknown
    user: unknown
    writable: boolean
    revision: number | undefined
  }

  export interface SettingsFormScope<T> {
    getSnapshot(): SettingsFormScopeSnapshot<T>
    subscribe(listener: () => void): () => void
    mutate(ops: readonly SettingsFormPathOp[], expectedRevision?: number): Promise<boolean>
  }

  export function SettingsForm(props: {
    labels: SettingsFormLabels
    state: SettingsFormShell
    onSave: () => void
    onDiscard: () => void
    children?: ReactNode
  }): ReactNode

  export function SettingsValueField(props: {
    id: string
    label: string
    hint?: string
    text: string
    overridden: boolean
    invalid: boolean
    overriddenLabel: string
    resetLabel: string
    invalidLabel: string
    disabled: boolean
    numeric?: boolean
    placeholder?: string
    onEdit: (text: string) => void
    onReset: () => void
  }): ReactNode

  export function Switch(props: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string
    className?: string
  }): ReactNode

  export function Tag(props: {
    tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
    className?: string
    children?: ReactNode
  }): ReactNode

  export function Button(props: {
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    disabled?: boolean
    className?: string
    onClick?: () => void
    children?: ReactNode
  }): ReactNode
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface ObservableSnapshot<T> {
    getSnapshot(): T
    subscribe(fn: () => void): () => void
  }

  export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S) => S

  export interface LocaleNamespaceMap {}

  export interface SlotMap {
    'plugins.bundle.config': {
      kind: 'keyed'
      scope: 'root'
      owner: { readonly view: 'summary' | 'page' }
    }
  }

  export type PropsRuntime<Slot extends string> = Slot extends keyof SlotMap
    ? SlotMap[Slot]['owner']
    : (Slot extends 'plugins.bundle.config' ? { readonly view: 'page' | 'summary' } : Record<string, unknown>)

  export type PropsLocale<NS extends string> = {
    readonly t: (
      key: NS extends keyof LocaleNamespaceMap ? LocaleNamespaceMap[NS] : string,
      params?: Record<string, string>,
    ) => string
  }

  type Camelize<S extends string> = S extends `${infer A}.${infer B}`
    ? `${A}${Capitalize<Camelize<B>>}`
    : S

  export type InjectFace<Face extends { hooks?: Record<string, unknown> }> = Omit<Face, 'hooks'> & {
    [K in keyof NonNullable<Face['hooks']> as `use${Capitalize<string & K>}`]:
      NonNullable<Face['hooks']>[K] extends ObservableSnapshot<infer T>
        ? SnapshotSelectorHook<T>
        : never
  }
}
