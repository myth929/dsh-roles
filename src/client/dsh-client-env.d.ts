/**
 * Ambient declarations for browser shell singletons externalized by `scripts/build-client.mjs`
 * and provided by DSH's `window.__ModuleLoader__` at runtime.
 */

declare module 'react' {
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useId(): string
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useRef<T>(initialValue: T): { current: T }
  export function useState<T>(initialValue: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void]
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

  export function Tag(props: {
    tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
    className?: string
    children?: ReactNode
  }): ReactNode

  export interface MenuItem {
    id: string
    label: ReactNode
    disabled?: boolean
    icon?: ReactNode
    danger?: boolean
  }

  export interface MenuSeparator {
    type: 'separator'
    id: string
  }

  export interface MenuLabel {
    type: 'label'
    id: string
    text: string
  }

  export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

  export function Menu(props: {
    open: boolean
    anchor: ReactNode
    items?: readonly MenuEntry[]
    selectedId?: string
    onSelect?: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
    dense?: boolean
    compact?: boolean
    autoFocus?: boolean
    minWidthFromAnchor?: boolean
    className?: string
    listClassName?: string
  }): ReactNode

  export function IconChevronDownOutlineRegular(props: {
    className?: string
    'aria-hidden'?: boolean
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
