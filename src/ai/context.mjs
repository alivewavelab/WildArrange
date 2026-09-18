// =============================================================================
// 文件名称：context.mjs
// 所属模块：ai
// 作用说明：
//   构建 Agent 运行时上下文包（身份 Prompt、任务摘要、规则、注入点、Git 变更），
//   并管理会话 lineage、resume 报告与 Stop Hook 续跑指令。不负责 Hook 事件分发。
//
// 【运行原理速读】
//   · 何时触发？ hooks.mjs（SessionStart/PreToolUse）、CLI resume/continuation、
//     buildAgentContext 被显式调用。
//   · 做了什么？ ① 解析任务与 Agent ② resolveInjectionPoint ③ 写 context-agents/*
//     ④ recordRuntimeSession / resumeReport / continuationDirective。
//   · 与谁协作？ injection、task-board、rule-scanner、runtime-snapshot、status。
// =============================================================================

import { renderResponsibilityChanges } from "../infra/responsibility-contract.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_EXECUTOR_AGENT,
  DEFAULT_LEAD_AGENT,
} from "../infra/agent-registry.mjs";
import {
  STATE_VERSION,
  createWorkId,
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { normalizeRelativePath } from "../infra/path-match.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { collectGitChangedPaths } from "../infra/git-diff.mjs";
import { renderPromptPackEntry } from "../infra/prompt-pack.mjs";
import { writeRuntimeContextSnapshot } from "../infra/runtime-snapshot.mjs";
import { uniqueStrings } from "../infra/text-utils.mjs";
import { defaultInjectionPointForAgent, resolveInjectionPoint } from "./injection.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";
import { scanProjectRules } from "../infra/rule-scanner.mjs";
import { findRunnableTask, normalizeAgentName } from "../orchestration/task-board.mjs";
import { statusReport } from "../orchestration/status.mjs";

// --- Agent 上下文构建 ---

/**
 * 为指定 Agent/任务构建完整上下文包，写入 context-agents/*.json|.md 并记 ledger。
 * @param {string} rootDir 控制根目录
 * @param {object} options agent、taskId、planId、executionRoot、injectionPoint、role
 * @returns {Promise<object>} kind=wildarrange_agent_context
 */
export async function buildAgentContext(rootDir, options = {}) {
  const executionRoot = options.executionRoot || rootDir;
  await ensureWildArrangeDirs(rootDir);
  const { config, sourcePath } = await loadWildArrangeConfig(rootDir);
  const taskState = await loadTaskState(rootDir, { planId: options.planId });
  const task = resolveContextTask(taskState?.tasks || [], options.taskId, options.planId);
  const changed = await collectGitChangedPaths(executionRoot);
  const targetPaths = uniqueStrings([
    ...(task?.writable_paths || []),
    ...(changed.available ? changed.paths : []),
  ].map(normalizeRelativePath));
  const rules = await scanProjectRules(executionRoot, { controlRoot: rootDir, targetPaths });
  const agent = normalizeAgentName(options.agent || task?.owner || DEFAULT_EXECUTOR_AGENT) || DEFAULT_EXECUTOR_AGENT;
  const resumeContext = await writeContextSnapshot(rootDir, { reason: `agent-context:${agent}` });
  const role = options.role || roleForAgent(agent);
  const injectionPointName = options.injectionPoint || defaultInjectionPointForAgent(agent, { taskId: task?.id });
  // 仅执行前注入点挂载任务绑定 Skill，其他阶段走静态注入点清单
  const taskSkills = injectionPointName === "before_execute"
    ? task?.skills || []
    : [];
  const injectionPoint = await resolveInjectionPoint(rootDir, injectionPointName, {
    agent,
    taskId: task?.id || "",
    planId: options.planId || task?.planId || taskState?.planId || "",
  }, {
    text: task ? `${task.subject}\n${task.description || ""}` : "",
    stage: stageForInjectionPoint(injectionPointName),
    taskSkills,
  });
  const modelConfig = config.agents?.[agent] || null;
  const agentPromptContent = await renderPromptPackEntry(rootDir, { agent });
  const agentPrompt = prepareAgentPrompt(
    agentPromptContent,
    config.contextBudgets?.prompt?.maxChars,
    agent,
  );
  const context = {
    kind: "wildarrange_agent_context",
    version: STATE_VERSION,
    at: nowIso(),
    configPath: sourcePath,
    agent,
    role,
    model: modelConfig,
    agentPrompt,
    injectionPoint,
    task: task ? summarizeTaskForContext(task) : null,
    status: resumeContext.status,
    nextAction: resumeContext.nextAction,
    projectRules: {
      matched: rules.matched,
      total: rules.total,
      reportMdPath: rules.reportMdPath,
      rules: rules.rules.map((rule) => ({
        path: rule.path,
        description: rule.description,
        alwaysApply: rule.alwaysApply,
        globs: rule.globs,
      })),
    },
    changedPaths: changed.available ? changed.paths : [],
    changedPathStatus: changed.available ? "available" : "unavailable",
    changedPathReason: changed.available ? null : changed.reason,
    invariants: [
      "Worker done-claim is not completion.",
      "Checkpoint requires verifier PASS, scope guard non-fail, and review gate PASS.",
      "Scope drift requires ChangeRequest review before retry.",
      "Do not weaken verify_commands, review_commands, standards_commands, or project rules to manufacture PASS.",
    ],
    resumeContextPath: resumeContext.reportMdPath,
    rulesContextPath: rules.reportMdPath,
  };
  const suffix = task ? `${agent}-${task.id}` : `${agent}-general`;
  const jsonPath = resolveWildArrangePath(rootDir, "context-agents", `${suffix}.json`);
  const mdPath = resolveWildArrangePath(rootDir, "context-agents", `${suffix}.md`);
  context.reportJsonPath = normalizeRelativePath(path.relative(rootDir, jsonPath));
  context.reportMdPath = normalizeRelativePath(path.relative(rootDir, mdPath));
  await writeJsonAtomic(jsonPath, context);
  await writeFile(mdPath, renderAgentContextMarkdown(context), "utf8");
  await appendLedger(rootDir, {
    type: "agent_context_built",
    agent,
    role,
    taskId: task?.id || null,
    rulesMatched: rules.matched,
    promptChars: agentPrompt.chars,
    promptLoadedChars: agentPrompt.loadedChars,
    promptTruncated: agentPrompt.truncated,
    contextPath: context.reportMdPath,
  });
  return context;
}

/**
 * 写入运行时上下文快照（委托 runtime-snapshot）。
 * @param {string} rootDir 项目根目录
 * @param {object} options 快照原因与附加数据
 */
export async function writeContextSnapshot(rootDir, options = {}) {
  return writeRuntimeContextSnapshot(rootDir, options);
}

// --- 会话与续跑 ---

/**
 * 记录或更新会话 lineage（sessions/lineage.json）。
 * @param {string} rootDir 项目根目录
 * @param {object} options sessionId、source
 * @returns {Promise<object>} 更新后的 lineage
 */
export async function recordRuntimeSession(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const sessionId = options.sessionId || process.env.WILDARRANGE_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.CURSOR_SESSION_ID || createWorkId("session");
  const source = options.source || "resume";
  const now = nowIso();
  const lineage = await readSessionLineage(rootDir);
  const existing = lineage.sessions.find((session) => session.id === sessionId);
  if (existing) {
    existing.lastSeenAt = now;
    existing.source = source;
  } else {
    lineage.sessions.push({ id: sessionId, source, firstSeenAt: now, lastSeenAt: now });
  }
  lineage.version = STATE_VERSION;
  lineage.currentSessionId = sessionId;
  lineage.sessionIds = lineage.sessions.map((session) => session.id);
  lineage.updatedAt = now;
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "sessions", "lineage.json"), lineage);
  await appendLedger(rootDir, { type: "session_recorded", sessionId, source });
  return lineage;
}

