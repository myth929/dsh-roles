/**
 * Model-facing role contracts, convergence notice, and root scheduling policy.
 *
 * These strings are intentionally short: they are prepended once per
 * delegation, not repeated in every tool result.
 * @module dsh-roles/roles
 */

import type { OrchestrationRole, ResolvedModels, RoleModelRoute, Thoroughness } from './config.js'

/** Summarize one explicitly configured non-default model or external subagent route. */
export function describeConfiguredRoute(route: RoleModelRoute | undefined): string | undefined {
  if (route === undefined) return undefined
  const parts: string[] = []
  if (route.subagentProvider !== undefined && route.subagentProvider !== 'spawn') {
    parts.push(route.subagentProvider)
  }
  if (route.provider !== undefined && route.model !== undefined) {
    parts.push(`${route.provider}/${route.model}`)
  }
  return parts.length > 0 ? parts.join(', ') : undefined
}

/** Optional modifiers appended to a child role preamble. */
export interface RolePreambleOptions {
  /** Advisory step budget for external subagents that do not run DSH's local step guard. */
  readonly externalStepBudget?: number
  /** Whether a `general-purpose` child is running in read-only mode. */
  readonly readOnly?: boolean
  /** Whether a `general-purpose` child is isolated in its own Git worktree and branch. */
  readonly worktree?: boolean
}

