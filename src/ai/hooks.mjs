import { realpathSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_EXECUTOR_AGENT,
  DEFAULT_LEAD_AGENT,
} from "../infra/agent-registry.mjs";
import {
  PRODUCT_NAME,
  loadHelixConfig,
} from "../infra/runtime-config.mjs";
import {
  STATE_VERSION,
  createWorkId,
  nowIso,
  resolveHelixPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { emitDecision } from "../infra/decision-log.mjs";
import { initRuntime } from "../infra/runtime-bootstrap.mjs";
import { pathAllowed } from "../infra/path-match.mjs";
import { invokeCapability } from "../capabilities/gateway.mjs";
import { resolveInjectionPoint } from "./injection.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";
import { routeRequest, writeDailyRoutingReview } from "./routing.mjs";
import { scanProjectRules } from "../infra/rule-scanner.mjs";
import { findRunnableTask } from "../orchestration/task-board.mjs";
import { buildAgentContext, continuationDirective, resumeReport } from "./context.mjs";
import { runArchivistRouter } from "./archivist-router.mjs";
import { evaluateHookResultGate } from "../infra/hook-result-gate.mjs";
import { compileCommandSafetyPatterns, evaluateCommandSafety } from "../infra/command-safety.mjs";
import { writeMemoryDigest } from "../infra/memory-digest.mjs";
import { attentionReport } from "../orchestration/status.mjs";

export async function runInjectionHook(rootDir, input = {}) {
  const hookRootDir = input.cwd && typeof input.cwd === "string" ? input.cwd : rootDir;
  await initRuntime(hookRootDir);
  const event = normalizeHookEvent(input.hook_event_name || input.event || input.name);
  const pointName = injectionPointForHookEvent(event);
  const sessionId = normalizeHookSessionId(input);
  const taskId = normalizeHookTaskId(input);
  const targetPaths = event === "PostToolUse" || event === "PreToolUse" ? extractHookTargetPaths(input, hookRootDir) : [];
  const facts = {};

  if (event === "SessionStart") {
    facts.resume = await resumeReport(hookRootDir, { sessionId, source: "hook:session_start" });
    facts.rules = await scanProjectRules(hookRootDir);
    facts.agentContext = await buildAgentContext(hookRootDir, {
      agent: DEFAULT_LEAD_AGENT,
      taskId,
      injectionPoint: pointName,
    }).catch((error) => ({ error: error.message }));
    facts.archivist = await runArchivistForHook(hookRootDir, input, {
      event,
      stage: "resume",
      trigger: "sessionStart",
      text: facts.resume?.nextAction || "",
    });
    facts.digest = await writeMemoryDigest(hookRootDir, {
      reason: "session_start",
      stage: "resume",
      route: facts.route,
    }).catch((error) => ({ error: error.message }));
  } else if (event === "UserPromptSubmit") {
    facts.route = input.prompt ? await routeRequest(hookRootDir, { text: input.prompt, sessionId }) : null;
    facts.rules = await scanProjectRules(hookRootDir);
    facts.archivist = await runArchivistForHook(hookRootDir, input, {
      event,
      stage: stageForRoute(facts.route),
      trigger: "userPromptSubmit",
      text: input.prompt || "",
    });
  } else if (event === "PreToolUse") {
    facts.targetPaths = targetPaths;
    facts.rules = await scanProjectRules(hookRootDir, { targetPaths });
    facts.preflight = await preToolUseGuard(hookRootDir, input);
    const executionTaskId = facts.preflight?.taskId || taskId;
    if (executionTaskId) {
      facts.agentContext = await buildAgentContext(hookRootDir, {
        agent: DEFAULT_EXECUTOR_AGENT,
        taskId: executionTaskId,
        planId: await currentPlanId(hookRootDir),
        injectionPoint: "before_execute",
      }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    }
  } else if (event === "PostToolUse") {
    facts.targetPaths = targetPaths;
    facts.rules = await scanProjectRules(hookRootDir, { targetPaths });
    facts.resultGate = await evaluateHookResultGate(hookRootDir, input);
    if (taskId) {
      facts.scope = await invokeCapability("scope", { rootDir: hookRootDir, task: { id: taskId } })
        .then((envelope) => envelope.evidence)
        .catch((error) => ({ status: "inconclusive", reason: error.message }));
    }
  } else if (event === "PostCompact") {
    facts.resume = await resumeReport(hookRootDir, { sessionId, source: "hook:post_compact" });
    facts.rules = await scanProjectRules(hookRootDir);
    facts.agentContext = await buildAgentContext(hookRootDir, {
      agent: DEFAULT_LEAD_AGENT,
      taskId,
      injectionPoint: pointName,
    }).catch((error) => ({ error: error.message }));
    facts.archivist = await runArchivistForHook(hookRootDir, input, {
      event,
      stage: "resume",
      trigger: "postCompact",
      text: facts.resume?.nextAction || "",
    });
    facts.digest = await writeMemoryDigest(hookRootDir, {
      reason: "post_compact",
      stage: "resume",
    }).catch((error) => ({ error: error.message }));
  } else if (event === "Stop") {
    facts.continuation = await continuationDirective(hookRootDir, { sessionId, source: "hook:stop" });
    facts.routingReview = await writeDailyRoutingReview(hookRootDir, {
      trigger: "hook:stop",
      sessionId,
    }).catch((error) => ({ status: "warn", reason: error instanceof Error ? error.message : String(error) }));
  }

  // 通用推送：在有"对话面"的事件里，把待人决策的事项主动注入，指示宿主 AI 直接问开发者。
  if (["SessionStart", "UserPromptSubmit", "PostCompact", "Stop"].includes(event)) {
    facts.attention = await attentionReport(hookRootDir).catch(() => null);
  }

  const effectiveTaskId = taskId || facts.preflight?.taskId || "";
  const variables = {
    agent: input.agent || defaultAgentForHookEvent(event),
    taskId: effectiveTaskId,
    planId: await currentPlanId(hookRootDir),
  };
  const injectionPoint = await resolveInjectionPoint(hookRootDir, pointName, variables, {
    text: injectionTextForHookEvent(event, input, facts),
    stage: injectionStageForHookEvent(event, facts),
  });
  const contextMarkdown = injectionPoint.enabled ? renderHookInjectionMarkdown({ event, pointName, sessionId, taskId: effectiveTaskId, targetPaths, facts, injectionPoint }) : "";
  const shouldRenderPreToolOutput = event === "PreToolUse"
    && (injectionPoint.enabled || facts.preflight?.decision === "deny");
  const output = shouldRenderPreToolOutput
    ? renderPreToolUseHookOutput(facts.preflight, contextMarkdown)
    : contextMarkdown;
  const result = {
    kind: "helix_hook_injection",
    version: STATE_VERSION,
    at: nowIso(),
    event,
    pointName,
    sessionId,
    taskId: effectiveTaskId || null,
    targetPaths,
    enabled: injectionPoint.enabled,
    decision: facts.preflight?.decision || facts.resultGate?.decision || null,
    continuation: facts.continuation ? {
      required: facts.continuation.shouldContinue === true,
      reason: facts.continuation.reason || "",
      nextCommand: facts.continuation.nextCommand || null,
    } : null,
    output,
  };
  const safeSessionId = sanitizeFileSegment(sessionId || "session");
  const safeEvent = sanitizeFileSegment(event);
  const outputPath = resolveHelixPath(hookRootDir, "sessions", "hooks", `${safeSessionId}-${safeEvent}.json`);
  result.reportJsonPath = path.relative(hookRootDir, outputPath);
  await writeJsonAtomic(outputPath, result);
  await appendLedger(hookRootDir, {
    type: "hook_injection_run",
    event,
    pointName,
    sessionId,
    taskId: effectiveTaskId || null,
    decision: result.decision,
    outputChars: output.length,
  });
  // 决策投影：每次拦截/放行都进 decisions.jsonl，供 helix decisions 与
  // 异步审查 Agent 复盘。best-effort，不反噬 hook 主流程。
  if (result.decision) {
    try {
      await emitDecision(hookRootDir, {
        gate: pointName,
        decision: result.decision,
        code: hookDecisionCode(facts.preflight, facts.resultGate),
        reason: facts.preflight?.reason || facts.resultGate?.summary || null,
        summary: `${input.tool_name || event}${targetPaths.length > 0 ? ` ${targetPaths.join(", ")}` : ""} -> ${result.decision}`,
        evidencePath: result.reportJsonPath,
        taskId: effectiveTaskId || null,
        sessionId,
        toolName: input.tool_name || input.toolName || null,
        targetPaths,
        toolInputSummary: summarizeHookToolInput(input.tool_input || input.toolInput),
        // 拦截与非通过的结果门进标注队列；确定性 allow/pass 只进流水。
        annotatable: result.decision !== "allow" && result.decision !== "pass",
      });
    } catch {
      // 决策日志是派生物，任何故障都不反噬 hook 主流程。
    }
  }
  return result;
}

function summarizeHookToolInput(value) {
  if (!value || typeof value !== "object") return null;
  const redact = (item, key = "") => {
    if (/(token|secret|password|api[_-]?key|authorization|cookie)/i.test(key)) return "[REDACTED]";
    if (typeof item === "string") {
      return item
        .replace(/(bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
        .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]")
        .slice(0, 500);
    }
    if (Array.isArray(item)) return item.slice(0, 20).map((entry) => redact(entry));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).slice(0, 30).map(([childKey, child]) => [childKey, redact(child, childKey)]));
    }
    return item;
  };
  return redact(value);
}