/**
 * 生成恢复报告：会话 lineage + 最新快照 + status + nextAction。
 * @param {string} rootDir 项目根目录
 * @param {object} options sessionId、source、cliCommandPrefix
 */
export async function resumeReport(rootDir, options = {}) {
  const lineage = await recordRuntimeSession(rootDir, {
    sessionId: options.sessionId,
    source: options.source || "resume",
  });
  const latestSnapshot = await readJson(resolveWildArrangePath(rootDir, "snapshots", "latest.json"), null);
  const report = await statusReport(rootDir);
  const context = await writeContextSnapshot(rootDir, {
    reason: "resume",
    latestSnapshot,
    cliCommandPrefix: options.cliCommandPrefix,
  });
  const resume = {
    latestSnapshot: latestSnapshot ? {
      id: latestSnapshot.id,
      stage: latestSnapshot.stage,
      at: latestSnapshot.at,
    } : null,
    status: report,
    session: {
      currentSessionId: lineage.currentSessionId,
      sessionIds: lineage.sessionIds,
    },
    contextPath: context.reportMdPath,
    nextAction: context.nextAction,
    nextActionDetails: context.nextActionDetails,
  };
  await appendLedger(rootDir, { type: "resume_reported", nextAction: resume.nextAction, sessionId: lineage.currentSessionId, contextPath: resume.contextPath });
  return resume;
}

