import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_EXECUTOR_AGENT,
  DEFAULT_LEAD_AGENT,
} from "../infra/agent-registry.mjs";
import {
  STATE_VERSION,
  createWorkId,
  ensureHelixDirs,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { loadHelixConfig } from "../infra/runtime-config.mjs";
import { collectGitChangedPaths } from "../infra/git-diff.mjs";
import { renderPromptPackEntry } from "../infra/prompt-pack.mjs";
import { writeRuntimeContextSnapshot } from "../infra/runtime-snapshot.mjs";
import { defaultInjectionPointForAgent, resolveInjectionPoint } from "./injection.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";
import { scanProjectRules } from "../infra/rule-scanner.mjs";
import { findRunnableTask, normalizeAgentName } from "../orchestration/task-board.mjs";
import { statusReport } from "../orchestration/status.mjs";

export async function buildAgentContext(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const { config, sourcePath } = await loadHelixConfig(rootDir);
  const taskState = await loadTaskState(rootDir);
  const task = resolveContextTask(taskState?.tasks || [], options.taskId);
  const changed = await collectGitChangedPaths(rootDir);
  const targetPaths = uniqueStrings([
    ...(task?.writable_paths || []),
    ...(changed.available ? changed.paths : []),
  ].map(normalizeRelativePath));
  const rules = await scanProjectRules(rootDir, { targetPaths });
  const agent = normalizeAgentName(options.agent || task?.owner || DEFAULT_EXECUTOR_AGENT) || DEFAULT_EXECUTOR_AGENT;
  const resumeContext = await writeContextSnapshot(rootDir, { reason: `agent-context:${agent}` });
  const role = options.role || roleForAgent(agent);
  const injectionPointName = options.injectionPoint || defaultInjectionPointForAgent(agent, { taskId: task?.id });
  const injectionPoint = await resolveInjectionPoint(rootDir, injectionPointName, {
    agent,
    taskId: task?.id || "",
    planId: taskState?.planId || "",
  }, {
    text: task ? `${task.subject}\n${task.description || ""}` : "",
    stage: stageForInjectionPoint(injectionPointName),
  });
  const modelConfig = config.agents?.[agent] || config.dynamicAgents?.[agent] || null;
  const agentPromptContent = await renderPromptPackEntry(rootDir, { agent });
  const agentPrompt = prepareAgentPrompt(
    agentPromptContent,
    config.contextBudgets?.prompt?.maxChars,
    agent,
  );
  const context = {
    kind: "helix_agent_context",
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
  const jsonPath = resolveHelixPath(rootDir, "context-agents", `${suffix}.json`);
  const mdPath = resolveHelixPath(rootDir, "context-agents", `${suffix}.md`);
  context.reportJsonPath = path.relative(rootDir, jsonPath);
  context.reportMdPath = path.relative(rootDir, mdPath);
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

export async function writeContextSnapshot(rootDir, options = {}) {
  return writeRuntimeContextSnapshot(rootDir, options);
}

export async function recordRuntimeSession(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const sessionId = options.sessionId || process.env.HELIX_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.CURSOR_SESSION_ID || createWorkId("session");
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
  await writeJsonAtomic(resolveHelixPath(rootDir, "sessions", "lineage.json"), lineage);
  await appendLedger(rootDir, { type: "session_recorded", sessionId, source });
  return lineage;
}

export async function resumeReport(rootDir, options = {}) {
  const lineage = await recordRuntimeSession(rootDir, {
    sessionId: options.sessionId,
    source: options.source || "resume",
  });
  const latestSnapshot = await readJson(resolveHelixPath(rootDir, "snapshots", "latest.json"), null);
  const report = await statusReport(rootDir);
  const taskState = await loadTaskState(rootDir);
  const nextTask = taskState ? findRunnableTask(taskState.tasks) : null;
  const context = await writeContextSnapshot(rootDir, { reason: "resume", latestSnapshot });
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
    nextAction: nextTask ? `run task ${nextTask.id}: ${nextTask.subject}` : report.failed > 0 ? "inspect failed task" : "no runnable task",
  };
  await appendLedger(rootDir, { type: "resume_reported", nextAction: resume.nextAction, sessionId: lineage.currentSessionId, contextPath: resume.contextPath });
  return resume;
}

export async function continuationDirective(rootDir, options = {}) {
  const resume = await resumeReport(rootDir, {
    sessionId: options.sessionId,
    source: options.source || "continuation",
  });
  const taskState = await loadTaskState(rootDir);
  const runnable = taskState ? findRunnableTask(taskState.tasks) : null;
  const active = (taskState?.tasks || []).find((task) => task.status === "in_progress" || task.status === "verifying");
  const failed = (taskState?.tasks || []).find((task) => task.status === "failed" || task.status === "review_blocked" || task.status === "needs_user_decision");
  const shouldContinue = Boolean(runnable || active || failed);
  const directive = {
    kind: "helix_continuation_directive",
    version: STATE_VERSION,
    at: nowIso(),
    shouldContinue,
    reason: runnable ? "runnable_task" : active ? "active_task" : failed ? "blocked_or_failed_task" : "no_unfinished_work",
    taskId: runnable?.id || active?.id || failed?.id || null,
    nextCommand: runnable ? "node ./bin/helix.mjs run" : active ? `node ./bin/helix.mjs node verify --task ${active.id}` : failed ? "node ./bin/helix.mjs status" : null,
    message: shouldContinue
      ? `WildArrange 还有未收口工作：${runnable?.id || active?.id || failed?.id}。请继续执行 ${runnable ? "run" : active ? "node loop" : "failure review"}，不要丢失上下文。`
      : "WildArrange 当前没有可续跑任务。",
    resume,
  };
  const jsonPath = resolveHelixPath(rootDir, "sessions", "continuation.json");
  const mdPath = resolveHelixPath(rootDir, "sessions", "continuation.md");
  directive.reportJsonPath = path.relative(rootDir, jsonPath);
  directive.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, directive);
  await writeFile(mdPath, renderContinuationMarkdown(directive), "utf8");
  await appendLedger(rootDir, { type: "continuation_checked", shouldContinue, reason: directive.reason, taskId: directive.taskId });
  return directive;
}

function stageForInjectionPoint(pointName) {
  if (pointName === "before_execute") return "execute";
  if (pointName === "before_review") return "review";
  if (pointName === "repository_governance") return "review";
  if (pointName === "before_checkpoint") return "verify";
  if (pointName === "user_prompt_submit") return "plan";
  return "";
}

function resolveContextTask(tasks, taskId) {
  if (taskId) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    return task;
  }
  return findRunnableTask(tasks) || tasks.find((task) => task.status === "in_progress" || task.status === "verifying" || task.status === "failed") || null;
}

