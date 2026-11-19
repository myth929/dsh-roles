# dsh-orchestration

[English](https://github.com/myth929/dsh-orchestration/blob/main/README.md) · [简体中文](https://github.com/myth929/dsh-orchestration/blob/main/README_zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-orchestration)](https://www.npmjs.com/package/dsh-orchestration)
[![GitHub stars](https://img.shields.io/github/stars/myth929/dsh-orchestration?style=social)](https://github.com/myth929/dsh-orchestration)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/myth929/dsh-orchestration/blob/main/LICENSE)

**A lightweight [DeepSeek Harness](https://www.deepseek.com/harness/) (`DSH >=0.2.2-rc.1`) plugin bundle for role-layered subagent orchestration.**

[`dsh-orchestration`](https://www.npmjs.com/package/dsh-orchestration) converges subagent delegation into a single model-facing `orchestrate_subagent` tool aligned with Claude Code's built-in role lineup:

- **Five layered roles** — `general-purpose`, `explore`, `plan`, `fork`, and `dsh-code-guide`, each with tailored prompt isolation, tool permissions, and tool-result pruning.
- **Per-role model & OAR routing** — works out of the box following the parent model, or overrides any configurable role with a specific LLM (`provider/model` + `reasoningEffort`) or OAR external runtime (`oar-antigravity`, `oar-codex`, `oar-claude`, etc.) via Web UI or environment variables.
- **Built-in guardrails** — two-stage step budgets with clean tool-free convergence, non-overlapping `writeScope` enforcement for parallel edits, and single-level (`root → child`) fork delegation guards.
- **Real delegation telemetry & benchmarks** — structured `[dsh-orchestration] telemetry` logs plus offline report and live benchmark scripts.

## Install / Update

### Install in DeepSeek Harness Web or Desktop

Open **Plugins → Add plugin**, search for `dsh-orchestration`, and click **Install**. Enable or disable the plugin directly from DSH's Plugin Manager.

### Install with `dsh` CLI

Install [`dsh-orchestration`](https://www.npmjs.com/package/dsh-orchestration) from npm or directly from GitHub:

```sh
dsh plugin add dsh-orchestration
# or directly from GitHub:
dsh plugin add myth929/dsh-orchestration
```

Update to the latest release:

```sh
dsh plugin update dsh-orchestration@latest
```

## Roles

| Role | Backing / Preset | Capabilities | Delivery |
| --- | --- | --- | --- |
| `general-purpose` *(default)* | Internal preset `dsh-orchestration-general-purpose` (`spawn` or configured `subagentProvider`) | `read`, `write`, `edit`, `glob`, `grep`, `bash`/`pwsh`, `jobs`, `todo`; keeps workspace instructions (`AGENTS.md`), strips `mcp__*` unless `includeMcp: true`, supports `writeScope` | Synchronous by default (`background: true` for async) |
| `explore` | Internal preset `dsh-orchestration-explore` (`spawn`) | Fast read-only search (`read`, `glob`, `grep`); strips workspace instructions and skill catalogs, uses tight tool-result pruning, returns `Key Files` line ranges | Synchronous by default |
| `plan` | Internal preset `dsh-orchestration-plan` (`spawn` or configured `subagentProvider`) | Read-only architect (`read`, `glob`, `grep`); strips workspace instructions and skill catalogs, uses wider tool-result pruning, returns `Critical Files for Implementation` | Synchronous by default |
| `fork` | Official `fork` | Inherits completed parent turns and parent model/reasoning effort; keeps `messages[0]` and tool declarations identical to the parent for KV-cache reuse and full parent tool permissions while blocking nested forks and over-depth delegations via guard | Synchronous by default |
| `dsh-code-guide` | Internal preset `dsh-orchestration-guide` (`spawn`) | Read-only DSH/Cordis specialist (`read`, `glob`, `grep`, `web_fetch`, `web_search`, `cordis_inspect_list`, `cordis_inspect_query`); strips workspace instructions and receives `# Current DSH Environment` with installed `@deepseek-ai/*` doc roots and live host summary | Synchronous by default |

Internal presets (`dsh-orchestration-general-purpose`, `dsh-orchestration-explore`, `dsh-orchestration-plan`, `dsh-orchestration-guide`) are automatically hidden from user-facing preset selectors (`agentPresets.list()`), and bare `subagent` / `subagent_fork` / `subagent_oar` tools are automatically converged into `orchestrate_subagent` whenever it is visible.

## Configuration

Works out of the box with zero configuration (`Loader` row `config` overrides process environment overrides defaults):

| Option / Env | Default | Description |
| --- | --- | --- |
| `models` / `DSH_ORCHESTRATION_MODELS` | All roles follow the parent session model | Per-role routes for `general-purpose`, `explore`, `plan`, and `dsh-code-guide` (`"provider/model"` string or `{ provider, model, reasoningEffort, subagentProvider }`). Configuring `fork` is rejected because forks always inherit the parent model |
| `exploreProvider` / `exploreModel` (`DSH_ORCHESTRATION_EXPLORE_PROVIDER` / `DSH_ORCHESTRATION_EXPLORE_MODEL`) | *(unset — follows parent model)* | Legacy `explore` route fields kept for backward compatibility (`models.explore` takes precedence) |
| `budgets` / `DSH_ORCHESTRATION_BUDGETS` | `general-purpose: 8/16/28`, `explore: 4/8/14`, `plan: 5/10/18`, `fork: 5/10/18`, `dsh-code-guide: 4/8/14` | Per-role `quick` / `standard` / `thorough` step budgets (JSON object or string, integer `2..200`) |

Example per-role model and optional OAR provider override:

```sh
DSH_ORCHESTRATION_MODELS='{"explore":"deepseek/deepseek-chat","dsh-code-guide":"deepseek/deepseek-chat","plan":{"provider":"openai","model":"gpt-5.4","reasoningEffort":"high"},"general-purpose":{"subagentProvider":"oar-codex"}}'
DSH_ORCHESTRATION_BUDGETS='{"explore":{"quick":3},"general-purpose":{"standard":20}}'
```

### Web UI Settings

You can also configure per-role routes interactively in the DSH Web UI under **Plugins → dsh-orchestration**:

- Every configurable role (`general-purpose`, `explore`, `plan`, `dsh-code-guide`) defaults to following the parent session model and displays a recommended model capability tier.
- Each role shares a unified selector of OAR/external subagent runtimes (`oar-antigravity`, `oar-codex`, `oar-claude`, `codex`, etc.) and authorized LLM models with optional `reasoningEffort`.
- Changes persist immediately without restarting the host once the client bundle is loaded. Delegation depth is fixed to single-level (`root → child`), aligned with Claude Code.

### OAR External Subagent Runtimes

- **Codex / Claude Code (`oar-codex`, `oar-claude`)**: `dsh-orchestration` discovers registered OAR providers on demand without bundling `@botiverse/oar`. Install and configure the official `@deepseek-ai/dsh-experimental-subagent-oar` plugin (plus native CLI authentication) in your DSH profile to enable them; when absent, the settings page displays an installation hint.
- **Antigravity (`oar-antigravity`)**: Until the official `@deepseek-ai/dsh-experimental-subagent-oar` plugin upgrades its embedded OAR runtime to support standalone `agy >= 1.5.0`, `dsh-orchestration` automatically registers a temporary built-in `oar-antigravity` provider mirroring the official OAR contract whenever `agy` is detected on the host. Once you configure an official `oar-antigravity` row via `@deepseek-ai/dsh-experimental-subagent-oar`, the built-in fallback yields automatically.

## Guardrails

- **Two-stage step budget**: Arms tool suppression (`allow: []`) and a fallback denial guard after `step >= budget - 1` so the final admitted step renders zero tools cleanly, injects a one-time convergence notice, and resets on `turn/end` for clean follow-up resumes. Partial non-empty output on overrun is preserved as `budget-exhausted`.
- **Write scope & overlap check**: Parallel `general-purpose` calls in the same parent step must declare non-overlapping `writeScope` prefixes normalized against the active session working directory and real symlink targets. `write`, `edit`, and `apply_patch` paths are verified before execution for local runs. (Note: `bash`/`pwsh` shell commands and external `subagentProvider` runs are not path-filtered inside the child.)
- **Fork delegation guard**: `fork` children preserve the exact parent tool list and permissions for KV-cache fidelity while rejecting nested `orchestrate_subagent` calls (persisted across cold resume).

## Local Development & Benchmarking

### Link Without Publishing

Link your local checkout into your DSH profile once:

```sh
dsh plugin add /path/to/dsh-orchestration
# or inside your profile directory:
# pnpm add link:/path/to/dsh-orchestration --config.auto-install-peers=false
```

Build changes into `lib/`:

```sh
pnpm run build
# or keep watch compilation running while editing:
pnpm run dev
```

Restart your DSH host to pick up the updated `lib/` immediately without publishing or reinstalling.

### Build, Typecheck & Test

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
```

### Benchmarking

Compare baseline vs orchestration session logs and `[dsh-orchestration] telemetry` lines:

```sh
pnpm run build
node scripts/benchmark-report.mjs \
  --baseline /path/to/baseline/sessions \
  --enabled /path/to/enabled/sessions \
  --telemetry /path/to/agent.log
```

Run live benchmarks against an OpenAI-compatible endpoint (`DSH_BENCHMARK_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`, optional `DSH_BENCHMARK_BASE_URL` and `DSH_BENCHMARK_MODEL`):

```sh
pnpm run build
node scripts/live-benchmark.mjs --tasks simple,explore,parallel --modes baseline,enabled
```

## License

[MIT](https://github.com/myth929/dsh-orchestration/blob/main/LICENSE)