/**
 * 判断 Stop Hook 是否应续跑，写入 sessions/continuation.* 并返回 directive。
 * @param {string} rootDir 项目根目录
 * @param {object} options sessionId、source、cliCommandPrefix
 * @returns {Promise<object>} shouldContinue、reason、nextCommand、resume
 */
export async function continuationDirective(rootDir, options = {}) {
  const resume = await resumeReport(rootDir, {
    sessionId: options.sessionId,
    source: options.source || "continuation",
    cliCommandPrefix: options.cliCommandPrefix,
  });
  const action = resume.nextActionDetails;
  // 计划待批、人工决策或无未完成工作时禁止 Stop Hook 自动续跑
  const shouldContinue = !["awaiting_plan_approval", "awaiting_user_decision", "no_unfinished_work"].includes(action.reason);
  const directive = {
    kind: "wildarrange_continuation_directive",
    version: STATE_VERSION,
    at: nowIso(),
    shouldContinue,
    reason: action.reason,
    taskId: action.taskId,
    nextCommand: action.command,
    message: shouldContinue
      ? `WildArrange 还有未收口工作：${action.taskId}。下一步：${action.command}，不要丢失上下文。`
      : ["awaiting_plan_approval", "awaiting_user_decision"].includes(action.reason) ? `${action.text}；不要自动续跑或重复催问。` : "WildArrange 当前没有可续跑任务。",
    resume,
  };
  const jsonPath = resolveWildArrangePath(rootDir, "sessions", "continuation.json");
  const mdPath = resolveWildArrangePath(rootDir, "sessions", "continuation.md");
  directive.reportJsonPath = normalizeRelativePath(path.relative(rootDir, jsonPath));
  directive.reportMdPath = normalizeRelativePath(path.relative(rootDir, mdPath));
  await writeJsonAtomic(jsonPath, directive);
  await writeFile(mdPath, renderContinuationMarkdown(directive), "utf8");
  await appendLedger(rootDir, { type: "continuation_checked", shouldContinue, reason: directive.reason, taskId: directive.taskId });
  return directive;
}

// --- 渲染与 Prompt 预算 ---

/** 将注入点名称映射为 skill-matcher 使用的 stage 标签。 */
function stageForInjectionPoint(pointName) {
  if (pointName === "before_execute") return "execute";
  if (pointName === "before_review") return "review";
  if (pointName === "repository_governance") return "review";
  if (pointName === "before_checkpoint") return "verify";
  if (pointName === "user_prompt_submit") return "plan";
  return "";
}

/** 按 taskId 精确查找，否则回退到可运行或 in_progress/verifying/failed 任务。 */
function resolveContextTask(tasks, taskId, planId) {
  const scopedTasks = planId ? tasks.filter((task) => task.planId === planId) : tasks;
  if (taskId) {
    const task = scopedTasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    return task;
  }
  return findRunnableTask(scopedTasks) || scopedTasks.find((task) => task.status === "in_progress" || task.status === "verifying" || task.status === "failed") || null;
}

