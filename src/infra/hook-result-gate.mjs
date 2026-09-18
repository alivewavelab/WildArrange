// =============================================================================
// 文件名称：hook-result-gate.mjs
// 所属模块：infra
// 作用说明：
//   PostToolUse 工具结果硬失败检测，block/warn 并写 ledger。
//
// 【运行原理速读】
//   flatten 响应 → 非零 exit/显式失败态 → 正则扫描 MCP/shell 失败 → appendLedger。
// =============================================================================
import { appendLedger } from "./ledger.mjs";
import { nowIso } from "./runtime-store.mjs";

const HARD_FAILURE_PATTERNS = [
  { name: "mcp_transport_failure", regex: /\b(mcp|transport|socket|econnreset|econnrefused|timed out|timeout)\b/i },
  { name: "permission_denied", regex: /\b(permission denied|eperm|eacces|operation not permitted)\b/i },
  { name: "command_not_found", regex: /\b(command not found|not recognized as an internal|enoent|no such file or directory)\b/i },
  { name: "shell_failure", regex: /\b(exit code|exited with code|process\.exit|failed|error|exception|could not apply patch|cannot apply patch|unable to apply patch)\b/i },
];

/**
 * evaluateHookResultGate：本模块对外异步 API。
 */
export async function evaluateHookResultGate(rootDir, input = {}) {
  const toolName = String(input.tool_name || input.toolName || "");
  const response = input.tool_response
    ?? input.toolResponse
    ?? input.tool_output
    ?? input.toolOutput
    ?? input.error
    ?? input.response
    ?? null;
  const findings = detectToolResultFindings(response, { toolName });
  const decision = findings.some((finding) => finding.severity === "block")
    ? "block"
    : findings.length > 0
      ? "warn"
      : "pass";
  const result = {
    kind: "hook_result_gate",
    at: nowIso(),
    decision,
    toolName,
    findings,
    summary: summarizeDecision(decision, findings),
  };
  await appendLedger(rootDir, {
    type: "hook_result_gate",
    decision,
    toolName,
    findingCount: findings.length,
    findingNames: findings.map((finding) => finding.name),
  });
  return result;
}

/**
 * detectToolResultFindings：本模块对外API。
 */
