import path from "node:path";
import {
  DEFAULT_EXECUTOR_AGENT,
  DEFAULT_LEAD_AGENT,
  PRODUCT_NAME,
  STATE_VERSION,
  appendLedger,
  createWorkId,
  initRuntime,
  nowIso,
  resolveHelixPath,
  writeJsonAtomic,
} from "./helix-foundation.mjs";
import { pathAllowed, scopeGuard } from "./helix-gates.mjs";
import { resolveInjectionPoint } from "./helix-injection.mjs";
import { loadTaskState } from "./helix-plan.mjs";
import { routeRequest } from "./helix-routing.mjs";
import { scanProjectRules } from "./helix-rules.mjs";
import { findRunnableTask } from "./helix-team.mjs";
import { buildAgentContext, continuationDirective, resumeReport } from "./helix-context.mjs";
import { runArchivistRouter } from "./helix-archivist-router.mjs";
import { evaluateHookResultGate } from "./helix-hook-result-gate.mjs";

export async function runInjectionHook(rootDir, input = {}) {
  const hookRootDir = input.cwd && typeof input.cwd === "string" ? input.cwd : rootDir;
  await initRuntime(hookRootDir);
  const event = normalizeHookEvent(input.hook_event_name || input.event || input.name);
  const pointName = injectionPointForHookEvent(event);
  const sessionId = normalizeHookSessionId(input);
  const taskId = normalizeHookTaskId(input);
  const targetPaths = event === "PostToolUse" || event === "PreToolUse" ? extractHookTargetPaths(input) : [];
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
  } else if (event === "UserPromptSubmit") {
    facts.route = input.prompt ? await routeRequest(hookRootDir, { text: input.prompt }) : null;
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
  } else if (event === "PostToolUse") {
    facts.targetPaths = targetPaths;
    facts.rules = await scanProjectRules(hookRootDir, { targetPaths });
    facts.resultGate = await evaluateHookResultGate(hookRootDir, input);
    if (taskId) {
      facts.scope = await scopeGuard(hookRootDir, { taskId }).catch((error) => ({ status: "inconclusive", reason: error.message }));
    }
  } else if (event === "PostCompact") {
    facts.resume = await resumeReport(hookRootDir, { sessionId, source: "hook:post_compact" });
    facts.rules = await scanProjectRules(hookRootDir);
    facts.archivist = await runArchivistForHook(hookRootDir, input, {
      event,
      stage: "resume",
      trigger: "postCompact",
      text: facts.resume?.nextAction || "",
    });
  } else if (event === "Stop") {
    facts.continuation = await continuationDirective(hookRootDir, { sessionId, source: "hook:stop" });
  }

  const variables = {
    agent: input.agent || defaultAgentForHookEvent(event),
    taskId,
    planId: await currentPlanId(hookRootDir),
  };
  const injectionPoint = await resolveInjectionPoint(hookRootDir, pointName, variables);
  const contextMarkdown = injectionPoint.enabled ? renderHookInjectionMarkdown({ event, pointName, sessionId, taskId, targetPaths, facts, injectionPoint }) : "";
  const output = event === "PreToolUse" && injectionPoint.enabled
    ? renderPreToolUseHookOutput(facts.preflight, contextMarkdown)
    : contextMarkdown;
  const result = {
    kind: "helix_hook_injection",
    version: STATE_VERSION,
    at: nowIso(),
    event,
    pointName,
    sessionId,
    taskId: taskId || null,
    targetPaths,
    enabled: injectionPoint.enabled,
    decision: facts.preflight?.decision || facts.resultGate?.decision || null,
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
    taskId: taskId || null,
    decision: result.decision,
    outputChars: output.length,
  });
  return result;
}

