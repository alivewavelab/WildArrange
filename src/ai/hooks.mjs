// =============================================================================
// 文件名称：hooks.mjs
// 所属模块：ai
// 作用说明：
//   WildArrange 宿主 Hook 主入口：按 SessionStart/UserPromptSubmit/PreToolUse 等
//   事件收集 facts、解析注入点、渲染上下文并写入 ledger 与 decisions 投影。
//   不负责具体路由表或范围校验实现，分别委托 routing.mjs 与 pre-tool-guard.mjs。
//
// 【运行原理速读】
//   · 何时触发？ bin/wildarrange.mjs hook run 或 Cursor hooks.json 回调。
//   · 做了什么？ ① 按事件分支收集 route/scope/archivist 等 facts ② resolveInjectionPoint
//     ③ renderHookInjectionMarkdown ④ 写 sessions/hooks 报告与 emitDecision。
//   · 与谁协作？ injection、routing、context、pre-tool-guard、hook-render、capabilities。
// =============================================================================

import path from "node:path";
import {
  DEFAULT_EXECUTOR_AGENT,
  DEFAULT_LEAD_AGENT,
} from "../infra/agent-registry.mjs";
import {
  STATE_VERSION,
  createWorkId,
  nowIso,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { emitDecision } from "../infra/decision-log.mjs";
import { initRuntime } from "../infra/runtime-bootstrap.mjs";
import { invokeCapability } from "../capabilities/gateway.mjs";
import { resolveInjectionPoint } from "./injection.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";
import { buildPlanDraftDirective, routeRequest, writeDailyRoutingReview } from "./routing.mjs";
import { scanProjectRules } from "../infra/rule-scanner.mjs";
import { buildAgentContext, continuationDirective, resumeReport } from "./context.mjs";
import { runArchivistRouter } from "./archivist-router.mjs";
import { evaluateHookResultGate } from "../infra/hook-result-gate.mjs";
import { writeMemoryDigest } from "../infra/memory-digest.mjs";
import { attentionReport } from "../orchestration/status.mjs";
import {
  TRUSTED_CLI_COMMAND_PREFIX,
  extractHookTargetPaths,
  extractPreToolTargetPaths,
  normalizeHookCliCommandPrefix,
  normalizeHookEvent,
  normalizeHookTaskId,
  preToolUseGuard,
} from "./pre-tool-guard.mjs";
import { renderHookInjectionMarkdown, renderPreToolUseHookOutput } from "./hook-render.mjs";

// --- 主 Hook 入口 ---

/**
 * 执行一次完整的 Hook 注入流程：收集 facts、解析注入点、渲染 output 并持久化。
 * @param {string} rootDir 控制根目录（.wildarrange 所在项目根）
 * @param {object} input 宿主 Hook 载荷（hook_event_name、prompt、tool_name 等）
 * @returns {Promise<object>} kind=wildarrange_hook_injection 的结果对象
 */
export async function runInjectionHook(rootDir, input = {}) {
  const controlRoot = rootDir;
  const executionRoot = input.cwd && typeof input.cwd === "string" ? input.cwd : controlRoot;
  await initRuntime(controlRoot);
  const event = normalizeHookEvent(input.hook_event_name || input.event || input.name);
  const pointName = injectionPointForHookEvent(event);
  const sessionId = normalizeHookSessionId(input);
  const hostAdapter = String(input.host_adapter || process.env.WILDARRANGE_HOST_ADAPTER || "").trim().toLowerCase();
  const hookConfigDigest = String(input.hook_config_digest || "").trim().toLowerCase();
  const cliCommandPrefix = normalizeHookCliCommandPrefix(input[TRUSTED_CLI_COMMAND_PREFIX]);
  const taskId = normalizeHookTaskId(input);
  const targetPaths = event === "PreToolUse"
    ? extractPreToolTargetPaths(input, executionRoot)
    : event === "PostToolUse" ? extractHookTargetPaths(input, executionRoot) : [];
  const facts = {};

  if (event === "SessionStart") {
    facts.resume = await resumeReport(controlRoot, { sessionId, source: "hook:session_start", cliCommandPrefix });
    facts.rules = await scanProjectRules(executionRoot, { controlRoot });
    facts.agentContext = await buildAgentContext(controlRoot, {
      executionRoot,
      agent: DEFAULT_LEAD_AGENT,
      taskId,
      injectionPoint: pointName,
    }).catch((error) => ({ error: error.message }));
    facts.archivist = await runArchivistForHook(controlRoot, input, {
      event,
      stage: "resume",
      trigger: "sessionStart",
      text: facts.resume?.nextAction || "",
    });
    facts.digest = await writeMemoryDigest(controlRoot, {
      reason: "session_start",
      stage: "resume",
      route: facts.route,
    }).catch((error) => ({ error: error.message }));
  } else if (event === "UserPromptSubmit") {
    facts.route = input.prompt ? await routeRequest(controlRoot, { text: input.prompt, sessionId }) : null;
    facts.planDraft = buildPlanDraftDirective(facts.route, {
      sessionId,
      prompt: input.prompt,
      controlRoot,
      executionRoot,
    });
    facts.rules = await scanProjectRules(executionRoot, { controlRoot });
    facts.archivist = await runArchivistForHook(controlRoot, input, {
      event,
      stage: stageForRoute(facts.route),
      trigger: "userPromptSubmit",
      text: input.prompt || "",
    });
  } else if (event === "PreToolUse") {
    facts.targetPaths = targetPaths;
    facts.rules = await scanProjectRules(executionRoot, { controlRoot, targetPaths });
    facts.preflight = await preToolUseGuard(controlRoot, input, { executionRoot });
    const executionTaskId = facts.preflight?.taskId || taskId;
    if (executionTaskId) {
      facts.agentContext = await buildAgentContext(controlRoot, {
        executionRoot,
        taskId: executionTaskId,
        planId: await currentPlanId(controlRoot),
        injectionPoint: "before_execute",
      }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    }
  } else if (event === "PostToolUse") {
    facts.targetPaths = targetPaths;
    facts.rules = await scanProjectRules(executionRoot, { controlRoot, targetPaths });
    facts.resultGate = await evaluateHookResultGate(controlRoot, input);
    if (taskId) {
      facts.scope = await invokeCapability("scope", { rootDir: controlRoot, task: { id: taskId } })
        .then((envelope) => envelope.evidence)
        .catch((error) => ({ status: "inconclusive", reason: error.message }));
    }
  } else if (event === "PostCompact") {
    facts.resume = await resumeReport(controlRoot, { sessionId, source: "hook:post_compact", cliCommandPrefix });
    facts.rules = await scanProjectRules(executionRoot, { controlRoot });
    facts.agentContext = await buildAgentContext(controlRoot, {
      executionRoot,
      agent: DEFAULT_LEAD_AGENT,
      taskId,
      injectionPoint: pointName,
    }).catch((error) => ({ error: error.message }));
    facts.archivist = await runArchivistForHook(controlRoot, input, {
      event,
      stage: "resume",
      trigger: "postCompact",
      text: facts.resume?.nextAction || "",
    });
    facts.digest = await writeMemoryDigest(controlRoot, {
      reason: "post_compact",
      stage: "resume",
    }).catch((error) => ({ error: error.message }));
  } else if (event === "Stop") {
    facts.continuation = await continuationDirective(controlRoot, { sessionId, source: "hook:stop", cliCommandPrefix });
    facts.routingReview = await writeDailyRoutingReview(controlRoot, {
      trigger: "hook:stop",
      sessionId,
    }).catch((error) => ({ status: "warn", reason: error instanceof Error ? error.message : String(error) }));
  }

  // 通用推送：在有"对话面"的事件里，把待人决策的事项主动注入，指示宿主 AI 直接问开发者。
  if (["SessionStart", "UserPromptSubmit", "PostCompact", "Stop"].includes(event)) {
    facts.attention = await attentionReport(controlRoot).catch(() => null);
  }

  const effectiveTaskId = taskId || facts.preflight?.taskId || "";
  const variables = {
    agent: facts.agentContext?.agent || input.agent || defaultAgentForHookEvent(event),
    taskId: effectiveTaskId,
    planId: await currentPlanId(controlRoot),
  };
  const injectionPoint = await resolveInjectionPoint(controlRoot, pointName, variables, {
    text: injectionTextForHookEvent(event, input, facts),
    stage: injectionStageForHookEvent(event, facts),
    routeSkills: facts.route?.skills || [],
  });
  const renderedContext = injectionPoint.enabled ? renderHookInjectionMarkdown({ event, pointName, sessionId, taskId: effectiveTaskId, targetPaths, facts, injectionPoint }) : "";
  const contextMarkdown = rewriteCanonicalCliCommands(renderedContext, cliCommandPrefix);
  // deny 时即使注入点关闭也要输出 PreToolUse JSON，以便宿主拦截工具调用
  const shouldRenderPreToolOutput = event === "PreToolUse"
    && (injectionPoint.enabled || facts.preflight?.decision === "deny");
  const output = shouldRenderPreToolOutput
    ? renderPreToolUseHookOutput(facts.preflight, contextMarkdown)
    : contextMarkdown;
  const result = {
    kind: "wildarrange_hook_injection",
    version: STATE_VERSION,
    at: nowIso(),
    event,
    pointName,
    sessionId,
    hostAdapter: hostAdapter || null,
    hookConfigDigest: hookConfigDigest || null,
    taskId: effectiveTaskId || null,
    targetPaths,
    enabled: injectionPoint.enabled,
    decision: facts.preflight?.decision || facts.resultGate?.decision || null,
    continuation: facts.continuation ? {
      required: facts.continuation.shouldContinue === true,
      reason: facts.continuation.reason || "",
      nextCommand: rewriteCanonicalCliCommands(facts.continuation.nextCommand || null, cliCommandPrefix),
    } : null,
    output,
  };
  const safeSessionId = sanitizeFileSegment(sessionId || "session");
  const safeEvent = sanitizeFileSegment(event);
  const outputPath = resolveWildArrangePath(controlRoot, "sessions", "hooks", `${safeSessionId}-${safeEvent}.json`);
  result.reportJsonPath = path.relative(controlRoot, outputPath);
  await writeJsonAtomic(outputPath, result);
  await appendLedger(controlRoot, {
    type: "hook_injection_run",
    event,
    pointName,
    sessionId,
    hostAdapter: hostAdapter || null,
    hookConfigDigest: hookConfigDigest || null,
    taskId: effectiveTaskId || null,
    decision: result.decision,
    outputChars: output.length,
  });
  // 决策投影：每次拦截/放行都进 decisions.jsonl，供 wildarrange decisions 与
  // 异步审查 Agent 复盘。best-effort，不反噬 hook 主流程。
  if (result.decision) {
    try {
      await emitDecision(controlRoot, {
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

// --- 决策投影与辅助 ---

/** 递归脱敏 tool_input 用于 decisions 投影，截断深层嵌套与敏感键值。 */
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

/**
 * 从 preflight/resultGate 提取结构化 decision code；禁止从 reason 散文反推。
 */
function hookDecisionCode(preflight, resultGate) {
  if (preflight?.code) return preflight.code;
  if (resultGate && resultGate.decision !== "pass") return "tool_result_gate";
  return null;
}

// --- 事件映射与 CLI 改写 ---

/** 将宿主 Hook 事件名映射为 wildarrange.config 中的 injectionPoints 键名。 */
function injectionPointForHookEvent(event) {
  if (event === "SessionStart") return "session_start";
  if (event === "UserPromptSubmit") return "user_prompt_submit";
  if (event === "PreToolUse") return "pre_tool_use";
  if (event === "PostToolUse") return "post_tool_use";
  if (event === "PostCompact") return "post_compact";
  if (event === "Stop") return "stop";
  throw new Error(`unsupported hook event: ${event}`);
}

/** 无 agentContext 时按 Hook 事件推断默认 Agent（主 Agent 或执行 Worker）。 */
function defaultAgentForHookEvent(event) {
  if (event === "SessionStart" || event === "UserPromptSubmit" || event === "Stop" || event === "PostCompact") return DEFAULT_LEAD_AGENT;
  return DEFAULT_EXECUTOR_AGENT;
}

/** Hook 侧档案员调用包装：失败时降级为 warn 结果，不阻断注入主流程。 */
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

/** 为 skill-matcher 提供请求文本；工具类 Hook 无可靠文本则留空走静态挂载。 */
function injectionTextForHookEvent(event, input, facts) {
  if (event === "UserPromptSubmit") return String(input.prompt || "");
  if (event === "SessionStart" || event === "PostCompact") return String(facts.resume?.nextAction || "");
  // PreToolUse / PostToolUse / Stop 没有可靠的请求文本，保持静态挂载
  return "";
}

/** 按 Hook 事件推断 skill-matcher stage（plan/recall 等）。 */
function injectionStageForHookEvent(event, facts) {
  if (event === "UserPromptSubmit") return stageForRoute(facts.route);
  if (event === "SessionStart" || event === "PostCompact") return "recall";
  return "";
}

/** 将路由 intent 映射为注入/skill-matcher 使用的 stage 标签。 */
function stageForRoute(route) {
  const intent = route?.intent;
  if (intent === "plan") return "plan";
  if (intent === "ask") return "clarify";
  if (intent === "review") return "review";
  if (intent === "resume") return "resume";
  if (intent === "execute") return "execute";
  return "default";
}

/** 从 Hook 载荷提取对话轮次，兼容 turns/messages/conversation 多种字段名。 */
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

/** 从 Hook 输入或环境变量解析 sessionId，缺失时生成新 ID。 */
function normalizeHookSessionId(input) {
  return String(input.session_id || input.sessionId || process.env.WILDARRANGE_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.CURSOR_SESSION_ID || createWorkId("session"));
}

/** 读取当前活跃 planId，供注入点模板变量与 agentContext 绑定。 */
async function currentPlanId(rootDir) {
  const taskState = await loadTaskState(rootDir);
  return taskState?.planId || "";
}

/** 将 sessionId/event 等片段规范为安全文件名（仅保留字母数字与 _.-）。 */
function sanitizeFileSegment(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "unknown";
}

/** 用 adapter 注入的可信 CLI 前缀替换 Markdown 中的 canonical 命令路径。 */
function rewriteCanonicalCliCommands(value, cliCommandPrefix) {
  if (typeof value !== "string" || !cliCommandPrefix) return value;
  return value.replaceAll("node ./bin/wildarrange.mjs", cliCommandPrefix);
}