/** 将 Agent 键名映射为上下文包中的 role 枚举。 */
function roleForAgent(agent) {
  if (agent === "BaiZe") return "independent_reviewer";
  if (agent === "DiJiang") return "planner";
  if (agent === "ZhuRong") return "implementation_worker";
  if (agent === "LuWu") return "repository_steward";
  if (agent === DEFAULT_LEAD_AGENT) return "lead_orchestrator";
  return "linear_worker";
}

/** 将 Agent 上下文对象渲染为人类可读的 Markdown 报告。 */
function renderAgentContextMarkdown(context) {
  const lines = [
    "# WildArrange Agent Context",
    "",
    `Generated: ${context.at}`,
    `Config: ${context.configPath}`,
    `Agent: ${context.agent}`,
    `Role: ${context.role}`,
    `Model: ${context.model ? `${context.model.provider || "unknown"}/${context.model.model || "unknown"}` : "(unconfigured)"}`,
    `Bound skills: ${context.model?.skills?.join(", ") || "(none)"}`,
    `Agent prompt: ${renderAttachmentSize(context.agentPrompt)}`,
    `Injection point: ${context.injectionPoint.name} (${context.injectionPoint.enabled ? "enabled" : "disabled"})`,
    `Resume context: ${context.resumeContextPath}`,
    `Rules context: ${context.rulesContextPath}`,
    "",
  ];
  lines.push("## Agent Prompt", "", context.agentPrompt.content, "");
  lines.push("## Task", "");
  if (context.task) appendTaskContext(lines, context.task);
  else lines.push("- None.");
  lines.push("", "## Project Rules", "");
  lines.push(`- Matched: ${context.projectRules.matched}/${context.projectRules.total}`);
  if (context.projectRules.rules.length === 0) {
    lines.push("- No matching rules.");
  } else {
    for (const rule of context.projectRules.rules) {
      lines.push(`- ${rule.path}: ${rule.description}`);
    }
  }
  lines.push("", "## Injection Mounts", "");
  lines.push(`- Tools: ${context.injectionPoint.tools.join(", ") || "(none)"}`);
  if (context.injectionPoint.markdown.length === 0) {
    lines.push("- Markdown: none");
  } else {
    for (const item of context.injectionPoint.markdown) lines.push(`- Markdown: ${item.path} (${renderAttachmentSize(item)})`);
  }
  if (context.injectionPoint.skills.length === 0) {
    lines.push("- Skills: none");
  } else {
    for (const item of context.injectionPoint.skills) lines.push(`- Skill: ${item.name} -> ${item.path} (${renderAttachmentSize(item)})`);
  }
  lines.push("", "## Changed Paths", "");
  if (context.changedPathStatus !== "available") {
    lines.push(`- Unavailable: ${context.changedPathReason}`);
  } else if (context.changedPaths.length === 0) {
    lines.push("- None.");
  } else {
    for (const filePath of context.changedPaths) lines.push(`- ${filePath}`);
  }
  lines.push("", "## Invariants", "");
  for (const invariant of context.invariants) lines.push(`- ${invariant}`);
  return `${lines.join("\n")}\n`;
}

/** 裁剪任务对象为上下文包所需字段，含失败/变更/复核摘要。 */
function summarizeTaskForContext(task) {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    category: task.category,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    writable_paths: task.writable_paths || [],
    responsibilityChanges: task.responsibilityChanges || null,
    verify_commands: task.verify_commands || [],
    review_commands: task.review_commands || [],
    standards_commands: task.standards_commands || [],
    lastFailure: task.last_failure ? {
      reason: task.last_failure.reason,
      retryHint: task.last_failure.retryHint,
      reportMdPath: task.last_failure.reportMdPath,
      resolvedBy: task.last_failure.resolvedBy,
    } : null,
    lastChangeRequest: task.last_change_request ? {
      id: task.last_change_request.id,
      status: task.last_change_request.status,
      reportMdPath: task.last_change_request.reportMdPath,
    } : null,
    lastReview: task.last_review_result ? {
      pass: task.last_review_result.pass,
      reportMdPath: task.last_review_result.reportMdPath,
      failedLanes: (task.last_review_result.lanes || []).filter((lane) => lane.status === "fail").map((lane) => lane.name),
    } : null,
  };
}

