/**
 * DSH runtime and package-documentation indexing for the `dsh-code-guide` role.
 *
 * Mirrors Claude Code's `claude-code-guide` environment footer while also
 * surfacing locally installed `@deepseek-ai/*` package docs and type
 * declarations so DSH questions are grounded without guessing from memory.
 * @module dsh-roles/guide
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { CONFIGURABLE_MODEL_ROLES } from './config.js'
import type { ResolvedConfig } from './config.js'

/** Read-only tool subset allowed for `dsh-code-guide` children. */
export const GUIDE_TOOL_NAMES = new Set([
  'read',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
  'cordis_inspect_list',
  'cordis_inspect_query',
])

/** Metadata describing one installed `@deepseek-ai/*` package directory. */
export interface DshPackageDocRoot {
  readonly name: string
  readonly dir: string
  readonly readmeZh: boolean
  readonly readmeEn: boolean
  readonly typesDir: boolean
}

/** One external (non-`spawn`, non-`fork`) subagent provider available for role routing. */
export interface ExternalSubagentProviderOption {
  readonly id: string
  readonly label: string
  readonly runtime?: string
  readonly model?: string
  readonly plugin?: string
  readonly isOar: boolean
}

const KNOWN_DSH_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-preset',
  '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-harness-dev-context',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-web-app',
] as const

const KNOWN_SUBAGENT_PROVIDERS = [
  'spawn',
  'fork',
  'acp',
  'oar',
  'oar-antigravity',
  'oar-codex',
  'oar-claude',
  'codex',
  'claude-code',
  'dsh-sdk',
] as const

const MAX_LISTED_PACKAGES = 40

function readPackageName(dir: string, fallback: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { readonly name?: unknown }
    if (typeof raw.name === 'string' && raw.name !== '') return raw.name
  } catch {
    // Fall back to the directory-derived package name when package.json is unreadable.
  }
  return fallback
}

function recordPackageDir(
  found: Map<string, DshPackageDocRoot>,
  candidateDir: string,
  fallbackName: string,
): void {
  try {
    const dir = realpathSync(candidateDir)
    if (!existsSync(join(dir, 'package.json'))) return
    const name = readPackageName(dir, fallbackName)
    if (found.has(name)) return
    found.set(name, Object.freeze({
      name,
      dir,
      readmeZh: existsSync(join(dir, 'README.zh.md')),
      readmeEn: existsSync(join(dir, 'README.md')),
      typesDir: existsSync(join(dir, 'lib/types')),
    }))
  } catch {
    // Ignore unreadable or dangling package symlinks.
  }
}

function scanScopeDir(found: Map<string, DshPackageDocRoot>, scopeDir: string): void {
  try {
    for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      recordPackageDir(found, join(scopeDir, entry.name), `@deepseek-ai/${entry.name}`)
    }
  } catch {
    // Missing or unreadable scope directory.
  }
}