// code 是结构化字段，由 preToolUseGuard 的返回直接携带；绝不能从
// reason 散文反推（改文案就会静默丢失投影的"命中规则"）。
function hookDecisionCode(preflight, resultGate) {
  if (preflight?.code) return preflight.code;
  if (resultGate && resultGate.decision !== "pass") return "tool_result_gate";
  return null;
}

export async function preToolUseGuard(rootDir, input = {}) {
  const event = normalizeHookEvent(input.hook_event_name || input.event || input.name);
  if (event !== "PreToolUse") throw new Error("preToolUseGuard requires PreToolUse input");
  const toolName = String(input.tool_name || input.toolName || "");
  const targetPaths = extractHookTargetPaths(input, rootDir);
  const toolInput = input.tool_input || input.toolInput;

  if (/^(Bash|bash|exec_command|functions\.exec_command)$/.test(toolName)) {
    const command = toolInput && typeof toolInput === "object" ? toolInput.command || toolInput.cmd : "";
    const { config } = await loadHelixConfig(rootDir);
    const safety = evaluateCommandSafety(command, {
      extraPatterns: compileCommandSafetyPatterns(config),
    });
    if (!safety.allowed) {
      const reason = `high-risk shell command blocked: ${safety.findings.map((finding) => `${finding.id}: ${finding.reason}`).join("; ")}`;
      await appendLedger(rootDir, {
        type: "pre_tool_use_denied",
        reason: "high_risk_command",
        toolName,
        targetPaths,
        findings: safety.findings,
      });
      return {
        kind: "pre_tool_use_guard",
        at: nowIso(),
        decision: "deny",
        code: "high_risk_command",
        reason,
        toolName,
        taskId: normalizeHookTaskId(input) || null,
        targetPaths,
        deniedPaths: targetPaths,
      };
    }
  }

  if (toolName === "create_goal" && hasInvalidCreateGoalPayload(toolInput)) {
    return {
      kind: "pre_tool_use_guard",
      at: nowIso(),
      decision: "deny",
      code: "invalid_create_goal",
      reason: "Use create_goal with objective only. Put lifecycle status changes on update_goal.",
      toolName,
      taskId: null,
      targetPaths,
      deniedPaths: [],
    };
  }

  const taskState = await loadTaskState(rootDir);
  const taskId = normalizeHookTaskId(input);
  const task = taskState
    ? taskId
      ? taskState.tasks.find((candidate) => candidate.id === taskId)
      : taskState.tasks.find((candidate) => ["in_progress", "verifying"].includes(candidate.status)) || findRunnableTask(taskState.tasks)
    : null;

  if (targetPaths.length === 0) {
    return {
      kind: "pre_tool_use_guard",
      at: nowIso(),
      decision: "allow",
      code: "no_file_target",
      reason: "no project file target detected",
      toolName,
      taskId: task?.id || taskId || null,
      targetPaths,
      deniedPaths: [],
    };
  }
  if (!task) {
    await appendLedger(rootDir, {
      type: "pre_tool_use_denied",
      reason: "no_active_task",
      toolName,
      targetPaths,
      deniedPaths: targetPaths,
    });
    return {
      kind: "pre_tool_use_guard",
      at: nowIso(),
      decision: "deny",
      code: "no_active_task",
      reason: `file target detected but no active ${PRODUCT_NAME} task was found; create/import a plan task before editing files`,
      toolName,
      taskId: taskId || null,
      targetPaths,
      deniedPaths: targetPaths,
    };
  }

  const writablePaths = (task.writable_paths || []).map(normalizeRelativePath);
  const deniedPaths = targetPaths.filter((filePath) => !pathAllowed(filePath, writablePaths));
  const decision = deniedPaths.length > 0 ? "deny" : "allow";
  const reason = deniedPaths.length > 0
    ? `planned scope violation for task ${task.id}: ${deniedPaths.join(", ")}`
    : `targets are inside writable_paths for task ${task.id}`;
  await appendLedger(rootDir, {
    type: decision === "deny" ? "pre_tool_use_denied" : "pre_tool_use_allowed",
    planId: taskState.planId,
    taskId: task.id,
    toolName,
    targetPaths,
    deniedPaths,
  });
  return {
    kind: "pre_tool_use_guard",
    at: nowIso(),
    decision,
    code: deniedPaths.length > 0 ? "out_of_scope" : "in_scope",
    reason,
    toolName,
    taskId: task.id,
    targetPaths,
    writablePaths,
    deniedPaths,
  };
}

