<div align="center">
  <img src="https://raw.githubusercontent.com/myth929/dsh-roles/main/assets/icon-180.png" width="76" height="76" alt="dsh-roles icon">

  <h1>dsh-roles</h1>

  <p>
    <strong>Role-layered subagent orchestration for <a href="https://www.deepseek.com/harness/">DeepSeek Harness</a>.</strong><br>
    Per-role context &amp; tool isolation, Web UI model &amp; external runtime routing, step budgets, and parallel write guardrails.
  </p>

  <p>
    <a href="https://www.npmjs.com/package/dsh-roles"><img src="https://img.shields.io/npm/v/dsh-roles?style=flat-square&color=3b82f6" alt="npm version"></a>
    <img src="https://img.shields.io/badge/DSH-%3E%3D0.2.2--rc.1-10b981?style=flat-square" alt="DSH version">
    <a href="https://github.com/myth929/dsh-roles/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-64748b?style=flat-square" alt="License: MIT"></a>
  </p>

  <p>
    <strong>English</strong> · <a href="https://github.com/myth929/dsh-roles/blob/main/README_zh.md">简体中文</a>
  </p>
</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/myth929/dsh-roles/main/assets/settings-en.png" width="100%" alt="dsh-roles Web UI — Preset Roles & Model Routing">
  <br>
  <sub><code>Plugins → dsh-roles</code> — assign each preset role to an LLM model or external subagent runtime without restarting.</sub>
</p>

`dsh-roles` converges subagent delegation into a single `orchestrate_subagent` tool aligned with Claude Code's built-in roles. Internal presets are hidden from user-facing preset selectors, and bare `subagent` / `subagent_fork` / `subagent_oar` tools automatically converge into `orchestrate_subagent`.

---

## Install & Update

- **Web / Desktop**: Open **Plugins → Add plugin**, search `dsh-roles`, and click **Install**.
- **CLI**:

```sh
dsh plugin add dsh-roles          # or: dsh plugin add myth929/dsh-roles
dsh plugin update dsh-roles@latest
```

## Roles

| Role | Purpose | Capabilities & Defaults |
| --- | --- | --- |
| `general-purpose` *(default)* | Multi-step coding, debugging, code review | Full tools (`read`, `write`, `edit`, `glob`, `grep`, `bash`/`pwsh`, `jobs`, `todo`); keeps `AGENTS.md`; supports `background`, `readOnly`, `writeScope`, `isolation: "worktree"`, and `includeMcp` |
| `explore` | Fast read-only codebase search | `read`, `glob`, `grep`; strips workspace instructions & skill catalogs; compact pruning; returns `Key Files` |
| `plan` | Read-only architecture planning | `read`, `glob`, `grep`; strips workspace instructions & skill catalogs; returns `Critical Files for Implementation` |
| `fork` | Context-sharing audits & verification | Inherits completed parent turns, model, and prompt cache with full parent tools; blocks nested delegation |
| `dsh-code-guide` | DSH / Cordis specialist | Read-only docs, web, and `cordis_inspect_*`; injects local `@deepseek-ai/*` doc roots & live host summary |

## Configuration

Works out of the box with zero configuration (all roles follow the parent session model).  
Priority: **Web UI / Loader config > environment variables > defaults**.

### Web UI

Open **Plugins → dsh-roles** to assign any configurable role (`general-purpose`, `explore`, `plan`, `dsh-code-guide`) to an LLM (`provider/model` + optional `reasoningEffort`) or an external subagent runtime (`oar-antigravity`, `oar-codex`, `oar-claude`, `codex`, etc.). Changes apply immediately without restarting. `fork` always follows the parent model to preserve prompt-cache reuse.

### Environment Variables

| Option / Env | Default | Description |
| --- | --- | --- |
| `models` / `DSH_ROLES_MODELS` | Follow parent model | Per-role route map: `"provider/model"` or `{ provider, model, reasoningEffort, subagentProvider }` (`fork` cannot be overridden) |
| `budgets` / `DSH_ROLES_BUDGETS` | `general-purpose: 8/16/28`, `explore`/`dsh-code-guide: 4/8/14`, `plan`/`fork: 5/10/18` | Per-role `quick` / `standard` / `thorough` step budgets (integer `2..200`) |
| `reminders` / `DSH_ROLES_REMINDERS` | `{ nudgeInspectionSteps: 3, maxNudges: 3, catalogRefreshTurns: 3 }` | Mid-turn delegation nudge cadence (`nudgeInspectionSteps` `1..50`, `maxNudges` `0..20`) and periodic catalog refresh interval (`catalogRefreshTurns` `0..50`) |

```sh
DSH_ROLES_MODELS='{"explore":"deepseek/deepseek-chat","plan":{"provider":"openai","model":"gpt-5.4","reasoningEffort":"high"},"general-purpose":{"subagentProvider":"oar-antigravity"}}'
DSH_ROLES_BUDGETS='{"explore":{"quick":3},"general-purpose":{"standard":20}}'
DSH_ROLES_REMINDERS='{"nudgeInspectionSteps":4,"maxNudges":2,"catalogRefreshTurns":3}'
```

### External Subagent Runtimes (OAR)

- **Codex / Claude Code**: Install and configure `@deepseek-ai/dsh-experimental-subagent-oar` (plus native CLI sign-in) or standalone plugins such as `@deepseek-ai/dsh-subagent-codex` / `@deepseek-ai/dsh-subagent-claude-code`; `dsh-roles` discovers registered providers automatically.
- **Antigravity (`oar-antigravity`)**: Auto-registered as a built-in fallback whenever `agy` (`>= 1.5.0`) is detected locally, and yields automatically once configured in `@deepseek-ai/dsh-experimental-subagent-oar`. It is only invoked when you explicitly route a role to `oar-antigravity`, and runs `agy acp --dangerously-skip-permissions` with non-interactive permission auto-approval.

## Guardrails

- **Bounded step budgets** — disables tools on the final step for clean tool-free convergence and preserves partial output as `budget-exhausted`.
- **Three-tier parallel write safety**:
  - `readOnly: true` — skips the write lock and disables `write`/`edit`/`apply_patch` while keeping `bash` and optional MCP tools.
  - `writeScope` — requires non-overlapping path prefixes for parallel main-checkout edits (enforced on `write`/`edit`/`apply_patch`, anchored to the worker's initial workspace directory).
  - `isolation: "worktree"` — isolates parallel edits in separate Git worktrees via `@deepseek-ai/dsh-experimental-worktree`, auto-cleaning no-op branches and committing completed changes for parent review (use synchronous mode for the inline diff summary; `background: true` finalizes asynchronously).
- **Single-level delegation** — fixed `root → child` depth (including `fork`, persisted across cold resume).

## Contributing

Issues and pull requests are welcome at [myth929/dsh-roles/issues](https://github.com/myth929/dsh-roles/issues).

```sh
git clone https://github.com/myth929/dsh-roles.git
cd dsh-roles
pnpm install
dsh plugin add /path/to/dsh-roles   # link local checkout into your DSH profile
```

Before opening a PR, run `pnpm run build && pnpm run typecheck && pnpm test` (Node.js `>=24` and `pnpm`). Keep `cordis.patch.yml` in sync with `peerDependencies` (verified by tests), and update both `README.md` / `README_zh.md` (plus `locale/*.json` and `src/client/locales.ts` for UI changes). Orchestration changes can also be evaluated with `pnpm run benchmark:report` or `pnpm run benchmark:live`.

## License

[MIT](https://github.com/myth929/dsh-roles/blob/main/LICENSE)