export async function preToolUseGuard(rootDir, input = {}) {
  const event = normalizeHookEvent(input.hook_event_name || input.event || input.name);
  if (event !== "PreToolUse") throw new Error("preToolUseGuard requires PreToolUse input");
  const toolName = String(input.tool_name || input.toolName || "");
  const targetPaths = extractHookTargetPaths(input);

  if (toolName === "create_goal" && hasInvalidCreateGoalPayload(input.tool_input || input.toolInput)) {
    return {
      kind: "pre_tool_use_guard",
      at: nowIso(),
      decision: "deny",
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
      reason: "no project file target detected",
      toolName,
      taskId: task?.id || taskId || null,
      targetPaths,
      deniedPaths: [],
    };
  }
  if (!task) {
    return {
      kind: "pre_tool_use_guard",
      at: nowIso(),
      decision: "warn",
      reason: `file target detected but no active ${PRODUCT_NAME} task was found`,
      toolName,
      taskId: taskId || null,
      targetPaths,
      deniedPaths: [],
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

function extractHookTargetPaths(input) {
  const values = [];
  collectPathLikeValues(input.tool_input || input.toolInput, values);
  collectPathLikeValues(input.tool_response || input.toolResponse, values);
  collectPathLikeValues(input.paths || input.targetPaths, values);
  return uniqueStrings(values.map(normalizeRelativePath).filter((value) => value && !value.startsWith("..")));
}

function collectPathLikeValues(value, output) {
  if (typeof value === "string") {
    if (looksLikeProjectPath(value)) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathLikeValues(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(path|file|file_path|filepath|target|target_path|relative_path)$/i.test(key) && typeof nested === "string") {
      if (looksLikeProjectPath(nested)) output.push(nested);
      continue;
    }
    collectPathLikeValues(nested, output);
  }
}

function looksLikeProjectPath(value) {
  if (!value || value.includes("\n") || value.includes("\0")) return false;
  if (/^(https?:|data:|mailto:)/i.test(value)) return false;
  if (path.isAbsolute(value)) return false;
  return value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

function sanitizeFileSegment(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "unknown";
}

function renderHookInjectionMarkdown({ event, pointName, sessionId, taskId, targetPaths, facts, injectionPoint }) {
  const lines = [
    `<wildarrange-injection event="${event}" point="${pointName}">`,
    "",
    "# WildArrange Runtime Injection",
    "",
    `- Event: ${event}`,
    `- Injection point: ${pointName}`,
    `- Session: ${sessionId}`,
    `- Task: ${taskId || "(none)"}`,
    `- Config: ${injectionPoint.configPath}`,
    "",
    "## Required Behavior",
    "",
    "- Treat this block as live runtime context, not optional documentation.",
    "- Worker done-claim is not completion; completion requires verifier, scope, review, and checkpoint gates.",
    "- Project rules and success criteria cannot be weakened or deleted to manufacture PASS.",
    "- If injected evidence is insufficient, return INCONCLUSIVE or request the required gate instead of guessing.",
    "",
    "## Tools",
    "",
    injectionPoint.tools.length > 0 ? `- ${injectionPoint.tools.join("\n- ")}` : "- (none)",
    "",
  ];

  if (targetPaths.length > 0) {
    lines.push("## Dynamic Targets", "", ...targetPaths.map((targetPath) => `- ${targetPath}`), "");
  }
  appendHookFacts(lines, facts);
  appendInjectionAttachments(lines, injectionPoint);
  lines.push("</wildarrange-injection>", "");
  return lines.join("\n");
}

function appendHookFacts(lines, facts) {
  if (facts.route) {
    lines.push("## Route Decision", "");
    lines.push(`- Intent: ${facts.route.intent}`);
    lines.push(`- Route: ${facts.route.route}`);
    lines.push(`- Primary agent: ${facts.route.primaryAgent}`);
    lines.push(`- Category: ${facts.route.category || "(none)"}`);
    lines.push(`- Risk: ${facts.route.risk || "(unknown)"}`);
    if ((facts.route.planAgents || []).length > 0) {
      lines.push("- Plan Agent Bundle:");
      for (const agent of facts.route.planAgents) {
        lines.push(`  - ${agent.name} (${agent.stage}): ${agent.purpose}`);
      }
    }
    lines.push("");
  }
  if (facts.resume) {
    lines.push("## Resume", "");
    lines.push(`- Context: ${facts.resume.contextPath}`);
    lines.push(`- Next action: ${facts.resume.nextAction}`);
    lines.push("");
  }
  if (facts.continuation) {
    lines.push("## Continuation", "");
    lines.push(`- Should continue: ${facts.continuation.shouldContinue ? "yes" : "no"}`);
    lines.push(`- Reason: ${facts.continuation.reason}`);
    lines.push(`- Next command: ${facts.continuation.nextCommand || "(none)"}`);
    lines.push(`- Report: ${facts.continuation.reportMdPath}`);
    lines.push("");
  }
  if (facts.scope) {
    lines.push("## Scope Guard", "");
    lines.push(`- Status: ${facts.scope.status}`);
    lines.push(`- Reason: ${facts.scope.reason || "(none)"}`);
    lines.push("");
  }
  if (facts.resultGate) {
    lines.push("## Tool Result Gate", "");
    lines.push(`- Decision: ${facts.resultGate.decision}`);
    lines.push(`- Summary: ${facts.resultGate.summary}`);
    if (facts.resultGate.findings.length > 0) {
      for (const finding of facts.resultGate.findings) {
        lines.push(`- ${finding.severity}: ${finding.name} - ${finding.requiredAction}`);
      }
    }
    lines.push("");
  }
  if (facts.rules) {
    lines.push("## Project Rules", "");
    lines.push(`- Matched: ${facts.rules.matched}/${facts.rules.total}`);
    lines.push(`- Report: ${facts.rules.reportMdPath}`);
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
    lines.push("## Agent Context", "");
    if (facts.agentContext.error) {
      lines.push(`- Error: ${facts.agentContext.error}`);
    } else {
      lines.push(`- Report: ${facts.agentContext.reportMdPath}`);
      lines.push(`- Agent: ${facts.agentContext.agent}`);
      lines.push(`- Role: ${facts.agentContext.role}`);
    }
    lines.push("");
  }
}

function appendInjectionAttachments(lines, injectionPoint) {
  lines.push("## Markdown Mounts", "");
  if (injectionPoint.markdown.length === 0) {
    lines.push("- (none)", "");
  } else {
    for (const item of injectionPoint.markdown) {
      lines.push(`### ${item.path}`, "", item.content || "(empty)", "");
    }
  }
  lines.push("## Skill Mounts", "");
  if (injectionPoint.skills.length === 0) {
    lines.push("- (none)", "");
  } else {
    for (const skill of injectionPoint.skills) {
      lines.push(`### ${skill.name}`, "", skill.content || "(empty)", "");
    }
  }
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