function hasInvalidCreateGoalPayload(value) {
  return isPlainObject(value) && Object.keys(value).some((key) => key !== "objective");
}

function renderPreToolUseHookOutput(preflight, contextMarkdown) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: contextMarkdown,
    },
  };
  if (preflight?.decision === "deny") {
    output.hookSpecificOutput.permissionDecision = "deny";
    output.hookSpecificOutput.permissionDecisionReason = preflight.reason || `${PRODUCT_NAME} pre-tool-use guard denied this tool call.`;
  }
  return `${JSON.stringify(output)}\n`;
}

function normalizeHookEvent(value) {
  const raw = String(value || "").trim();
  const aliases = {
    session_start: "SessionStart",
    SessionStart: "SessionStart",
    user_prompt_submit: "UserPromptSubmit",
    UserPromptSubmit: "UserPromptSubmit",
    pre_tool_use: "PreToolUse",
    PreToolUse: "PreToolUse",
    post_tool_use: "PostToolUse",
    PostToolUse: "PostToolUse",
    post_tool_use_failure: "PostToolUse",
    PostToolUseFailure: "PostToolUse",
    post_compact: "PostCompact",
    PostCompact: "PostCompact",
    stop: "Stop",
    Stop: "Stop",
    subagent_stop: "Stop",
    SubagentStop: "Stop",
  };
  const event = aliases[raw];
  if (!event) throw new Error(`unsupported hook event: ${raw || "(empty)"}`);
  return event;
}