/** 向 Markdown 行数组追加单任务详情块（职责、命令、门禁状态）。 */
function appendTaskContext(lines, task) {
  lines.push(`- ${task.id}: ${task.subject}`);
  lines.push(`  - Status: ${task.status}; category=${task.category || "unresolved"}; attempts=${task.attempts}/${task.maxAttempts}`);
  lines.push(...renderResponsibilityChanges(task.responsibilityChanges));
  lines.push(`  - Writable: ${task.writable_paths.join(", ") || "(none)"}`);
  lines.push(`  - Verify: ${task.verify_commands.join(" && ") || "(none)"}`);
  if (task.review_commands.length > 0) lines.push(`  - Review: ${task.review_commands.join(" && ")}`);
  if ((task.standards_commands || []).length > 0) lines.push(`  - Standards: ${task.standards_commands.join(" && ")}`);
  if (task.lastReview) lines.push(`  - Review gate: ${task.lastReview.pass ? "PASS" : `FAIL ${task.lastReview.failedLanes.join(", ")}`} (${task.lastReview.reportMdPath || "no report"})`);
  if (task.lastChangeRequest) lines.push(`  - ChangeRequest: ${task.lastChangeRequest.id} (${task.lastChangeRequest.reportMdPath || "no report"})`);
  if (task.lastFailure) {
    lines.push(`  - Failure: ${task.lastFailure.reason} (${task.lastFailure.reportMdPath || "no report"})`);
    lines.push(`  - Retry hint: ${(task.lastFailure.retryHint || "").replace(/\n/g, " / ")}`);
  }
}

/** 格式化附件字符数与预算截断状态，供 Markdown 报告展示。 */
function renderAttachmentSize(item) {
  const loaded = item.loadedChars ?? String(item.content || "").length;
  const budget = item.budgetChars ?? "unknown";
  const suffix = item.truncated ? ", truncated" : "";
  return `${loaded}/${item.chars} chars, budget ${budget}${suffix}`;
}

/** 按 contextBudgets 截断 Agent 身份 Prompt，超长时追加截断说明标记。 */
function prepareAgentPrompt(value, maxChars, agent) {
  const original = String(value || "");
  const budgetChars = normalizePromptBudget(maxChars);
  if (original.length <= budgetChars) {
    return {
      source: "prompt-pack",
      agent,
      chars: original.length,
      loadedChars: original.length,
      budgetChars,
      truncated: false,
      content: original,
    };
  }
  const marker = `\n\n[Agent Prompt 已截断：${agent} 原始 ${original.length} 字符，本次身份注入预算 ${budgetChars} 字符。完整 Prompt 仍保存在已安装且经过 hash 校验的 Prompt Pack 中。]`;
  const sliceLength = Math.max(0, budgetChars - marker.length);
  const content = `${original.slice(0, sliceLength)}${marker}`;
  return {
    source: "prompt-pack",
    agent,
    chars: original.length,
    loadedChars: content.length,
    budgetChars,
    truncated: true,
    content,
  };
}

/** 解析 Prompt 字符预算，非法值回退 12000 并 clamp 到 [500, 500000]。 */
function normalizePromptBudget(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 12_000;
  return Math.max(500, Math.min(Math.floor(parsed), 500_000));
}

/** 读取 sessions/lineage.json，不存在时返回空 lineage 默认结构。 */
async function readSessionLineage(rootDir) {
  return readJson(resolveWildArrangePath(rootDir, "sessions", "lineage.json"), {
    version: STATE_VERSION,
    currentSessionId: null,
    sessionIds: [],
    sessions: [],
  });
}

/** 将续跑 directive 渲染为 Markdown，供 sessions/continuation.md 写入。 */
function renderContinuationMarkdown(directive) {
  return [
    "# WildArrange Continuation Directive",
    "",
    `Generated: ${directive.at}`,
    `Should continue: ${directive.shouldContinue ? "yes" : "no"}`,
    `Reason: ${directive.reason}`,
    `Task: ${directive.taskId || "(none)"}`,
    `Next command: ${directive.nextCommand || "(none)"}`,
    "",
    directive.message,
    "",
    `Resume context: ${directive.resume.contextPath}`,
    "",
  ].join("\n");
}