function roleForAgent(agent) {
  if (agent === "BaiZe") return "independent_reviewer";
  if (agent === "DiJiang") return "planner";
  if (agent === "ZhuRong") return "implementation_worker";
  if (agent === "LuWu") return "repository_steward";
  if (agent === DEFAULT_LEAD_AGENT) return "lead_orchestrator";
  return "linear_worker";
}

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

function summarizeTaskForContext(task) {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    category: task.category,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    writable_paths: task.writable_paths || [],
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

function appendTaskContext(lines, task) {
  lines.push(`- ${task.id}: ${task.subject}`);
  lines.push(`  - Status: ${task.status}; category=${task.category || "unresolved"}; attempts=${task.attempts}/${task.maxAttempts}`);
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

function renderAttachmentSize(item) {
  const loaded = item.loadedChars ?? String(item.content || "").length;
  const budget = item.budgetChars ?? "unknown";
  const suffix = item.truncated ? ", truncated" : "";
  return `${loaded}/${item.chars} chars, budget ${budget}${suffix}`;
}

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

function normalizePromptBudget(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 12_000;
  return Math.max(500, Math.min(Math.floor(parsed), 500_000));
}

async function readSessionLineage(rootDir) {
  return readJson(resolveHelixPath(rootDir, "sessions", "lineage.json"), {
    version: STATE_VERSION,
    currentSessionId: null,
    sessionIds: [],
    sessions: [],
  });
}

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

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function normalizeRelativePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}
