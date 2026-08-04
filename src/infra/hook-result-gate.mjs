import { appendLedger } from "./ledger.mjs";
import { nowIso } from "./runtime-store.mjs";

const HARD_FAILURE_PATTERNS = [
  { name: "mcp_transport_failure", regex: /\b(mcp|transport|socket|econnreset|econnrefused|timed out|timeout)\b/i },
  { name: "permission_denied", regex: /\b(permission denied|eperm|eacces|operation not permitted)\b/i },
  { name: "command_not_found", regex: /\b(command not found|not recognized as an internal|enoent|no such file or directory)\b/i },
  { name: "shell_failure", regex: /\b(exit code|exited with code|process\.exit|failed|error|exception)\b/i },
];

export async function evaluateHookResultGate(rootDir, input = {}) {
  const toolName = String(input.tool_name || input.toolName || "");
  const response = input.tool_response
    ?? input.toolResponse
    ?? input.tool_output
    ?? input.toolOutput
    ?? input.error
    ?? input.response
    ?? null;
  const findings = detectToolResultFindings(response);
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

export function detectToolResultFindings(response) {
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

  for (const pattern of HARD_FAILURE_PATTERNS) {
    const match = flat.match(pattern.regex);
    if (!match) continue;
    findings.push({
      name: pattern.name,
      severity: pattern.name === "shell_failure" && !flat.match(/\b(stderr|error|failed|exception)\b/i) ? "warn" : "block",
      evidence: truncate(match.input || flat, 280),
      requiredAction: "核对工具输出，修复失败根因；如果只是误报，需要记录人工解释。",
    });
  }

  return dedupeFindings(findings);
}

function summarizeDecision(decision, findings) {
  if (decision === "pass") return "tool result has no detected hard failure";
  return `${decision}: ${findings.map((finding) => finding.name).join(", ")}`;
}

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

function firstNumericValue(value, keys) {
  const found = findFirstValue(value, keys);
  return Number.isInteger(found) ? found : Number.isInteger(Number(found)) ? Number(found) : null;
}

function firstStringValue(value, keys) {
  const found = findFirstValue(value, keys);
  return typeof found === "string" ? found : null;
}

function booleanValue(value, keys) {
  const found = findFirstValue(value, keys);
  return typeof found === "boolean" ? found : null;
}

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

function truncate(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 15)}...[truncated]`;
}
