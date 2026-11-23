# dsh-roles

[English](https://github.com/myth929/dsh-roles/blob/main/README.md) · [简体中文](https://github.com/myth929/dsh-roles/blob/main/README_zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-roles)](https://www.npmjs.com/package/dsh-roles)
[![GitHub stars](https://img.shields.io/github/stars/myth929/dsh-roles?style=social)](https://github.com/myth929/dsh-roles)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/myth929/dsh-roles/blob/main/LICENSE)

**A lightweight [DeepSeek Harness](https://www.deepseek.com/harness/) (`DSH >=0.2.2-rc.1`) plugin bundle for role-layered subagent orchestration.**

[`dsh-roles`](https://www.npmjs.com/package/dsh-roles) converges subagent delegation into a single model-facing `orchestrate_subagent` tool aligned with Claude Code's built-in role lineup:

- **Five layered roles** — `general-purpose`, `explore`, `plan`, `fork`, and `dsh-code-guide`, each with tailored prompt isolation, tool permissions, and tool-result pruning.
- **Per-role model & OAR routing** — works out of the box following the parent model, or overrides any configurable role with a specific LLM (`provider/model` + `reasoningEffort`) or OAR external runtime (`oar-antigravity`, `oar-codex`, `oar-claude`, etc.) via Web UI or environment variables.
- **Built-in guardrails** — two-stage step budgets with clean tool-free convergence, non-overlapping `writeScope` enforcement for parallel edits, and single-level (`root → child`) fork delegation guards.
- **Real delegation telemetry & benchmarks** — structured `[dsh-roles] telemetry` logs plus offline report and live benchmark scripts.

## Install / Update

### Install in DeepSeek Harness Web or Desktop

Open **Plugins → Add plugin**, search for `dsh-roles`, and click **Install**. Enable or disable the plugin directly from DSH's Plugin Manager.

### Install with `dsh` CLI

Install [`dsh-roles`](https://www.npmjs.com/package/dsh-roles) from npm or directly from GitHub:

```sh
dsh plugin add dsh-roles
# or directly from GitHub:
dsh plugin add myth929/dsh-roles
```

Update to the latest release:

```sh
dsh plugin update dsh-roles@latest
```

### Dependency contract

The bundle installs nothing at runtime: the host plugin, the four internal presets, and the tool plugins those presets mount are all provided by the host profile. Every package named in `cordis.patch.yml` is therefore declared in `peerDependencies`, and `tests/patch-dependencies.test.ts` fails when the two drift apart — adding a row without declaring its module is caught by the suite.

DSH profiles set `autoInstallPeers: false` in `pnpm-workspace.yaml`, so these peers are never installed a second time; pnpm may still report them as unmet during installation, which is expected — the host provides them and this bundle installs none. If you link the bundle into a plain pnpm project yourself, keep that setting: a duplicate copy of a host package registers the same service twice.

## Roles

| Role | Backing / Preset | Capabilities | Delivery |
| --- | --- | --- | --- |
| `general-purpose` *(default)* | Internal preset `dsh-roles-general-purpose` (`spawn` or configured `subagentProvider`) | `read`, `write`, `edit`, `glob`, `grep`, `bash`/`pwsh`, `jobs`, `todo`; keeps workspace instructions (`AGENTS.md`), strips `mcp__*` unless `includeMcp: true`; supports `readOnly: true`, `writeScope`, and `isolation: "worktree"` | Synchronous by default (`background: true` for async) |
| `explore` | Internal preset `dsh-roles-explore` (`spawn`) | Fast read-only search (`read`, `glob`, `grep`); strips workspace instructions and skill catalogs, uses tight tool-result pruning, returns `Key Files` line ranges | Synchronous by default |
| `plan` | Internal preset `dsh-roles-plan` (`spawn` or configured `subagentProvider`) | Read-only architect (`read`, `glob`, `grep`); strips workspace instructions and skill catalogs, uses wider tool-result pruning, returns `Critical Files for Implementation` | Synchronous by default |
| `fork` | Official `fork` | Inherits completed parent turns and parent model/reasoning effort; keeps `messages[0]` and tool declarations identical to the parent for KV-cache reuse and full parent tool permissions while blocking nested forks and over-depth delegations via guard | Synchronous by default |
| `dsh-code-guide` | Internal preset `dsh-roles-guide` (`spawn`) | Read-only DSH/Cordis specialist (`read`, `glob`, `grep`, `web_fetch`, `web_search`, `cordis_inspect_list`, `cordis_inspect_query`); strips workspace instructions and receives `# Current DSH Environment` with installed `@deepseek-ai/*` doc roots and live host summary | Synchronous by default |

Internal presets (`dsh-roles-general-purpose`, `dsh-roles-explore`, `dsh-roles-plan`, `dsh-roles-guide`) are automatically hidden from user-facing preset selectors (`agentPresets.list()`), and bare `subagent` / `subagent_fork` / `subagent_oar` tools are automatically converged into `orchestrate_subagent` whenever it is visible.

## Configuration

Works out of the box with zero configuration (`Loader` row `config` overrides process environment overrides defaults):

| Option / Env | Default | Description |
| --- | --- | --- |
| `models` / `DSH_ROLES_MODELS` | All roles follow the parent session model | Per-role routes for `general-purpose`, `explore`, `plan`, and `dsh-code-guide` (`"provider/model"` string or `{ provider, model, reasoningEffort, subagentProvider }`). Configuring `fork` is rejected because forks always inherit the parent model |
| `exploreProvider` / `exploreModel` (`DSH_ROLES_EXPLORE_PROVIDER` / `DSH_ROLES_EXPLORE_MODEL`) | *(unset — follows parent model)* | Legacy `explore` route fields kept for backward compatibility (`models.explore` takes precedence) |
| `budgets` / `DSH_ROLES_BUDGETS` | `general-purpose: 8/16/28`, `explore: 4/8/14`, `plan: 5/10/18`, `fork: 5/10/18`, `dsh-code-guide: 4/8/14` | Per-role `quick` / `standard` / `thorough` step budgets (JSON object or string, integer `2..200`) |

Example per-role model and optional OAR provider override:

```sh
DSH_ROLES_MODELS='{"explore":"deepseek/deepseek-chat","dsh-code-guide":"deepseek/deepseek-chat","plan":{"provider":"openai","model":"gpt-5.4","reasoningEffort":"high"},"general-purpose":{"subagentProvider":"oar-codex"}}'
DSH_ROLES_BUDGETS='{"explore":{"quick":3},"general-purpose":{"standard":20}}'
```

### Web UI Settings

You can also configure per-role routes interactively in the DSH Web UI under **Plugins → dsh-roles**:

- Every configurable role (`general-purpose`, `explore`, `plan`, `dsh-code-guide`) defaults to following the parent session model and displays a recommended model capability tier.
- Each role shares a unified selector of OAR/external subagent runtimes (`oar-antigravity`, `oar-codex`, `oar-claude`, `codex`, etc.) and authorized LLM models with optional `reasoningEffort`.
- Changes persist immediately without restarting the host once the client bundle is loaded. Delegation depth is fixed to single-level (`root → child`), aligned with Claude Code.

### OAR External Subagent Runtimes

- **Codex / Claude Code (`oar-codex`, `oar-claude`)**: `dsh-roles` discovers registered OAR providers on demand without bundling `@botiverse/oar`. Install and configure the official `@deepseek-ai/dsh-experimental-subagent-oar` plugin (plus native CLI authentication) in your DSH profile to enable them; when absent, the settings page displays an installation hint.
- **Antigravity (`oar-antigravity`)**: Until the official `@deepseek-ai/dsh-experimental-subagent-oar` plugin upgrades its embedded OAR runtime to support standalone `agy >= 1.5.0`, `dsh-roles` automatically registers a temporary built-in `oar-antigravity` provider mirroring the official OAR contract whenever `agy` is detected on the host. Once you configure an official `oar-antigravity` row via `@deepseek-ai/dsh-experimental-subagent-oar`, the built-in fallback yields automatically.

## Guardrails

- **Two-stage step budget**: Arms tool suppression (`allow: []`) and a fallback denial guard after `step >= budget - 1` so the final admitted step renders zero tools cleanly, injects a one-time convergence notice, and resets on `turn/end` for clean follow-up resumes. Partial non-empty output on overrun is preserved as `budget-exhausted`.
- **Three-tier concurrency & write guardrails**:
  - **Read-only concurrency (`readOnly: true`)**: Skips the concurrent write lock for read-only `general-purpose` reviews/investigations and disables `write`, `edit`, and `apply_patch` while keeping `bash` and optional `mcp__*` available.
  - **Light concurrent edits (`writeScope`)**: Parallel main-checkout `general-purpose` calls must declare non-overlapping `writeScope` prefixes normalized against the active session working directory and real symlink targets. `write`, `edit`, and `apply_patch` paths are verified before execution for local runs. (Note: `bash`/`pwsh` shell commands and external `subagentProvider` runs are not path-filtered inside the child.)
  - **Isolated Git branch edits (`isolation: "worktree"`)**: Optionally binds DSH's official `@deepseek-ai/dsh-experimental-worktree` plugin (`ctx.worktrees.create` inside the local child's `agent/created` hook so the parent session is untouched). Skips the main-checkout write lock so parallel local workers can edit overlapping or shared files; automatically removes no-op worktrees/branches on exit and auto-commits completed changes onto the isolated branch for parent review and merge via `git`. Fails fast with an installation prompt when `@deepseek-ai/dsh-experimental-worktree` is absent, or when the main checkout has uncommitted tracked edits.
- **Fork delegation guard**: `fork` children preserve the exact parent tool list and permissions for KV-cache fidelity while rejecting nested `orchestrate_subagent` calls (persisted across cold resume).

## Local Development & Benchmarking

### Link Without Publishing

Link your local checkout into your DSH profile once:

```sh
dsh plugin add /path/to/dsh-roles
# or inside your profile directory:
# pnpm add link:/path/to/dsh-roles --config.auto-install-peers=false
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

Compare baseline vs orchestration session logs and `[dsh-roles] telemetry` lines:

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

[MIT](https://github.com/myth929/dsh-roles/blob/main/LICENSE)
