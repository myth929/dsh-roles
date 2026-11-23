# dsh-roles

[English](https://github.com/myth929/dsh-roles/blob/main/README.md) · [简体中文](https://github.com/myth929/dsh-roles/blob/main/README_zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-roles)](https://www.npmjs.com/package/dsh-roles)
[![GitHub stars](https://img.shields.io/github/stars/myth929/dsh-roles?style=social)](https://github.com/myth929/dsh-roles)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/myth929/dsh-roles/blob/main/LICENSE)

**面向 [DeepSeek Harness](https://www.deepseek.com/harness/)（`DSH >=0.2.2-rc.1`）的轻量级子智能体角色编排插件包。**

[`dsh-roles`](https://www.npmjs.com/package/dsh-roles) 将子智能体委派统一收敛为单一的模型可见工具 `orchestrate_subagent`，对齐 Claude Code 的内置角色分层设计：

- **五大分层角色** — `general-purpose`（通用执行）、`explore`（只读探索）、`plan`（架构规划）、`fork`（上下文分叉）与 `dsh-code-guide`（DSH 专项顾问），按角色隔离提示词上下文、工具权限与工具输出裁剪策略。
- **按角色模型与 OAR 运行时路由** — 默认零配置跟随主会话模型；也支持通过 Web UI 或环境变量为每个可配置角色独立指定 LLM（`provider/model` + 推理强度 `reasoningEffort`）或 OAR 外部运行时（`oar-antigravity`、`oar-codex`、`oar-claude` 等）。
- **内置安全护栏** — 两阶段步数预算与无工具收敛收尾、并行写入的 `writeScope` 非重叠校验，以及对齐 Claude Code 的单层（`root → child`）分叉委派拦截。
- **真实委派遥测与基准评测** — 输出结构化 `[dsh-roles] telemetry` 日志，内置离线对比报告与在线基准测试脚本。

## 安装 / 更新

### 在 DeepSeek Harness 网页版或桌面版中安装

打开 **Plugins → Add plugin**，搜索 `dsh-roles` 并点击 **Install**。安装后可直接在 DSH 插件管理器中启用或停用本插件。

### 使用 `dsh` CLI 安装

从 npm 或直接从 GitHub 安装 [`dsh-roles`](https://www.npmjs.com/package/dsh-roles)：

```sh
dsh plugin add dsh-roles
# 或直接从 GitHub 安装：
dsh plugin add myth929/dsh-roles
```

更新到最新版本：

```sh
dsh plugin update dsh-roles@latest
```

### 依赖契约

本包不安装任何运行时模块：Host 插件本体、4 个内部 preset，以及 preset 内部挂载的工具插件，全部由宿主 profile 提供。因此 `cordis.patch.yml` 里每个 `name:` 对应的包都登记在 `peerDependencies` 中，`tests/patch-dependencies.test.ts` 会在两者不一致时失败——新增 patch 行却忘了声明依赖，会被测试拦下。

DSH profile 的 `pnpm-workspace.yaml` 默认设置 `autoInstallPeers: false`，这些 peer 不会被重复安装；安装时 pnpm 可能提示它们「未被满足」，这是预期的——模块由宿主提供，本包不安装。若你在普通 pnpm 工程里手工 link 本包，请保持该设置，否则会装入宿主包的副本，让同一个服务被注册两次。

## 角色体系

| 角色 | 底层实现 / 预设 | 能力与上下文策略 | 执行方式 |
| --- | --- | --- | --- |
| `general-purpose` *（默认·通用执行）* | 内置预设 `dsh-roles-general-purpose`（`spawn` 或已配置的 `subagentProvider`） | 具备 `read`、`write`、`edit`、`glob`、`grep`、`bash`/`pwsh`、`jobs`、`todo`；保留工作区指令（`AGENTS.md`），默认剥离 `mcp__*`（除非传入 `includeMcp: true`），支持 `readOnly: true`、`writeScope` 与 `isolation: "worktree"` | 默认同步（传入 `background: true` 可异步执行） |
| `explore` *（只读探索）* | 内置预设 `dsh-roles-explore`（`spawn`） | 快速只读检索（`read`、`glob`、`grep`）；剥离工作区指令与技能目录，采用紧凑工具输出裁剪，返回带精确行号范围的 `Key Files` | 默认同步 |
| `plan` *（架构规划）* | 内置预设 `dsh-roles-plan`（`spawn` 或已配置的 `subagentProvider`） | 只读架构规划（`read`、`glob`、`grep`）；剥离工作区指令与技能目录，采用较宽的工具输出裁剪，返回 `Critical Files for Implementation` | 默认同步 |
| `fork` *（上下文分叉）* | 官方 `fork` | 继承父会话已完成轮次以及父会话模型与推理强度；保持 `messages[0]` 与工具声明和父会话完全一致以复用 KV-Cache 并保留完整工具权限，同时通过护栏禁止嵌套分叉与超深委派 | 默认同步 |
| `dsh-code-guide` *（DSH 专项顾问）* | 内置预设 `dsh-roles-guide`（`spawn`） | 只读 DSH / Cordis 专家（`read`、`glob`、`grep`、`web_fetch`、`web_search`、`cordis_inspect_list`、`cordis_inspect_query`）；剥离工作区指令并注入 `# Current DSH Environment`（包含已安装的 `@deepseek-ai/*` 文档根目录与实时宿主摘要） | 默认同步 |

内部预设（`dsh-roles-general-purpose`、`dsh-roles-explore`、`dsh-roles-plan`、`dsh-roles-guide`）会自动从面向用户的预设选择器（`agentPresets.list()`）中隐藏；只要 `orchestrate_subagent` 可见，原始的 `subagent` / `subagent_fork` / `subagent_oar` 工具会自动收敛到 `orchestrate_subagent`。

## 配置说明

支持开箱即用的零配置运行，配置优先级为：`Loader` 配置项 `config` > 进程环境变量 > 默认值：

| 配置项 / 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `models` / `DSH_ROLES_MODELS` | 所有角色跟随主会话模型 | 为 `general-purpose`、`explore`、`plan`、`dsh-code-guide` 配置独立路由（`"provider/model"` 字符串或 `{ provider, model, reasoningEffort, subagentProvider }` 对象）。由于分叉必须继承主模型以复用缓存，配置 `fork` 会被拒绝 |
| `exploreProvider` / `exploreModel`（`DSH_ROLES_EXPLORE_PROVIDER` / `DSH_ROLES_EXPLORE_MODEL`） | *（未设置 — 跟随主模型）* | 为向后兼容保留的旧版 `explore` 路由字段（`models.explore` 优先级更高） |
| `budgets` / `DSH_ROLES_BUDGETS` | `general-purpose: 8/16/28`、`explore: 4/8/14`、`plan: 5/10/18`、`fork: 5/10/18`、`dsh-code-guide: 4/8/14` | 按角色配置的 `quick` / `standard` / `thorough` 三档步数预算（JSON 对象或字符串，整数范围 `2..200`） |

按角色指定模型与 OAR 运行时的环境变量示例：

```sh
DSH_ROLES_MODELS='{"explore":"deepseek/deepseek-chat","dsh-code-guide":"deepseek/deepseek-chat","plan":{"provider":"openai","model":"gpt-5.4","reasoningEffort":"high"},"general-purpose":{"subagentProvider":"oar-codex"}}'
DSH_ROLES_BUDGETS='{"explore":{"quick":3},"general-purpose":{"standard":20}}'
```

### Web UI 交互式配置

你也可以直接在 DSH Web 界面的 **Plugins → dsh-roles** 页面中可视化配置各角色路由：

- 所有可配置角色（`general-purpose`、`explore`、`plan`、`dsh-code-guide`）默认跟随主会话模型，并展示对应的推荐模型能力档位。
- 各角色共用统一的下拉选择器，可在 OAR / 外部子智能体运行时（`oar-antigravity`、`oar-codex`、`oar-claude`、`codex` 等）与已授权 LLM 模型之间切换，并按需设置推理强度（`reasoningEffort`）。
- 前端插件包加载后，配置修改会立即持久化生效，无需重启宿主进程。委派深度固定为单层（`root → child`），与 Claude Code 保持一致。

### OAR 外部子智能体运行时

- **Codex / Claude Code（`oar-codex`、`oar-claude`）**：`dsh-roles` 按需自动发现宿主已注册的 OAR 运行时，无需内置捆绑 `@botiverse/oar`。请在你的 DSH Profile 中安装并配置官方插件 `@deepseek-ai/dsh-experimental-subagent-oar`，并完成对应原生 CLI 的登录认证；未安装时设置页会显示安装引导提示。
- **Antigravity（`oar-antigravity`）**：在官方 `@deepseek-ai/dsh-experimental-subagent-oar` 插件升级其内嵌 OAR 运行时以支持独立版 `agy >= 1.5.0` 之前，只要检测到本机已安装 `agy`，`dsh-roles` 会自动注册一个遵循官方 OAR 契约的内置 `oar-antigravity` 提供方。一旦你在 `@deepseek-ai/dsh-experimental-subagent-oar` 中配置了官方 `oar-antigravity` 项，内置回退实现会自动让位。

## 安全护栏

- **两阶段步数预算**：当 `step >= budget - 1` 时自动启用工具禁用（`allow: []`）与兜底拒绝拦截，使最后一步干净地以零工具模式渲染，并注入一次性收敛提示；在 `turn/end` 时重置状态以支持后续续跑。超限时若已有非空阶段性输出，会保留并标记为 `budget-exhausted`。
- **三层并发与写入护栏**：
  - **只读并发（`readOnly: true`）**：用于需要 `bash`/MCP 的多路只读 `general-purpose` 审查与排障，跳过并发写锁并禁用 `write`、`edit`、`apply_patch`。
  - **轻并发写（`writeScope`）**：同一父步骤内并行发起的多个主工作区 `general-purpose` 写入调用必须声明互不重叠的 `writeScope` 前缀，路径会基于当前会话工作目录与真实符号链接目标归一化。本地执行会在调用前校验 `write`、`edit` 与 `apply_patch` 路径。（注意：`bash`/`pwsh` 终端命令及外部 `subagentProvider` 内部执行不做子进程路径拦截。）
  - **分支隔离并发写（`isolation: "worktree"`）**：按需可选注入 DSH 官方插件 `@deepseek-ai/dsh-experimental-worktree`，在本地子 Agent 的 `agent/created` 阶段调用 `ctx.worktrees.create(childAgent)`，不污染主会话目录与上下文。跳过主工作区写锁以支持并行修改公共/重叠文件；结算时自动回收空改动分支、自动标准化提交已完成改动并返回分支/diff 坐标供主 Agent 通过 `git` 审查合入。未安装官方包或主工作区存在未提交 tracked 改动时快速失败并给出提示。
- **分叉委派保护**：`fork` 子智能体完整保留父会话的工具清单与权限以确保 KV-Cache 命中，同时在运行时拒绝嵌套调用 `orchestrate_subagent`（冷恢复后依然生效）。

## 本地开发与基准测试

### 本地软链调试（无需发布）

将本地仓库一次性链接到你的 DSH Profile 中：

```sh
dsh plugin add /path/to/dsh-roles
# 或在 Profile 目录中执行：
# pnpm add link:/path/to/dsh-roles --config.auto-install-peers=false
```

构建产物至 `lib/`：

```sh
pnpm run build
# 或在编辑代码时开启监听构建：
pnpm run dev
```

重启 DSH 宿主即可立即加载更新后的 `lib/`，无需重新发布或重装插件。

### 构建、类型检查与测试

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
```

### 基准测试

对比基线（baseline）与开启编排（enabled）后的会话日志及 `[dsh-roles] telemetry` 遥测记录：

```sh
pnpm run build
node scripts/benchmark-report.mjs \
  --baseline /path/to/baseline/sessions \
  --enabled /path/to/enabled/sessions \
  --telemetry /path/to/agent.log
```

针对 OpenAI 兼容接口运行在线基准测试（需要配置 `DSH_BENCHMARK_API_KEY` / `DEEPSEEK_API_KEY` / `OPENAI_API_KEY`，可选 `DSH_BENCHMARK_BASE_URL` 与 `DSH_BENCHMARK_MODEL`）：

```sh
pnpm run build
node scripts/live-benchmark.mjs --tasks simple,explore,parallel --modes baseline,enabled
```

## 许可证

[MIT](https://github.com/myth929/dsh-roles/blob/main/LICENSE)