/** Instruction prepended to a child's self-contained prompt. */
export function rolePreamble(
  role: OrchestrationRole,
  thoroughness: Thoroughness,
  options?: RolePreambleOptions,
): string {
  const size = thoroughness === 'quick'
    ? 'Keep the pass narrow and stop as soon as the question is answered.'
    : thoroughness === 'thorough'
      ? 'Be exhaustive: cover every plausible module and cross-check call sites.'
      : 'Balance coverage and speed; follow the most relevant references.'
  const externalBudgetLine = options?.externalStepBudget !== undefined
    ? `Step budget guidance: stay within roughly ${options.externalStepBudget} tool steps; avoid exhaustive repo-wide scans or long builds — converge and return your final report as soon as the core findings or changes are verified.`
    : undefined
  const finalize = (lines: readonly string[]): string => (
    externalBudgetLine === undefined ? lines.join('\n') : [...lines, externalBudgetLine].join('\n')
  )
  switch (role) {
    case 'explore':
      return finalize([
        'You are a read-only exploration subagent. Use only `read`, `glob`, and `grep`.',
        'Do not use this role for code review, design auditing, or architecture planning — locate code and report coordinates only.',
        size,
        'Return a compact report with these sections:',
        '1. `Summary` — the answer to the question in at most 10 lines.',
        '2. `Key Files` — every load-bearing path with the exact line range (for example `src/a.ts:12-48`) and one clause on why it matters. The delegating agent will read these ranges before editing.',
        '3. `Coverage` — what you searched and any relevant path or question you did not cover.',
        'Do not speculate about code you did not read; say what remains unknown.',
      ])
    case 'plan':
      return finalize([
        'You are a read-only software architect subagent. Use only `read`, `glob`, and `grep`.',
        'Strictly prohibited from creating, editing, deleting, or modifying any files (including temporary files).',
        size,
        'Read relevant files thoroughly, trace call paths, weigh architectural trade-offs, and produce a step-by-step implementation strategy.',
        'End your response with:',
        '### Critical Files for Implementation',
        'List 3-5 critical files with line ranges (`path:line-range`) and one clause on each file\'s role.',
        'Do not speculate about code you did not read; state any open ambiguity explicitly.',
      ])
    case 'general-purpose': {
      const lines = [
        'You are a general-purpose execution subagent starting with zero prior conversation history. Use your available tools to complete the task in your working directory.',
        size,
        'Follow repository instructions. Stay inside the allowed write scope when one was supplied. Do not re-delegate the whole assignment to another subagent.',
      ]
      if (options?.readOnly === true) {
        lines.push('Read-only mode is active: file-editing tools (`write`, `edit`, `apply_patch`) are disabled. Do not modify repository files via shell commands either; inspect, analyze, and report findings only.')
      } else if (options?.worktree === true) {
        lines.push('Worktree isolation is active: you are working in a dedicated Git worktree and branch starting from HEAD (uncommitted edits from the main checkout are excluded, and gitignored dependencies such as node_modules may not be pre-installed). Make and verify your changes inside this worktree; remaining uncommitted edits will be auto-committed onto your branch when you finish so the parent can review and merge them.')
        lines.push('Run the narrowest relevant checks (tests, typecheck, lint, or a direct reproduction) before finishing when making code changes.')
      } else {
        lines.push('Run the narrowest relevant checks (tests, typecheck, lint, or a direct reproduction) before finishing when making code changes.')
      }
      lines.push('Return: `Summary` (what changed or was found and why), `Files` (relevant or changed paths with line ranges), `Verification` (exact commands and results, if applicable), and `Risks` (anything unverified). If the task cannot be completed, state the concrete blocker instead of claiming success.')
      return finalize(lines)
    }
    case 'fork':
      return finalize([
        'You are a forked subagent inheriting the parent session\'s completed prior turns up to the last completed turn; edits and tool outputs from the caller\'s current in-flight turn are described in your task directive.',
        size,
        'Do not re-derive context already established in the inherited history, and do not spawn nested forks.',
        'Use your available tools directly (including shell commands, `git diff`, and tests when needed) so raw intermediate noise stays out of the parent context.',
        'Return a concise, self-standing report covering `Summary`, concrete findings with `path:line-range` where applicable, and exact `Verification` results.',
      ])
    case 'dsh-code-guide':
      return finalize([
        'You are the DeepSeek Harness (DSH) and Cordis documentation and configuration specialist (`dsh-code-guide`).',
        'This is a read-only guidance role: never modify files or run shell commands.',
        size,
        'Authoritative source priority:',
        '1. Read installed `@deepseek-ai/*` package `README.zh.md` / `README.md`, `package.json`, and `lib/types/*.d.ts` listed under `# Current DSH Environment` using `read`, `glob`, and `grep`.',
        '2. Use `cordis_inspect_list` and `cordis_inspect_query` when available to inspect live Cordis services, events, and Loader Config schemas.',
        '3. Use `web_fetch` / `web_search` (for `https://github.com/deepseek-ai/deepseek-harness`) only when local package docs do not cover the question.',
        'Never fabricate CLI flags, Cordis service names, plugin config keys, or event signatures from memory — if a detail cannot be verified in local packages or docs, state that gap explicitly.',
        'Return concise, actionable guidance citing exact package names/file paths and concrete `cordis.patch.yml` or TypeScript examples where relevant.',
      ])
  }
}

/** One-time notice injected on the final admitted step. */
export function convergenceNotice(role: OrchestrationRole, budget: number): string {
  const closing = (() => {
    switch (role) {
      case 'explore':
        return 'Include the `Key Files` coordinates you have already verified and mark anything unverified.'
      case 'plan':
        return 'Provide the implementation plan and `### Critical Files for Implementation` using only code you already read.'
      case 'dsh-code-guide':
        return 'Return only verified DSH guidance and exact package/file citations, noting anything you could not verify.'
      case 'fork':
        return 'Report only findings and verification outputs you have already observed.'
      case 'general-purpose':
        return 'Report what changed or was found, what passed, and any remaining blocker.'
    }
  })()
  return [
    `<orchestration-budget step="${budget}">`,
    `This is the final step for this ${role} subagent; its tool calls are now disabled.`,
    'Do not request another tool. Using only facts already gathered, return the final report in the required sections.',
    closing,
    '</orchestration-budget>',
  ].join('\n')
}

/** Model-facing reason returned when the convergence guard denies a tool call. */
export const CONVERGENCE_DENIAL = 'The orchestration step budget is exhausted; tools are disabled for this step. Return the final report now without calling tools.'

