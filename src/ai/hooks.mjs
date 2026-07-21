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
} from "../infra/foundation.mjs";
import { pathAllowed } from "../infra/path-match.mjs";
import { invokeCapability } from "../capabilities/gateway.mjs";
import { resolveInjectionPoint } from "./injection.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";
import { routeRequest } from "./routing.mjs";
import { scanProjectRules } from "../infra/rule-scanner.mjs";
import { findRunnableTask } from "../orchestration/task-board.mjs";
import { buildAgentContext, continuationDirective, resumeReport } from "./context.mjs";
import { runArchivistRouter } from "./archivist-router.mjs";
import { evaluateHookResultGate } from "../infra/hook-result-gate.mjs";
import { writeMemoryDigest } from "../infra/memory-digest.mjs";
import { attentionReport } from "../orchestration/status.mjs";

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
    facts.digest = await writeMemoryDigest(hookRootDir, {
      reason: "session_start",
      stage: "resume",
      route: facts.route,
    }).catch((error) => ({ error: error.message }));
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
      facts.scope = await invokeCapability("scope", { rootDir: hookRootDir, task: { id: taskId } })
        .then((envelope) => envelope.evidence)
        .catch((error) => ({ status: "inconclusive", reason: error.message }));
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
    facts.digest = await writeMemoryDigest(hookRootDir, {
      reason: "post_compact",
      stage: "resume",
    }).catch((error) => ({ error: error.message }));
  } else if (event === "Stop") {
    facts.continuation = await continuationDirective(hookRootDir, { sessionId, source: "hook:stop" });
  }

  // 通用推送：在有"对话面"的事件里，把待人决策的事项主动注入，指示宿主 AI 直接问开发者。
  if (["SessionStart", "UserPromptSubmit", "PostCompact", "Stop"].includes(event)) {
    facts.attention = await attentionReport(hookRootDir).catch(() => null);
  }

  const variables = {
    agent: input.agent || defaultAgentForHookEvent(event),
    taskId,
    planId: await currentPlanId(hookRootDir),
  };
  const injectionPoint = await resolveInjectionPoint(hookRootDir, pointName, variables, {
    text: injectionTextForHookEvent(event, input, facts),
    stage: injectionStageForHookEvent(event, facts),
  });
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
    if ((facts.route.planAgents || []).length > 0) {
      lines.push("- 计划 Agent 组合：");
      for (const agent of facts.route.planAgents) {
        lines.push(`  - ${agent.name} (${agent.stage}): ${agent.purpose}`);
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
  if (!selection || selection.mode !== "dynamic") return;
  const referenced = selection.referenced || [];
  const suggestions = selection.suggestions || [];
  if (referenced.length === 0 && suggestions.length === 0) return;
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
  const chars = `chars=${item.chars ?? 0}`;
  const loaded = `loaded=${item.loadedChars ?? String(item.content || "").length}`;
  const budget = `budget=${item.budgetChars ?? "unknown"}`;
  const truncated = `truncated=${item.truncated === true}`;
  return `> 挂载信息：${[source, chars, loaded, budget, truncated].filter(Boolean).join("; ")}`;
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