export function detectToolResultFindings(response, options = {}) {
  const findings = [];
  const flat = flattenToolResponse(response);
  const exitCode = firstNumericValue(response, ["exitCode", "exit_code", "code", "statusCode", "status_code"]);
  if (Number.isInteger(exitCode) && exitCode !== 0) {
    findings.push({
      name: "nonzero_exit_code",
      severity: "block",
      evidence: `exitCode=${exitCode}`,
      requiredAction: "不要把失败命令当作完成证据；先修复命令失败再继续。",
    });
  }

  if (booleanValue(response, ["ok", "success", "passed"]) === false) {
    findings.push({
      name: "explicit_unsuccessful_result",
      severity: "block",
      evidence: "response declares ok/success/passed=false",
      requiredAction: "工具显式失败，必须修复或重新执行，不允许继续 checkpoint。",
    });
  }

  const status = firstStringValue(response, ["status", "state", "result"]);
  if (status && /\b(fail|failed|error|errored|denied|rejected)\b/i.test(status)) {
    findings.push({
      name: "failed_status",
      severity: "block",
      evidence: `status=${status}`,
      requiredAction: "工具状态不是成功态，先处理失败原因。",
    });
  }

  const structuredStderr = collectNamedTextValues(response, "stderr").join("\n");
  const structuredStderrFailure = /\b(?:mcp|transport|socket|econnreset|econnrefused|timed out|timeout|permission denied|eperm|eacces|operation not permitted)\b/i.test(structuredStderr);
  const explicitFailureText = /(?:^|\r?\n)\s*(?:(?:output|stderr|message):\s*)?(?:error|failed|failure|exception)(?::|\s|$)/i.test(flat)
    || /(?:^|\r?\n)\s*(?:(?:output|stderr|message):\s*)?(?:permission denied|command not found|no such file or directory)(?::|\s|$)/i.test(flat)
    || /\bapply_patch\s*:\s*(?:permission denied|eperm|eacces|operation not permitted)\b/i.test(flat)
    || /\b(?:could not|cannot|can't|unable to)\s+apply patch\b/i.test(flat)
    || /\bapply_patch verification failed\b/i.test(flat)
    || /\bfailed to (?:apply|find|open|write|update|delete)\b/i.test(flat);
  const structuredSuccess = exitCode === 0
    || booleanValue(response, ["ok", "success", "passed"]) === true;
  const strictApplyPatchSuccess = /^\s*(?:Done!|Success\.\s+(?:Updated|Added|Deleted|Applied)(?: the following files)?:?(?:\r?\n[ADM]\s+[^\r\n]+)*)\s*$/i.test(flat);
  const successfulApplyPatch = /^(?:functions\.)?apply_patch$/i.test(String(options.toolName || ""))
    && !findings.some((finding) => finding.severity === "block")
    && !explicitFailureText
    && !structuredStderrFailure
    && (structuredSuccess || strictApplyPatchSuccess);

  for (const pattern of HARD_FAILURE_PATTERNS) {
    // Successful apply_patch output can legitimately echo paths or changed
    // source containing words such as "error" or "process.exit". Structured
    // failure fields above remain authoritative; textual scanning must not turn
    // a confirmed patch success into a false shell_failure warning.
    if (successfulApplyPatch) continue;
    const match = flat.match(pattern.regex);
    if (!match) continue;
    findings.push({
      name: pattern.name,
      severity: pattern.name === "shell_failure"
        && !explicitFailureText
        && !flat.match(/\b(stderr|error|failed|exception)\b/i) ? "warn" : "block",
      evidence: truncate(match.input || flat, 280),
      requiredAction: "核对工具输出，修复失败根因；如果只是误报，需要记录人工解释。",
    });
  }

  return dedupeFindings(findings);
}

/**
 * 汇总 Decision 为摘要。
 */
function summarizeDecision(decision, findings) {
  if (decision === "pass") return "tool result has no detected hard failure";
  return `${decision}: ${findings.map((finding) => finding.name).join(", ")}`;
}

/**
 * flattenToolResponse 内部辅助。
 */
function flattenToolResponse(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flattenToolResponse).join("\n");
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, nested]) => `${key}: ${flattenToolResponse(nested)}`)
      .join("\n");
  }
  return "";
}

/**
 * firstNumericValue 内部辅助。
 */
function firstNumericValue(value, keys) {
  const found = findFirstValue(value, keys);
  if (typeof found === "number") return Number.isInteger(found) ? found : null;
  if (typeof found !== "string" || found.trim() === "" || !/^-?\d+$/.test(found.trim())) return null;
  const parsed = Number(found.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * firstStringValue 内部辅助。
 */
function firstStringValue(value, keys) {
  const found = findFirstValue(value, keys);
  return typeof found === "string" ? found : null;
}

/**
 * booleanValue 内部辅助。
 */
function booleanValue(value, keys) {
  const found = findFirstValue(value, keys);
  return typeof found === "boolean" ? found : null;
}

/**
 * 收集 NamedTextValues 条目。
 */
function collectNamedTextValues(value, keyName, output = []) {
  if (!value || typeof value !== "object") return output;
  for (const [key, nested] of Object.entries(value)) {
    if (key === keyName && typeof nested === "string") output.push(nested);
    else if (nested && typeof nested === "object") collectNamedTextValues(nested, keyName, output);
  }
  return output;
}

/**
 * 查找 FirstValue 匹配项。
 */
function findFirstValue(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  }
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") {
      const found = findFirstValue(nested, keys);
      if (found !== null && found !== undefined) return found;
    }
  }
  return null;
}

/**
 * dedupeFindings 内部辅助。
 */
function dedupeFindings(findings) {
  const seen = new Set();
  const output = [];
  for (const finding of findings) {
    const key = `${finding.name}:${finding.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(finding);
  }
  return output;
}

/**
 * 截断  以控制摘要长度。
 */
function truncate(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 15)}...[truncated]`;
}

