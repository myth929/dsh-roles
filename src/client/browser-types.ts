/** Browser-side host & Cordis service contract consumed by `src/client/index.ts`. */

import type { ReactNode } from 'react'
import type { SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelCatalogView } from './controller.js'

export type RemoteEventName =
  | 'llm/adapters-updated'
  | 'llm/models-updated'
  | 'settings/document-updated'
  | 'plugin-manager/changed'

export interface BrowserClientContext {
  effect(fn: () => void | (() => void), label?: string): void
  on(event: 'connection/reset', listener: () => void): () => void
  locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    bind(ns: string): (key: string, params?: Record<string, string>) => string
  }
  configForms: {
    get<T>(ns: string): SettingsFormScope<T>
    whileServed(namespaces: readonly string[], mount: () => () => void): () => void
  }
  slots: {
    inject(slot: 'plugins.bundle.config', mount: () => () => void): () => void
    register<Face extends { hooks?: Record<string, unknown> }>(
      options: {
        name: 'plugins.bundle.config'
        key: string
        locale: string
        inject: () => Face
      },
      component: (
        props: PropsRuntime<'plugins.bundle.config'> & PropsLocale<any> & InjectFace<Face>,
      ) => ReactNode,
    ): () => void
  }
  remote: {
    session: {
      modelCatalog(
        signal?: AbortSignal,
      ): Promise<{ ok: true; value: ModelCatalogView } | { ok: false; error: { message: string } }>
    }
    $on(event: RemoteEventName, listener: (...args: unknown[]) => void): () => void
  }
  connection: {
    rpc: {
      call(
        channel: string,
        endpoint: string,
        payload: unknown,
        signal?: AbortSignal,
      ): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>
    }
  }
}
