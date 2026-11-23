# Changelog

All notable changes to `dsh-roles` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2026-11-23

### Added

- **Single unified delegation tool (`orchestrate_subagent`)**: Converges bare `subagent`, `subagent_fork`, and `subagent_oar` entries into one role-layered entry point while hiding internal presets from user-facing mode selectors.
- **Five Claude-aligned roles**: `general-purpose`, `explore`, `plan`, `fork` (KV-cache-preserving parent context fork), and `dsh-code-guide` (local `@deepseek-ai/*` doc root discovery + live host summary).
- **Web UI configuration card**: Live model, reasoning effort, and external subagent runtime (`codex`, `claude-code`, `oar-*`) routing under **Plugins → dsh-roles** with bilingual (EN/ZH) labels and zero-restart hot updates.
- **Built-in `oar-antigravity` fallback provider**: Automatically registers when local `agy >= 1.5.0` is detected and yields cleanly to `@deepseek-ai/dsh-experimental-subagent-oar`.
- **Execution guardrails**:
  - Two-stage bounded step budgets (`quick` / `standard` / `thorough`) with tool-free convergence on the final step and partial-output preservation (`budget-exhausted`).
  - Three-tier parallel write safety: `readOnly: true`, disjoint `writeScope` path prefixes anchored to the worker's initial workspace, and `isolation: "worktree"` backed by `@deepseek-ai/dsh-experimental-worktree`.
  - Fixed single-level delegation depth (`root -> child`), persisted across cold resumes.
- **Delegation reminders & telemetry**: Native `<system-reminder>` role catalog injection, periodic refresh, mid-turn drift nudges (`DSH_ROLES_REMINDERS`), and structured telemetry / benchmark helpers.
