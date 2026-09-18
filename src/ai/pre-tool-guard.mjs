import { realpathSync } from "node:fs";
import path from "node:path";
import {
  PRODUCT_NAME,
  loadWildArrangeConfig,
} from "../infra/runtime-config.mjs";
import {
  nowIso,
  readJson,
} from "../infra/runtime-store.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { normalizeRelativePath, pathAllowed } from "../infra/path-match.mjs";
import { uniqueStrings } from "../infra/text-utils.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";
import { findRunnableTask } from "../orchestration/task-board.mjs";
import { loadPlanApproval } from "../orchestration/plan-state.mjs";
import { compileCommandSafetyPatterns, evaluateCommandSafety } from "../infra/command-safety.mjs";
import { loadActiveFeatureDesignGate } from "../orchestration/feature-design.mjs";

export const TRUSTED_CLI_COMMAND_PREFIX = Symbol("wildarrange.trustedCliCommandPrefix");

export async function preToolUseGuard(rootDir, input = {}, options = {}) {
  const event = normalizeHookEvent(input.hook_event_name || input.event || input.name);
  if (event !== "PreToolUse") throw new Error("preToolUseGuard requires PreToolUse input");
  const toolName = String(input.tool_name || input.toolName || "");
  const targetPaths = extractPreToolTargetPaths(input, options.executionRoot || rootDir);
  const toolInput = input.tool_input || input.toolInput;
  const isApplyPatchTool = /^(?:functions\.)?apply_patch$/i.test(toolName);
  const isShellTool = /^(Bash|bash|exec_command|functions\.exec_command)$/.test(toolName);
  const shellCommand = isShellTool && toolInput && typeof toolInput === "object"
    ? toolInput.command || toolInput.cmd || ""
    : "";
  const cliCommandPrefix = normalizeHookCliCommandPrefix(input[TRUSTED_CLI_COMMAND_PREFIX]);

  if (isShellTool) {
    const { config } = await loadWildArrangeConfig(rootDir);
    const safety = evaluateCommandSafety(shellCommand, {
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

  if (isApplyPatchTool && targetPaths.length === 0) {
    const reason = "apply_patch target paths could not be parsed; refusing a file mutation whose planned scope cannot be verified";
    await appendLedger(rootDir, {
      type: "pre_tool_use_denied",
      reason: "unresolved_apply_patch_targets",
      toolName,
      targetPaths,
    });
    return {
      kind: "pre_tool_use_guard",
      at: nowIso(),
      decision: "deny",
      code: "unresolved_apply_patch_targets",
      reason,
      toolName,
      taskId: normalizeHookTaskId(input) || null,
      targetPaths,
      deniedPaths: [],
    };
  }

  const featureDesignGate = await loadActiveFeatureDesignGate(rootDir, featureGateSessionId(input));
  if (featureDesignGate?.status === "awaiting_feature_confirmation") {
    const blocked = (isShellTool && !isReadOnlyWildArrangeShellCommand(shellCommand, cliCommandPrefix, rootDir)) || targetPaths.length > 0;
    if (blocked) {
      return denyFeatureDesignToolUse(rootDir, {
        code: "feature_design_confirmation_required",
        reason: "feature design is awaiting explicit confirmation; implementation, plan files, and plan commands remain blocked",
        gate: featureDesignGate,
        toolName,
        targetPaths,
        shellCommand,
      });
    }
  }
  if (featureDesignGate?.status === "awaiting_plan_import") {
    const validPlanImport = isShellTool
      ? await isMatchingFeaturePlanImport(rootDir, shellCommand, featureDesignGate.id, cliCommandPrefix)
      : false;
    const blockedShell = isShellTool && !isReadOnlyWildArrangeShellCommand(shellCommand, cliCommandPrefix, rootDir) && !validPlanImport;
    const blockedWrite = targetPaths.length > 0 && !isPlanDraftWrite(targetPaths);
    if (blockedShell || blockedWrite) {
      return denyFeatureDesignToolUse(rootDir, {
        code: "feature_plan_required",
        reason: `feature design ${featureDesignGate.id} is confirmed but no matching complete plan has been imported`,
        gate: featureDesignGate,
        toolName,
        targetPaths,
        shellCommand,
      });
    }
  }

  const taskState = await loadTaskState(rootDir);
  const taskId = normalizeHookTaskId(input);
  const task = taskState
    ? taskId
      ? taskState.tasks.find((candidate) => candidate.id === taskId)
      : taskState.tasks.find((candidate) => ["in_progress", "verifying"].includes(candidate.status)) || findRunnableTask(taskState.tasks)
    : null;
  const planApproval = taskState
    ? await loadPlanApproval(rootDir).catch(() => ({ required: false, status: "approved", planId: taskState.planId }))
    : { required: false, status: "approved", planId: null };
  const awaitingPlanApproval = planApproval.required === true
    && planApproval.status !== "approved"
    && planApproval.planId === taskState?.planId;

  if (isShellTool && (!task || awaitingPlanApproval) && !isAllowedPrePlanShellCommand(shellCommand, cliCommandPrefix, rootDir)) {
    const code = awaitingPlanApproval ? "awaiting_plan_approval_shell" : "no_active_task_shell";
    const reason = awaitingPlanApproval
      ? "plan is awaiting user approval; only exact WildArrange plan-management and read-only commands are allowed"
      : "no active task exists; arbitrary shell commands are denied until a plan task is available";
    await appendLedger(rootDir, {
      type: "pre_tool_use_denied",
      reason: code,
      toolName,
      command: shellCommand,
      targetPaths,
    });
    return {
      kind: "pre_tool_use_guard",
      at: nowIso(),
      decision: "deny",
      code,
      reason,
      toolName,
      taskId: task?.id || taskId || null,
      targetPaths,
      deniedPaths: targetPaths,
    };
  }

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
  if (isPlanDraftWrite(targetPaths) && (!task || awaitingPlanApproval)) {
    await appendLedger(rootDir, {
      type: "pre_tool_use_allowed",
      reason: "plan_draft_write",
      toolName,
      targetPaths,
    });
    return {
      kind: "pre_tool_use_guard",
      at: nowIso(),
      decision: "allow",
      code: "plan_draft_write",
      reason: awaitingPlanApproval
        ? "plan is awaiting user approval; edits remain limited to a JSON plan draft under .wildarrange/plan-drafts/"
        : "no active task yet; write is limited to a JSON plan draft under .wildarrange/plan-drafts/",
      toolName,
      taskId: null,
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

export function normalizeHookEvent(value) {
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

export function normalizeHookTaskId(input) {
  const direct = input.taskId || input.task_id || process.env.WILDARRANGE_TASK_ID;
  if (direct && typeof direct === "string") return direct;
  const toolInput = input.tool_input || input.toolInput;
  if (toolInput && typeof toolInput === "object") {
    const nested = toolInput.taskId || toolInput.task_id;
    if (nested && typeof nested === "string") return nested;
  }
  return "";
}

export function extractHookTargetPaths(input, rootDir) {
  const values = [];
  collectPathLikeValues(input.tool_input || input.toolInput, values);
  collectApplyPatchTargetPaths(input, values);
  collectPathLikeValues(input.tool_response || input.toolResponse, values);
  collectPathLikeValues(input.paths || input.targetPaths, values, true);
  return uniqueStrings(values.map((value) => normalizeHookTargetPath(value, rootDir)).filter(Boolean));
}

export function extractPreToolTargetPaths(input, rootDir) {
  const toolName = String(input.tool_name || input.toolName || "");
  if (!/^(?:functions\.)?apply_patch$/i.test(toolName)) return extractHookTargetPaths(input, rootDir);
  const values = [];
  collectApplyPatchTargetPaths(input, values);
  return uniqueStrings(values.map((value) => normalizeHookTargetPath(value, rootDir)).filter(Boolean));
}

function collectApplyPatchTargetPaths(input, output) {
  const toolName = String(input.tool_name || input.toolName || "");
  if (!/^(?:functions\.)?apply_patch$/i.test(toolName)) return;
  const toolInput = input.tool_input || input.toolInput;
  const patchTexts = typeof toolInput === "string"
    ? [toolInput]
    : toolInput && typeof toolInput === "object"
      ? [toolInput.patch, toolInput.command, toolInput.diff].filter((value) => typeof value === "string")
      : [];
  for (const patchText of patchTexts) {
    const lines = patchText.split(/\r?\n/);
    const nativeApplyPatch = lines.some((line) => /^\*\*\* (?:Begin Patch|(?:Add|Update|Delete) File:|Move to:)/.test(line));
    for (const line of lines) {
      const applyPatchHeader = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/)
        || line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
      if (applyPatchHeader) {
        output.push(cleanPatchHeaderPath(applyPatchHeader[1]));
        continue;
      }
      if (nativeApplyPatch) continue;
      const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (gitHeader) {
        output.push(cleanPatchHeaderPath(gitHeader[1]));
        output.push(cleanPatchHeaderPath(gitHeader[2]));
        continue;
      }
      const unifiedHeader = line.match(/^(?:---|\+\+\+)\s+(.+)$/);
      if (unifiedHeader) {
        const candidate = cleanPatchHeaderPath(unifiedHeader[1].split("\t", 1)[0]);
        if (candidate !== "/dev/null") output.push(candidate.replace(/^[ab]\//, ""));
      }
    }
  }
}

function cleanPatchHeaderPath(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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

function isPlanDraftWrite(targetPaths) {
  return targetPaths.length > 0
    && targetPaths.every((targetPath) => /^\.wildarrange\/plan-drafts\/[A-Za-z0-9_.-]+\.json$/.test(targetPath));
}

const READ_ONLY_WILDARRANGE_SHELL_ARGS = /^(?:status|doctor|summary|timeline|decisions|config\s+show|changes\s+list|adoption\s+inventory|review\s+checklist\s+--task\s+[A-Za-z0-9_.-]+|review\s+configure\s+--from\s+\.wildarrange[\\/]plan-drafts[\\/][A-Za-z0-9_.-]+\.json|prompts\s+show\s+--skill\s+[A-Za-z0-9][A-Za-z0-9._-]{0,99}|resume(?:\s+--session\s+[A-Za-z0-9_.-]+)?|continuation\s+check(?:\s+--session\s+[A-Za-z0-9_.-]+)?|help(?:\s+--all)?|--help(?:\s+--all)?)$/i;

function isAllowedPrePlanShellCommand(command, cliCommandPrefix = "", controlRoot = "") {
  const args = stripVerifiedControlRootOption(parseWildArrangeShellArgs(command, cliCommandPrefix), controlRoot);
  if (!args) return false;
  if (READ_ONLY_WILDARRANGE_SHELL_ARGS.test(args)) return true;
  if (/^review\s+configure\s+--from\s+\.wildarrange[\\/]plan-drafts[\\/][A-Za-z0-9_.-]+\.json\s+--apply$/i.test(args)) return true;
  if (/^init(?:\s+--sample)?$/i.test(args)) return true;
  if (/^plan\s+approve(?:\s+--plan\s+[A-Za-z0-9_.-]+)?$/i.test(args)) return true;
  return /^plan\s+--from\s+(?:"[A-Za-z0-9_./\\:~ -]+\.json"|'[A-Za-z0-9_./\\:~ -]+\.json'|[A-Za-z0-9_./\\:~ -]+\.json)$/i.test(args);
}

function parseWildArrangeShellArgs(command, cliCommandPrefix = "") {
  if (typeof command !== "string") return null;
  const trimmed = command.trim();
  if (!trimmed || /[\r\n;&|><`$%!^]/.test(trimmed)) return null;
  const trustedPrefix = normalizeHookCliCommandPrefix(cliCommandPrefix);
  if (trustedPrefix && trimmed.startsWith(`${trustedPrefix} `)) {
    return trimmed.slice(trustedPrefix.length + 1).trim() || null;
  }
  const invocation = trimmed.match(
    /^(?:node(?:\.exe)?\s+(?:"[^"\r\n]*[\\/]wildarrange\.mjs"|'[^'\r\n]*[\\/]wildarrange\.mjs'|[^\s"']*wildarrange\.mjs)|npx(?:\.cmd)?\s+(?:-y\s+)?(?:@alivewavelab\/wildarrange(?:@[A-Za-z0-9._-]+)?|wildarrange(?:@[A-Za-z0-9._-]+)?))\s+(.+)$/i,
  );
  return invocation ? invocation[1].trim() : null;
}

function isReadOnlyWildArrangeShellCommand(command, cliCommandPrefix = "", controlRoot = "") {
  const args = stripVerifiedControlRootOption(parseWildArrangeShellArgs(command, cliCommandPrefix), controlRoot);
  return Boolean(args && READ_ONLY_WILDARRANGE_SHELL_ARGS.test(args));
}

async function isMatchingFeaturePlanImport(rootDir, command, gateId, cliCommandPrefix = "") {
  const args = stripVerifiedControlRootOption(parseWildArrangeShellArgs(command, cliCommandPrefix), rootDir);
  const match = args?.match(/^plan\s+--from\s+(?:"([^"]+\.json)"|'([^']+\.json)'|([^\s]+\.json))$/i);
  const rawPath = match?.[1] || match?.[2] || match?.[3];
  if (!rawPath) return false;
  const planPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(rootDir, rawPath);
  const plan = await readJson(planPath, null).catch(() => null);
  return plan?.feature_design_ref === gateId || plan?.featureDesignRef === gateId;
}

function stripVerifiedControlRootOption(args, controlRoot) {
  if (typeof args !== "string") return args;
  const pattern = /\s+--control-root\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))/gi;
  const matches = [...args.matchAll(pattern)];
  if (matches.length === 0) return args;
  const expected = normalizeControlRootPath(controlRoot);
  for (const match of matches) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (!expected || normalizeControlRootPath(value) !== expected) return null;
  }
  return args.replace(pattern, "").replace(/\s+/g, " ").trim();
}

function normalizeControlRootPath(value) {
  const normalized = path.resolve(String(value)).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function featureGateSessionId(input) {
  return String(input.session_id || input.sessionId || process.env.WILDARRANGE_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.CURSOR_SESSION_ID || "session");
}

async function denyFeatureDesignToolUse(rootDir, options) {
  await appendLedger(rootDir, {
    type: "pre_tool_use_denied",
    reason: options.code,
    featureDesignId: options.gate.id,
    featureDesignStatus: options.gate.status,
    toolName: options.toolName,
    command: options.shellCommand || null,
    targetPaths: options.targetPaths,
  });
  return {
    kind: "pre_tool_use_guard",
    at: nowIso(),
    decision: "deny",
    code: options.code,
    reason: options.reason,
    toolName: options.toolName,
    taskId: null,
    targetPaths: options.targetPaths,
    deniedPaths: options.targetPaths,
    featureDesignId: options.gate.id,
  };
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeHookCliCommandPrefix(value) {
  if (typeof value !== "string") return "";
  const prefix = value.trim();
  if (!prefix || prefix.length > 2_000 || /[\r\n\0]/.test(prefix)) return "";
  return prefix;
}
