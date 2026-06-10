import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  STATE_VERSION,
  appendLedger,
  createWorkId,
  ensureHelixDirs,
  loadHelixConfig,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "./helix-foundation.mjs";
import { collectGitChangedPaths, listChangeRequests } from "./helix-gates.mjs";
import { defaultInjectionPointForAgent, resolveInjectionPoint } from "./helix-injection.mjs";
import { loadTaskState } from "./helix-plan.mjs";
import { scanProjectRules } from "./helix-rules.mjs";
import { findRunnableTask, normalizeAgentName } from "./helix-team.mjs";
import { readLedgerTail, statusReport } from "./helix-status.mjs";

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
  const resumeContext = await writeContextSnapshot(rootDir, { reason: `agent-context:${options.agent || "Atlas"}` });
  const agent = normalizeAgentName(options.agent || task?.owner || "Atlas") || "Atlas";
  const role = options.role || roleForAgent(agent);
  const injectionPointName = options.injectionPoint || defaultInjectionPointForAgent(agent);
  const injectionPoint = await resolveInjectionPoint(rootDir, injectionPointName, {
    agent,
    taskId: task?.id || "",
    planId: taskState?.planId || "",
  });
  const modelConfig = config.agents?.[agent] || config.dynamicAgents?.[agent] || null;
  const context = {
    kind: "helix_agent_context",
    version: STATE_VERSION,
    at: nowIso(),
    configPath: sourcePath,
    agent,
    role,
    model: modelConfig,
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
  await appendLedger(rootDir, { type: "agent_context_built", agent, role, taskId: task?.id || null, rulesMatched: rules.matched, contextPath: context.reportMdPath });
  return context;
}

export async function writeContextSnapshot(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const latestSnapshot = options.latestSnapshot || await readJson(resolveHelixPath(rootDir, "snapshots", "latest.json"), null);
  const report = await statusReport(rootDir);
  const taskState = await loadTaskState(rootDir);
  const changes = await listChangeRequests(rootDir);
  const ledger = await readLedgerTail(rootDir, 12);
  const nextTask = taskState ? findRunnableTask(taskState.tasks) : null;
  const failedTasks = (taskState?.tasks || []).filter((task) => task.status === "failed");
  const verifyingTasks = (taskState?.tasks || []).filter((task) => task.status === "verifying" || task.status === "in_progress");
  const lineage = await readSessionLineage(rootDir);
  const context = {
    kind: "helix_context_snapshot",
    version: STATE_VERSION,
    at: nowIso(),
    reason: options.reason || "manual",
    latestSnapshot: latestSnapshot ? { id: latestSnapshot.id, stage: latestSnapshot.stage, at: latestSnapshot.at } : null,
    status: report,
    nextAction: nextTask ? `run task ${nextTask.id}: ${nextTask.subject}` : report.failed > 0 ? "inspect failed task" : "no runnable task",
    nextTask: nextTask ? summarizeTaskForContext(nextTask) : null,
    activeTasks: verifyingTasks.map(summarizeTaskForContext),
    failedTasks: failedTasks.map(summarizeTaskForContext),
    openChanges: changes.filter((change) => change.status === "open").map(summarizeChangeForContext),
    sessions: lineage,
    ledgerTail: ledger,
  };
  const jsonPath = resolveHelixPath(rootDir, "snapshots", "context.json");
  const mdPath = resolveHelixPath(rootDir, "snapshots", "context.md");
  context.reportJsonPath = path.relative(rootDir, jsonPath);
  context.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, context);
  await writeFile(mdPath, renderContextMarkdown(context), "utf8");
  return context;
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
      ? `HelixFlow 还有未收口工作：${runnable?.id || active?.id || failed?.id}。请继续执行 ${runnable ? "run" : active ? "node loop" : "failure review"}，不要丢失上下文。`
      : "HelixFlow 当前没有可续跑任务。",
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

function resolveContextTask(tasks, taskId) {
  if (taskId) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    return task;
  }
  return findRunnableTask(tasks) || tasks.find((task) => task.status === "in_progress" || task.status === "verifying" || task.status === "failed") || null;
}

function roleForAgent(agent) {
  if (agent === "Oracle") return "goal_verifier";
  if (agent === "Momus") return "skeptical_scope_reviewer";
  if (agent === "Metis") return "bug_and_evidence_reviewer";
  if (agent === "Sisyphus") return "lead_orchestrator";
  return "linear_worker";
}