function formatRoleTag(role: string, route: string | undefined): string {
  return route === undefined ? `\`${role}\`` : `\`${role}\` (${route})`
}

/**
 * Render the root-only scheduling policy, adapting delegation priority when
 * roles are explicitly routed to dedicated models or external OAR backends
 * while preserving a strict direct-execution whitelist for trivial tasks.
 */
export function formatRootSchedulingGuidance(models?: ResolvedModels): string {
  const gpRoute = describeConfiguredRoute(models?.['general-purpose'])
  const exploreRoute = describeConfiguredRoute(models?.explore)
  const planRoute = describeConfiguredRoute(models?.plan)
  const guideRoute = describeConfiguredRoute(models?.['dsh-code-guide'])

  const generalPurposeLine = gpRoute !== undefined
    ? `- ${formatRoleTag('general-purpose', gpRoute)} is configured as a dedicated execution backend: use it as the default worker for substantive coding or investigation — including feature implementation, bug fixes, refactors, changes requiring test/typecheck verification, >1-file code review/diff analysis, log/monitoring troubleshooting, and CLI/environment debugging.`
    : '- Prefer `general-purpose` for multi-file or multi-step code implementation, bug fixes requiring reproduction/tests, code review / diff analysis touching more than 1 file (or a large cross-module change), bug/log/monitoring troubleshooting, and unfamiliar CLI/environment/config debugging.'

  const followUpLine = gpRoute !== undefined
    ? '- After an `explore` or `plan` report, hand non-trivial implementation directly to `general-purpose` (passing the cited file coordinates and constraints) rather than editing inline. After `general-purpose` finishes: for code edits, review the diff and verify tests; for read-only reviews or investigations, synthesize the subagent report directly (spot-checking only uncertain claims instead of re-reading every file or diff from scratch).'
    : '- After an `explore` or `plan` report, delegate multi-step implementation to `general-purpose` (passing the cited coordinates) or read the cited files yourself before making a small direct edit. After `general-purpose` finishes: review the combined diff and tests for code edits, or synthesize the report directly for read-only reviews and investigations without re-reading every file from scratch.'

  return [
    '## Delegation policy',
    '',
    'Proactively use `orchestrate_subagent` when a task benefits from isolated context or a specialized role — do not grind through multi-step inspection or coding loops inline when a subagent can execute and return a distilled report.',
    'Available roles and their tools are listed in `<system-reminder>` messages in the conversation.',
    '',
    generalPurposeLine,
    `- Prefer ${formatRoleTag('explore', exploreRoute)} for open-ended or cross-file codebase search (>2 queries or unfamiliar directories); prefer ${formatRoleTag('plan', planRoute)} for multi-file architecture design; prefer \`fork\` when prior conversation context matters and raw tool output should stay out of this context; prefer ${formatRoleTag('dsh-code-guide', guideRoute)} for DSH/Cordis questions.`,
    '- Keep trivial, self-contained tasks direct even when dedicated backends are configured: plain Q&A, reading 1–2 known files, an obvious localized edit (for example fixing a typo, constant, copy, or 1–2 known lines with no debugging/test loop), or a single deterministic command (for example `git status` or `git commit`).',
    '- For parallel `general-purpose` calls in one step: pass `readOnly: true` for read-only reviews/investigations, disjoint `writeScope` prefixes for non-overlapping edits in the main checkout, or `isolation: "worktree"` for isolated Git branch edits that may touch shared files (then review with `git diff`, merge sequentially with `git merge --squash` or `git cherry-pick`, and remove the worktree + branch).',
    '- Never duplicate work a subagent is already doing, and never delegate understanding ("based on your findings...").',
    followUpLine,
  ].join('\n')
}

/** Default root-only scheduling policy when no custom role routes are configured. */
export const ROOT_SCHEDULING_GUIDANCE = formatRootSchedulingGuidance()