function injectionPointForHookEvent(event) {
  if (event === "SessionStart") return "session_start";
  if (event === "UserPromptSubmit") return "user_prompt_submit";
  if (event === "PreToolUse") return "pre_tool_use";
  if (event === "PostToolUse") return "post_tool_use";
  if (event === "PostCompact") return "post_compact";
  if (event === "Stop") return "stop";
  throw new Error(`unsupported hook event: ${event}`);
}

function defaultAgentForHookEvent(event) {
  if (event === "SessionStart" || event === "UserPromptSubmit" || event === "Stop" || event === "PostCompact") return DEFAULT_LEAD_AGENT;
  return DEFAULT_EXECUTOR_AGENT;
}

async function runArchivistForHook(rootDir, input, options) {
  try {
    return await runArchivistRouter(rootDir, {
      stage: options.stage,
      trigger: options.trigger || options.event,
      text: options.text || "",
      turns: extractHookTurns(input),
    });
  } catch (error) {
    return {
      kind: "archivist_router",
      at: nowIso(),
      status: "warn",
      pass: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function injectionTextForHookEvent(event, input, facts) {
  if (event === "UserPromptSubmit") return String(input.prompt || "");
  if (event === "SessionStart" || event === "PostCompact") return String(facts.resume?.nextAction || "");
  // PreToolUse / PostToolUse / Stop 没有可靠的请求文本，保持静态挂载
  return "";
}

function injectionStageForHookEvent(event, facts) {
  if (event === "UserPromptSubmit") return stageForRoute(facts.route);
  if (event === "SessionStart" || event === "PostCompact") return "recall";
  return "";
}

function stageForRoute(route) {
  const intent = route?.intent;
  if (intent === "plan") return "plan";
  if (intent === "ask") return "clarify";
  if (intent === "review") return "review";
  if (intent === "resume") return "resume";
  if (intent === "execute") return "execute";
  return "default";
}

function extractHookTurns(input) {
  const source = input.turns || input.messages || input.conversation || [];
  if (!Array.isArray(source)) return [];
  return source.map((turn) => {
    if (typeof turn === "string") return { role: "unknown", content: turn };
    if (!turn || typeof turn !== "object") return null;
    return {
      role: turn.role || turn.speaker || "unknown",
      content: turn.content || turn.text || turn.summary || "",
    };
  }).filter((turn) => turn && turn.content);
}

function normalizeHookSessionId(input) {
  return String(input.session_id || input.sessionId || process.env.HELIX_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.CURSOR_SESSION_ID || createWorkId("session"));
}

function normalizeHookTaskId(input) {
  const direct = input.taskId || input.task_id || process.env.HELIX_TASK_ID;
  if (direct && typeof direct === "string") return direct;
  const toolInput = input.tool_input || input.toolInput;
  if (toolInput && typeof toolInput === "object") {
    const nested = toolInput.taskId || toolInput.task_id;
    if (nested && typeof nested === "string") return nested;
  }
  return "";
}

async function currentPlanId(rootDir) {
  const taskState = await loadTaskState(rootDir);
  return taskState?.planId || "";
}

function extractHookTargetPaths(input, rootDir) {
  const values = [];
  collectPathLikeValues(input.tool_input || input.toolInput, values);
  collectPathLikeValues(input.tool_response || input.toolResponse, values);
  collectPathLikeValues(input.paths || input.targetPaths, values, true);
  return uniqueStrings(values.map((value) => normalizeHookTargetPath(value, rootDir)).filter(Boolean));
}

function collectPathLikeValues(value, output, explicitPath = false) {
  if (typeof value === "string") {
    if (explicitPath && isCandidateFilePath(value)) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathLikeValues(item, output, explicitPath);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(path|paths|file|files|file_path|file_paths|filepath|target|targets|target_path|target_paths|relative_path)$/i.test(key)) {
      collectPathLikeValues(nested, output, true);
      continue;
    }
    if (nested && typeof nested === "object") collectPathLikeValues(nested, output);
  }
}

function isCandidateFilePath(value) {
  if (!value || value.includes("\n") || value.includes("\0")) return false;
  return !/^(https?:|data:|mailto:)/i.test(value);
}

function normalizeHookTargetPath(value, rootDir) {
  const absoluteTarget = path.isAbsolute(value) ? value : path.resolve(rootDir, value);
  const relative = path.relative(
    canonicalizePotentialPath(rootDir),
    canonicalizePotentialPath(absoluteTarget),
  );
  return normalizeRelativePath(relative);
}

function canonicalizePotentialPath(value) {
  let current = path.resolve(value);
  const missingSegments = [];
  while (true) {
    try {
      return path.join(realpathSync(current), ...missingSegments);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

function sanitizeFileSegment(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "unknown";
}

function renderHookInjectionMarkdown({ event, pointName, sessionId, taskId, targetPaths, facts, injectionPoint }) {
  const lines = [
    `<wildarrange-injection event="${event}" point="${pointName}">`,
    "",
    "# WildArrange 运行时注入",
    "",
    `- 事件：${event}`,
    `- 注入点：${pointName}`,
    `- 会话：${sessionId}`,
    `- 任务：${taskId || "(none)"}`,
    `- 配置：${injectionPoint.configPath}`,
    "",
    "## 必须行为",
    "",
    "- 把本块当作当前运行时上下文，不是可选文档。",
    "- Worker 声称完成不等于完成；完成必须通过 verifier、scope、review、checkpoint gate。",
    "- 不得削弱或删除项目规则、success criteria 来制造 PASS。",
    "- 如果注入证据不足，返回 INCONCLUSIVE 或请求必要 gate，不要猜测。",
    "",
    "## 工具",
    "",
    injectionPoint.tools.length > 0 ? `- ${injectionPoint.tools.join("\n- ")}` : "- (none)",
    "",
  ];

  if (targetPaths.length > 0) {
    lines.push("## 动态目标", "", ...targetPaths.map((targetPath) => `- ${targetPath}`), "");
  }
  appendHookFacts(lines, facts);
  appendInjectionAttachments(lines, injectionPoint);
  lines.push("</wildarrange-injection>", "");
  return lines.join("\n");
}

function appendHookFacts(lines, facts) {
  if (facts.route) {
    lines.push("## 路由决策", "");
    lines.push(`- 意图：${facts.route.intent}`);
    lines.push(`- 路由：${facts.route.route}`);
    lines.push(`- 主 Agent：${facts.route.primaryAgent}`);
    lines.push(`- 类别：${facts.route.category || "(none)"}`);
    lines.push(`- 风险：${facts.route.risk || "(unknown)"}`);
    if ((facts.route.planSkills || []).length > 0) {
      lines.push("- 计划 Skill 组合：");
      for (const skill of facts.route.planSkills) {
        lines.push(`  - ${skill.name} (${skill.stage}): ${skill.purpose}`);
      }
    }
    lines.push("");
  }
  if (facts.resume) {
    lines.push("## 恢复上下文", "");
    lines.push(`- 上下文：${facts.resume.contextPath}`);
    lines.push(`- 下一步：${facts.resume.nextAction}`);
    lines.push("");
  }
  if (facts.continuation) {
    lines.push("## 续跑指令", "");
    lines.push(`- 是否继续：${facts.continuation.shouldContinue ? "yes" : "no"}`);
    lines.push(`- 原因：${facts.continuation.reason}`);
    lines.push(`- 下一命令：${facts.continuation.nextCommand || "(none)"}`);
    lines.push(`- 报告：${facts.continuation.reportMdPath}`);
    lines.push("");
  }
  if (facts.routingReview) {
    lines.push("## 今日路由复盘", "");
    if (facts.routingReview.status === "warn" || facts.routingReview.status === "skipped") {
      lines.push(`- 状态：${facts.routingReview.status}`);
      lines.push(`- 原因：${facts.routingReview.reason || "(none)"}`);
    } else {
      lines.push(`- 今日判断：${facts.routingReview.summary.total} 次`);
      lines.push(`- 已复盘：${facts.routingReview.summary.reviewed} 次`);
      lines.push(`- 已发现问题：${facts.routingReview.summary.issues} 次`);
      lines.push(`- 待人工复盘：${facts.routingReview.summary.unreviewed} 次`);
      lines.push(`- 人类可读报告：${facts.routingReview.reportMdPath}`);
      if (facts.routingReview.summary.issues > 0) {
        lines.push("- 请主动提醒开发者查看问题判断，但不要自动修改路由规则。");
      }
    }
    lines.push("");
  }
  if (facts.digest) {
    lines.push("## 记忆摘要", "");
    if (facts.digest.error) {
      lines.push(`- 警告：${facts.digest.error}`);
    } else {
      lines.push(`- 报告：${facts.digest.reportMdPath || "(none)"}`);
      lines.push(`- 原因：${facts.digest.reason || "(unknown)"}`);
      appendShortList(lines, "进展", facts.digest.progress);
      appendShortList(lines, "决策", facts.digest.decisions);
      appendShortList(lines, "产物", facts.digest.artifacts);
      appendShortList(lines, "风险", facts.digest.pitfalls);
      appendShortList(lines, "开放问题", facts.digest.openQuestions);
    }
    lines.push("");
  }
  if (facts.archivist) {
    lines.push("## 档案路由", "");
    if (facts.archivist.status === "warn") {
      lines.push(`- 警告：${facts.archivist.reason || "(none)"}`);
    } else {
      const routeDecision = facts.archivist.decision?.routeDecision;
      lines.push(`- 状态：${facts.archivist.llmStatus || facts.archivist.status || "(unknown)"}`);
      lines.push(`- 摘要：${facts.archivist.decision?.summary || "(none)"}`);
      if (routeDecision) {
        lines.push(`- 建议路由：${routeDecision.route || "(none)"}`);
        lines.push(`- 置信度：${routeDecision.confidence ?? "(unknown)"}`);
      }
      const injection = facts.archivist.decision?.contextInjection || {};
      appendShortList(lines, "档案进展", injection.progress);
      appendShortList(lines, "档案风险", injection.pitfalls);
      appendShortList(lines, "档案开放问题", injection.openQuestions);
    }
    lines.push("");
  }
  if (facts.scope) {
    lines.push("## 范围门", "");
    lines.push(`- 状态：${facts.scope.status}`);
    lines.push(`- 原因：${facts.scope.reason || "(none)"}`);
    lines.push("");
  }
  if (facts.resultGate) {
    lines.push("## 工具结果门", "");
    lines.push(`- 决策：${facts.resultGate.decision}`);
    lines.push(`- 摘要：${facts.resultGate.summary}`);
    if (facts.resultGate.findings.length > 0) {
      for (const finding of facts.resultGate.findings) {
        lines.push(`- ${finding.severity}: ${finding.name} - ${finding.requiredAction}`);
      }
    }
    lines.push("");
  }
  if (facts.rules) {
    lines.push("## 项目规则", "");
    lines.push(`- 命中：${facts.rules.matched}/${facts.rules.total}`);
    lines.push(`- 报告：${facts.rules.reportMdPath}`);
    for (const rule of facts.rules.rules || []) {
      lines.push(`- ${rule.path}: ${rule.description}`);
      if (rule.content) {
        lines.push("");
        lines.push("```markdown");
        lines.push(rule.content);
        lines.push("```");
      }
    }
    lines.push("");
  }
  if (facts.agentContext) {
    lines.push("## Agent 上下文", "");
    if (facts.agentContext.error) {
      lines.push(`- 错误：${facts.agentContext.error}`);
    } else {
      lines.push(`- 报告：${facts.agentContext.reportMdPath}`);
      lines.push(`- Agent：${facts.agentContext.agent}`);
      lines.push(`- 角色：${facts.agentContext.role}`);
      const prompt = facts.agentContext.agentPrompt;
      if (prompt) {
        lines.push(`- 身份 Prompt：${prompt.loadedChars}/${prompt.chars} 字符；预算 ${prompt.budgetChars}${prompt.truncated ? "；已截断" : ""}`);
        lines.push("", `### ${facts.agentContext.agent} 身份 Prompt`, "", prompt.content);
      }
      const delivery = facts.agentContext.injectionPoint;
      if (delivery?.name === "before_execute") {
        lines.push("", "### 执行前任务 Skill（宿主必须按此工作流执行）", "");
        if ((delivery.skills || []).length === 0) {
          lines.push("- (none)");
        } else {
          for (const skill of delivery.skills) {
            lines.push(`#### ${skill.name}`, "", renderAttachmentMeta(skill), "", skill.content || "(empty)", "");
          }
        }
        appendSkillSelectionReport(lines, delivery.skillSelection);
      }
    }
    lines.push("");
  }
  appendAttentionReport(lines, facts.attention);
}

// 把待人决策事项渲染成“请主动问开发者”的指令块（通用推送：以 AI 对话为通道，不依赖任何外部 IM）。
function appendAttentionReport(lines, attention) {
  if (!attention || (attention.total || 0) === 0) return;
  lines.push("## 需要开发者决策（请主动向开发者提问，不要替他决定）", "");
  lines.push(`- 共有 ${attention.total} 项待处理。请在对话中用中文向开发者说明，并给出明确选项，等开发者答复后再继续。`);
  for (const item of attention.awaitingPlanApproval || []) {
    lines.push(`- [计划待确认] 计划 ${item.planId} 需开发者确认后才能执行。请复述计划要点并询问“确认 / 需要修改”；确认后执行：\`${item.approveHint}\`。`);
  }
  for (const change of attention.openChanges || []) {
    lines.push(`- [越界变更待审] 任务 ${change.taskId} 改动越界：${(change.deniedPaths || []).join(", ") || "(见报告)"}。请询问开发者“接受并纳入范围 / 拒绝返工”；处理：\`${change.resolveHint}\`。`);
  }
  for (const task of attention.needsUserDecision || []) {
    lines.push(`- [任务待决策] 任务 ${task.id}（${task.status}）：${task.subject}。需要开发者给出下一步决定。`);
  }
  for (const task of attention.failedTasks || []) {
    lines.push(`- [任务失败] 任务 ${task.id}：${task.reason}。${task.retryHint ? `建议：${task.retryHint}` : "请与开发者确认返工方向。"}`);
  }
  for (const item of attention.awaitingAcceptance || []) {
    lines.push(`- [子 Agent 待验收] run ${item.runId} / 任务 ${item.taskId}（${item.agent}）。请询问开发者是否合入：\`${item.admitHint}\`。`);
  }
  lines.push("");
}

function appendShortList(lines, label, items) {
  const selected = Array.isArray(items) ? items.filter(Boolean).slice(0, 3) : [];
  if (selected.length === 0) return;
  lines.push(`- ${label}：`);
  for (const item of selected) {
    lines.push(`  - ${item}`);
  }
}

function appendInjectionAttachments(lines, injectionPoint) {
  lines.push("## Markdown 挂载", "");
  if (injectionPoint.markdown.length === 0) {
    lines.push("- (none)", "");
  } else {
    for (const item of injectionPoint.markdown) {
      lines.push(`### ${item.path}`, "", renderAttachmentMeta(item), "", item.content || "(empty)", "");
    }
  }
  lines.push("## Skill 挂载", "");
  if (injectionPoint.skills.length === 0) {
    lines.push("- (none)", "");
  } else {
    for (const skill of injectionPoint.skills) {
      lines.push(`### ${skill.name}`, "", renderAttachmentMeta(skill), "", skill.content || "(empty)", "");
    }
  }
  appendSkillSelectionReport(lines, injectionPoint.skillSelection);
}

function appendSkillSelectionReport(lines, selection) {
  if (!selection) return;
  const referenced = selection.referenced || [];
  const suggestions = selection.suggestions || [];
  const missing = selection.missing || [];
  if (missing.length > 0) {
    lines.push("## Skill 配置告警", "");
    for (const item of missing) {
      if (item.reason === "integrity_failed") {
        lines.push(`- ${item.name} 完整性校验失败，已拒绝加载：${item.detail || "Prompt Pack 路径或 hash 不可信"}`);
      } else {
        lines.push(`- ${item.name} 未找到：请安装到 \`.agents/skills/${item.name}/SKILL.md\`，或登记到 Prompt Pack。`);
      }
    }
    lines.push("");
  }
  if (selection.mode !== "dynamic" || (referenced.length === 0 && suggestions.length === 0)) return;
  lines.push("## 按需可加载 Skill（未注入全文）", "");
  for (const item of referenced) {
    lines.push(`- ${item.name}（${item.reason === "over_max_skills" ? "超出本次挂载上限" : "与本次请求未匹配"}）：需要时执行 \`node ./bin/helix.mjs prompts show --skill ${item.name}\``);
  }
  for (const item of suggestions) {
    lines.push(`- ${item.name}（匹配分 ${item.score}，不在本注入点清单）：需要时执行 \`node ./bin/helix.mjs prompts show --skill ${item.name}\``);
  }
  lines.push("");
}

function renderAttachmentMeta(item) {
  const source = item.path ? `path=${item.path}` : "";
  const origin = item.source ? `source=${item.source}` : "";
  const chars = `chars=${item.chars ?? 0}`;
  const loaded = `loaded=${item.loadedChars ?? String(item.content || "").length}`;
  const budget = `budget=${item.budgetChars ?? "unknown"}`;
  const truncated = `truncated=${item.truncated === true}`;
  return `> 挂载信息：${[source, origin, chars, loaded, budget, truncated].filter(Boolean).join("; ")}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function normalizeRelativePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}