function renderAgentContextMarkdown(context) {
  const lines = [
    "# HelixFlow Agent Context",
    "",
    `Generated: ${context.at}`,
    `Config: ${context.configPath}`,
    `Agent: ${context.agent}`,
    `Role: ${context.role}`,
    `Model: ${context.model ? `${context.model.provider || "unknown"}/${context.model.model || "unknown"}` : "(unconfigured)"}`,
    `Injection point: ${context.injectionPoint.name} (${context.injectionPoint.enabled ? "enabled" : "disabled"})`,
    `Resume context: ${context.resumeContextPath}`,
    `Rules context: ${context.rulesContextPath}`,
    "",
    "## Task",
    "",
  ];
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
    for (const item of context.injectionPoint.markdown) lines.push(`- Markdown: ${item.path} (${item.chars} chars)`);
  }
  if (context.injectionPoint.skills.length === 0) {
    lines.push("- Skills: none");
  } else {
    for (const item of context.injectionPoint.skills) lines.push(`- Skill: ${item.name} -> ${item.path} (${item.chars} chars)`);
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

function summarizeChangeForContext(change) {
  return {
    id: change.id,
    status: change.status,
    taskId: change.taskId,
    subject: change.subject,
    deniedPaths: change.deniedPaths || [],
    reportMdPath: change.reportMdPath,
  };
}

function renderContextMarkdown(context) {
  const status = context.status || {};
  const lines = [
    "# HelixFlow Resume Context",
    "",
    `Generated: ${context.at}`,
    `Reason: ${context.reason}`,
    `Latest snapshot: ${context.latestSnapshot ? `${context.latestSnapshot.stage} @ ${context.latestSnapshot.at}` : "none"}`,
    "",
    "## Status",
    "",
    `- Work: ${status.work?.workId || "(none)"}`,
    `- Plan: ${status.planId || "(none)"}`,
    `- Counts: total=${status.total || 0}, completed=${status.completed || 0}, pending=${status.pending || 0}, verifying=${status.verifying || 0}, failed=${status.failed || 0}, openChanges=${status.openChanges || 0}`,
    `- Next action: ${context.nextAction}`,
    "",
    "## Session Lineage",
    "",
  ];
  if (!context.sessions?.sessionIds?.length) {
    lines.push("- No recorded sessions yet.");
  } else {
    lines.push(`- Current: ${context.sessions.currentSessionId || "(unknown)"}`);
    lines.push(`- All: ${context.sessions.sessionIds.join(", ")}`);
  }
  lines.push("", "## Next Task", "");
  if (context.nextTask) {
    appendTaskContext(lines, context.nextTask);
  } else {
    lines.push("- None.");
  }
  lines.push("", "## Active Tasks", "");
  if (context.activeTasks.length === 0) {
    lines.push("- None.");
  } else {
    for (const task of context.activeTasks) appendTaskContext(lines, task);
  }
  lines.push("", "## Failed Tasks", "");
  if (context.failedTasks.length === 0) {
    lines.push("- None.");
  } else {
    for (const task of context.failedTasks) appendTaskContext(lines, task);
  }
  lines.push("", "## Open ChangeRequests", "");
  if (context.openChanges.length === 0) {
    lines.push("- None.");
  } else {
    for (const change of context.openChanges) {
      lines.push(`- ${change.id} (${change.status}) task=${change.taskId}`);
      lines.push(`  - Subject: ${change.subject}`);
      lines.push(`  - Denied: ${change.deniedPaths.join(", ") || "(none)"}`);
      lines.push(`  - Report: ${change.reportMdPath || "(none)"}`);
    }
  }
  lines.push("", "## Resume Commands", "");
  lines.push("- Inspect: `node ./bin/helix.mjs status`");
  lines.push("- Refresh context: `node ./bin/helix.mjs resume`");
  lines.push("- Run next task: `node ./bin/helix.mjs run`");
  lines.push("- Node loop: `node ./bin/helix.mjs node execute|verify|scope|review|checkpoint|retry --task <taskId>`");
  lines.push("- Open changes: `node ./bin/helix.mjs changes list`");
  lines.push("", "## Invariants", "");
  lines.push("- Worker done-claim is not completion.");
  lines.push("- Checkpoint requires verifier PASS, scope guard non-fail, and review gate PASS.");
  lines.push("- Scope drift requires ChangeRequest review before retry.");
  lines.push("- Do not weaken `verify_commands` or `review_commands` to manufacture PASS.");
  lines.push("", "## Ledger Tail", "");
  if (context.ledgerTail.length === 0) {
    lines.push("- None.");
  } else {
    for (const entry of context.ledgerTail) {
      lines.push(`- ${entry.at || ""} ${entry.type || entry.kind || "event"} ${entry.taskId ? `task=${entry.taskId}` : ""} ${entry.stage ? `stage=${entry.stage}` : ""}`.trim());
    }
  }
  return `${lines.join("\n")}\n`;
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
    "# HelixFlow Continuation Directive",
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
