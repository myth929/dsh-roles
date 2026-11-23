/** Locale dictionaries for the `dsh-roles` plugin configuration page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

export const NS = 'dshRoles'

export const en = {
  overridden: 'Customized',
  reset: 'Reset',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'Orchestration settings are currently unavailable.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  conflict: 'Settings changed elsewhere. Reopen or discard your changes and try again.',

  roleModelsTitle: 'Preset Roles & Model Routing',
  roleModelsIntro:
    'All preset roles follow the parent session model by default. Override any role below to balance intelligence, speed, and cost — or delegate it to an OAR runtime.',
  statusRuntimesReady: '{oarCount} OAR · {providerCount} model providers available',
  statusProvidersOnly: '{providerCount} model providers available',
  loadingCatalog: 'Loading available models and external runtimes…',
  catalogLoadFailed: 'Could not load the model catalog or external runtimes.',
  retry: 'Retry',
  catalogPartial: 'Some model providers failed to load; saved choices remain shown.',
  catalogEmpty: 'No subagent-capable LLM models or external runtimes are available.',
  oarInstallHintTitle: 'Want to use Codex or Claude Code via OAR?',
  oarInstallHint:
    'Install and configure the official @deepseek-ai/dsh-experimental-subagent-oar plugin in your DSH profile and sign in to the corresponding CLI.',

  routeFieldLabel: 'Model / Runtime',
  inheritDefault: 'Default (follow parent model)',
  oarGroup: 'OAR external runtimes (Antigravity / Codex / Claude)',
  externalGroup: 'Other subagent runtimes',
  unavailableGroup: 'Saved but currently unavailable',
  unavailableOption: '{value} (unavailable)',

  reasoningLabel: 'Reasoning effort',
  reasoningDefault: 'Default effort',

  tierStrong: 'Strong model',
  tierReasoning: 'Strong reasoning',
  tierFast: 'Fast / light model',
  tierBalanced: 'Light / balanced',
  tierLocked: 'Locked to parent',

  capReadWriteShell: 'Read / Write / Shell',
  capReadOnly: 'Read-only search',
  capArchitect: 'Read-only planning',
  capDocs: 'Read-only docs & web',
  capFork: 'Shared cache · Full tools',

  roleGeneralPurposeLabel: 'Execution worker',
  roleGeneralPurposeHint: 'Handles multi-step coding, complex debugging, and independent code reviews with full tool access.',
  roleGeneralPurposeAdvice: 'Best with a strong coding model (or OAR runtime like Antigravity / Codex / Claude) to avoid multi-step edit mistakes.',

  roleExploreLabel: 'Codebase exploration',
  roleExploreHint: 'Scans directories, traces call sites, and returns exact file coordinates without modifying code.',
  roleExploreAdvice: 'Best with a fast, low-cost model — high-frequency search benefits more from speed than deep reasoning.',

  rolePlanLabel: 'Architecture planning',
  rolePlanHint: 'Reads relevant modules, weighs trade-offs, and produces a step-by-step implementation blueprint.',
  rolePlanAdvice: 'Best with a strong reasoning model (optionally paired with medium/high reasoning effort) for sound architecture decisions.',

  roleGuideLabel: 'DSH / Cordis specialist',
  roleGuideHint: 'Answers questions about DSH CLI, profiles, Cordis plugins, and live host configuration from local docs.',
  roleGuideAdvice: 'A light or balanced model is usually enough — tasks are grounded directly in local package docs.',

  roleForkLabel: 'Context fork',
  roleForkHint: 'Inherits completed parent turns and shares the parent prompt cache for audits, verification runs, or open surveys.',
  roleForkAdvice: 'Must stay on the parent model to preserve prompt-cache fidelity; no separate model override needed.',
  roleForkFixed: 'Always follows parent model',
} as const

export type OrchestrationLocaleKey = keyof typeof en

export const zh: Record<OrchestrationLocaleKey, string> = {
  overridden: '已自定义',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '当前插件未就绪，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  conflict: '配置已在其他位置更新，请刷新或放弃修改后重试。',

  roleModelsTitle: '预置角色与模型路由',
  roleModelsIntro:
    '所有预置角色默认跟随主会话模型。你可以按角色职责单独指定更强或更轻快的模型，或委派给 OAR 外部运行时。',
  statusRuntimesReady: '已就绪：{oarCount} 个 OAR 运行时 · {providerCount} 个模型提供方',
  statusProvidersOnly: '已就绪：{providerCount} 个模型提供方',
  loadingCatalog: '正在加载可用模型与 OAR 运行时…',
  catalogLoadFailed: '无法加载模型列表或外部运行环境。',
  retry: '重试',
  catalogPartial: '部分模型提供方加载失败；已保存的配置仍可保留或重置。',
  catalogEmpty: '当前没有可用于子智能体的模型或外部运行时。',
  oarInstallHintTitle: '如需使用 Codex / Claude 等 OAR 外部运行时',
  oarInstallHint:
    '请先在 DSH Profile 中安装并配置官方插件 @deepseek-ai/dsh-experimental-subagent-oar，并完成对应原生 CLI 登录。',

  routeFieldLabel: '模型 / 运行时',
  inheritDefault: '默认（跟随主模型）',
  oarGroup: 'OAR 外部子智能体（Antigravity / Codex / Claude 等）',
  externalGroup: '其他子智能体后端',
  unavailableGroup: '已保存但当前不可用',
  unavailableOption: '{value}（不可用）',

  reasoningLabel: '推理强度',
  reasoningDefault: '默认推理强度',

  tierStrong: '推荐强模型',
  tierReasoning: '推荐强推理模型',
  tierFast: '推荐轻量快模型',
  tierBalanced: '推荐轻量 / 均衡模型',
  tierLocked: '锁定主模型',

  capReadWriteShell: '读写 + 终端',
  capReadOnly: '只读检索',
  capArchitect: '只读规划',
  capDocs: '只读文档与联网',
  capFork: '共享缓存 · 完整工具',

  roleGeneralPurposeLabel: '通用执行',
  roleGeneralPurposeHint: '负责多步骤编码实现、复杂排查与独立代码评审，具备完整文件与终端工具。',
  roleGeneralPurposeAdvice: '建议使用能力强的代码模型或 OAR（Antigravity / Codex / Claude），保障多步改动与排障质量。',

  roleExploreLabel: '只读探索',
  roleExploreHint: '只读扫描代码库、定位调用链路并返回精确文件行号，不修改任何文件。',
  roleExploreAdvice: '建议使用响应快、成本低的轻量模型，高频检索场景下速度收益远大于重度推理。',

  rolePlanLabel: '架构规划',
  rolePlanHint: '只读通读相关模块、权衡架构方案并输出分步实现计划与关键文件清单。',
  rolePlanAdvice: '建议使用强推理模型（可按需调高推理强度），减少方案遗漏与返工成本。',

  roleGuideLabel: 'DSH 专项顾问',
  roleGuideHint: '只读查阅本地 @deepseek-ai/* 包文档与实时宿主状态，解答 DSH / Cordis 配置问题。',
  roleGuideAdvice: '使用轻量或均衡模型即可，回答主要基于本地权威文档检索，无需重型模型。',

  roleForkLabel: '上下文分叉',
  roleForkHint: '继承父会话已完成轮次并复用提示词缓存，适合收尾审计、验证测试或开放式巡检。',
  roleForkAdvice: '为完整复用父会话 KV-Cache，必须与主模型保持一致，无需单独覆盖。',
  roleForkFixed: '始终跟随主模型',
}

export function formLabels(t: (key: OrchestrationLocaleKey) => string): SettingsFormLabels {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
}