function walkScopeDirs(found: Map<string, DshPackageDocRoot>, startDir: string): void {
  let current = resolve(startDir)
  for (;;) {
    scanScopeDir(found, join(current, 'node_modules', '@deepseek-ai'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

/**
 * Discover locally installed `@deepseek-ai/*` package roots and doc flags.
 * @param cwd - optional workspace directory to include when walking `node_modules`.
 * @returns sorted package doc roots without throwing on missing dependencies.
 */
export function resolveDshPackageRoots(cwd = process.cwd()): readonly DshPackageDocRoot[] {
  const require = createRequire(import.meta.url)
  const found = new Map<string, DshPackageDocRoot>()
  for (const pkg of KNOWN_DSH_PACKAGES) {
    try {
      const pkgDir = dirname(require.resolve(`${pkg}/package.json`))
      recordPackageDir(found, pkgDir, pkg)
      const parentScope = dirname(pkgDir)
      if (parentScope.endsWith('@deepseek-ai')) scanScopeDir(found, parentScope)
    } catch {
      // Optional package not installed in this environment.
    }
  }
  walkScopeDirs(found, dirname(fileURLToPath(import.meta.url)))
  walkScopeDirs(found, cwd)
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function formatPackageFlags(pkg: DshPackageDocRoot): string {
  const docs: string[] = []
  if (pkg.readmeZh) docs.push('README.zh.md')
  if (pkg.readmeEn) docs.push('README.md')
  if (pkg.typesDir) docs.push('lib/types/')
  return docs.length === 0 ? 'package.json' : docs.join(', ')
}

function formatProviderCapabilities(provider: SubagentProvider): string {
  const caps = Object.entries(provider.capabilities)
    .filter(([, supported]) => supported)
    .map(([key]) => key)
  const mode = typeof provider.prepareContinuable === 'function' ? 'local' : 'external'
  return `${provider.name} (${mode}; inheritsContext=${String(provider.inheritsParentContext)}; capabilities=${caps.join(',') || 'none'})`
}

async function listVisiblePresets(ctx: Context): Promise<readonly string[]> {
  try {
    const registry = (ctx as unknown as {
      get?(key: string): { list?(): Promise<Array<{ readonly id: string; readonly name?: string }>> } | undefined
    }).get?.('agentPresets')
    if (registry === undefined || typeof registry.list !== 'function') return []
    const rows = await registry.list()
    return rows.map(row => row.name ? `${row.id} (${row.name})` : row.id)
  } catch {
    return []
  }
}

function titleCase(text: string): string {
  return text === '' ? '' : `${text[0].toUpperCase()}${text.slice(1)}`
}

interface LoaderProviderMeta {
  readonly moduleName?: string
  readonly runtime?: string
  readonly model?: string
}

interface LoaderEntryView {
  readonly disabled?: boolean
  readonly options?: {
    readonly id?: unknown
    readonly name?: unknown
    readonly config?: unknown
  }
}

function unwrapCell(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { readonly get: () => unknown }).get()
  }
  return value
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = unwrapCell(record[key])
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function collectLoaderProviderMeta(ctx: Context): ReadonlyMap<string, LoaderProviderMeta> {
  const result = new Map<string, LoaderProviderMeta>()
  try {
    const root = (ctx as unknown as { root?: Context }).root ?? ctx
    const getter = root as unknown as { get?(key: string): unknown; loader?: unknown }
    const loader = (typeof getter.get === 'function' ? getter.get('loader') : undefined) ?? getter.loader
    if (loader === null || typeof loader !== 'object' || typeof (loader as { entries?: unknown }).entries !== 'function') {
      return result
    }
    const entries = (loader as { entries(): Iterable<LoaderEntryView> }).entries()
    for (const entry of entries) {
      if (entry.disabled === true) continue
      const moduleName = typeof entry.options?.name === 'string' ? entry.options.name : undefined
      const cfg = entry.options?.config !== null && typeof entry.options?.config === 'object'
        ? entry.options.config as Record<string, unknown>
        : undefined
      let providerName = cfg ? readStringField(cfg, 'providerName') : undefined
      if (providerName === undefined) {
        if (moduleName === '@deepseek-ai/dsh-experimental-subagent-oar') providerName = 'oar'
        else if (moduleName === '@deepseek-ai/dsh-subagent-codex') providerName = 'codex'
        else if (moduleName === '@deepseek-ai/dsh-subagent-claude-code') providerName = 'claude-code'
      }
      if (providerName === undefined) continue
      const runtime = cfg ? readStringField(cfg, 'runtime') : undefined
      const model = cfg ? readStringField(cfg, 'model') : undefined
      result.set(providerName, { moduleName, runtime, model })
    }
  } catch {
    // Ignore loader introspection errors; known/configured candidates remain discoverable.
  }
  return result
}

/**
 * Discover live external subagent providers (`oar-*`, `codex`, etc.) registered on `ctx.subagents`.
 * @param ctx - host plugin context.
 * @param config - resolved orchestration settings (supplies configured `subagentProvider` names).
 * @param extraNames - additional tracked provider names from `subagent/provider-added` events.
 * @returns external provider options sorted with OAR runtimes first.
 */
export function listExternalSubagentProviders(
  ctx: Context,
  config: ResolvedConfig,
  extraNames?: ReadonlySet<string>,
): readonly ExternalSubagentProviderOption[] {
  try {
    const subagents = (ctx as unknown as {
      subagents?: { getProvider?(name: string): SubagentProvider | undefined }
    }).subagents
    if (subagents === undefined || typeof subagents.getProvider !== 'function') return []
    const loaderMetaMap = collectLoaderProviderMeta(ctx)
    const names = new Set<string>(KNOWN_SUBAGENT_PROVIDERS)
    if (extraNames !== undefined) {
      for (const name of extraNames) names.add(name)
    }
    for (const name of loaderMetaMap.keys()) names.add(name)
    for (const role of CONFIGURABLE_MODEL_ROLES) {
      const configured = config.models[role]?.subagentProvider
      if (configured !== undefined) names.add(configured)
    }

    const options: ExternalSubagentProviderOption[] = []
    for (const name of names) {
      if (name === 'spawn' || name === 'fork') continue
      const provider = subagents.getProvider(name)
      if (provider === undefined || typeof provider.prepareContinuable === 'function' || provider.inheritsParentContext) {
        continue
      }
      const meta = loaderMetaMap.get(name)
      const isOar = meta?.moduleName === '@deepseek-ai/dsh-experimental-subagent-oar'
        || name === 'oar'
        || name.startsWith('oar-')
      const runtime = meta?.runtime ?? (
        name.startsWith('oar-')
          ? name.slice(4)
          : name === 'codex'
            ? 'codex'
            : name === 'claude-code'
              ? 'claude'
              : undefined
      )
      const model = meta?.model
      const plugin = meta?.moduleName
      const baseLabel = isOar
        ? (runtime !== undefined ? `OAR · ${titleCase(runtime)}` : 'OAR')
        : (name === 'codex' ? 'Codex' : name === 'claude-code' ? 'Claude Code' : name)
      const label = model !== undefined ? `${baseLabel} · ${model}` : baseLabel
      options.push(Object.freeze({
        id: name,
        label,
        ...(runtime === undefined ? {} : { runtime }),
        ...(model === undefined ? {} : { model }),
        ...(plugin === undefined ? {} : { plugin }),
        isOar,
      }))
    }
    return options.sort((left, right) => {
      if (left.isOar !== right.isOar) return left.isOar ? -1 : 1
      return left.id.localeCompare(right.id)
    })
  } catch {
    return []
  }
}

function listSubagentProviders(ctx: Context, config: ResolvedConfig): readonly string[] {
  try {
    const subagents = (ctx as unknown as {
      subagents?: { getProvider?(name: string): SubagentProvider | undefined }
    }).subagents
    if (subagents === undefined || typeof subagents.getProvider !== 'function') return []
    const names = new Set<string>(KNOWN_SUBAGENT_PROVIDERS)
    for (const role of CONFIGURABLE_MODEL_ROLES) {
      const configured = config.models[role]?.subagentProvider
      if (configured !== undefined) names.add(configured)
    }
    const entries: string[] = []
    for (const name of [...names].sort()) {
      const provider = subagents.getProvider(name)
      if (provider !== undefined) entries.push(formatProviderCapabilities(provider))
    }
    return entries
  } catch {
    return []
  }
}

function listInspectProviders(ctx: Context): readonly string[] {
  try {
    const inspect = (ctx as unknown as {
      get?(key: string): { list?(): Array<{ readonly id?: unknown; readonly platform?: unknown }> } | undefined
    }).get?.('cordisInspect')
    if (inspect === undefined || typeof inspect.list !== 'function') return []
    return inspect.list()
      .map((item) => {
        const id = typeof item.id === 'string' ? item.id : 'unknown'
        const platform = typeof item.platform === 'string' ? item.platform : 'host'
        return `${platform}:${id}`
      })
      .sort()
  } catch {
    return []
  }
}

function listParentToolsAndMcp(parent: Agent): { readonly tools: readonly string[]; readonly mcpServers: readonly string[] } {
  try {
    const defs = parent.ctx?.tools?.definitions?.(parent) ?? []
    const tools: string[] = []
    const mcpServers = new Set<string>()
    for (const def of defs) {
      if (def.name.startsWith('mcp__')) {
        const rest = def.name.slice('mcp__'.length)
        const sep = rest.indexOf('__')
        mcpServers.add(sep > 0 ? rest.slice(0, sep) : rest)
      } else {
        tools.push(def.name)
      }
    }
    return { tools: tools.sort(), mcpServers: [...mcpServers].sort() }
  } catch {
    return { tools: [], mcpServers: [] }
  }
}

function prioritizePackages(packages: readonly DshPackageDocRoot[]): readonly DshPackageDocRoot[] {
  if (packages.length <= MAX_LISTED_PACKAGES) return packages
  const core = new Set<string>(KNOWN_DSH_PACKAGES)
  const prioritized = packages.filter(pkg => core.has(pkg.name))
  for (const pkg of packages) {
    if (prioritized.length >= MAX_LISTED_PACKAGES) break
    if (!core.has(pkg.name)) prioritized.push(pkg)
  }
  return prioritized
}

/**
 * Build a sanitized runtime and local-documentation snapshot appended to
 * `dsh-code-guide` task prompts.
 * @param ctx - host plugin context.
 * @param parent - calling root agent.
 * @param config - resolved orchestration settings.
 * @returns markdown section summarizing local package docs and host state.
 */
export async function buildDshGuideContext(
  ctx: Context,
  parent: Agent,
  config: ResolvedConfig,
): Promise<string> {
  const cwd = parent.session?.header?.cwd ?? process.cwd()
  const packages = resolveDshPackageRoots(cwd)
  const listedPackages = prioritizePackages(packages)
  const presets = await listVisiblePresets(ctx)
  const providers = listSubagentProviders(ctx, config)
  const inspectProviders = listInspectProviders(ctx)
  const { tools, mcpServers } = listParentToolsAndMcp(parent)
  const lines: string[] = ['# Current DSH Environment', '']

  if (process.env.DSH_HOME) {
    lines.push(`- **DSH_HOME**: \`${process.env.DSH_HOME}\` (profiles and \`cordis.yml\`/\`cordis.patch.yml\` live here; never read credentials files).`)
  }
  if (presets.length > 0) {
    lines.push(`- **Visible agent presets**: ${presets.join(', ')}`)
  }
  if (providers.length > 0) {
    lines.push(`- **Registered subagent providers**: ${providers.join('; ')}`)
  }
  if (inspectProviders.length > 0) {
    lines.push(`- **Cordis inspect providers**: ${inspectProviders.join(', ')}`)
  }
  if (tools.length > 0) {
    lines.push(`- **Parent tools**: ${tools.join(', ')}`)
  }
  if (mcpServers.length > 0) {
    lines.push(`- **Configured MCP servers**: ${mcpServers.join(', ')}`)
  }
  lines.push(`- **dsh-roles settings**: models=${JSON.stringify(config.models)}; budgets=${JSON.stringify(config.budgets)}`)
  lines.push('')
  lines.push(`## Installed \`@deepseek-ai/*\` Packages (${listedPackages.length} of ${packages.length} shown)`)
  if (listedPackages.length === 0) {
    lines.push('- (no local `@deepseek-ai/*` package directories discovered)')
  } else {
    for (const pkg of listedPackages) {
      lines.push(`- \`${pkg.name}\`: \`${pkg.dir}\` (${formatPackageFlags(pkg)})`)
    }
  }
  return lines.join('\n')
}
