// =============================================================================
// 文件名称：hook-result-gate.mjs
// 所属模块：infra
// 作用说明：
//   PostToolUse 工具结果硬失败检测：只看结构化字段（非零退出码、ok/success=false、
//   失败状态、宿主 error 字段），给出 block 建议；不写 ledger，也不扫描输出文本。
//
// 【运行原理速读】
//   读取 tool_response → 非零 exit / 显式失败态 → 返回 findings 与 decision。
// =============================================================================
import { nowIso } from "./runtime-store.mjs";

/**
 * evaluateHookResultGate：本模块对外 API（纯函数，无落盘）。
 */
export function evaluateHookResultGate(input = {}) {
  const toolName = String(input.tool_name || input.toolName || "");
  const response = input.tool_response
    ?? input.toolResponse
    ?? input.tool_output
    ?? input.toolOutput
    ?? input.error
    ?? input.response
    ?? null;
  const findings = detectToolResultFindings(response);
  // 宿主显式给出 error 字段（如 PostToolUseFailure）即为结构化失败信号。
  if (input.error != null && input.error !== "") {
    findings.push({
      name: "tool_error_reported",
      severity: "block",
      evidence: "host reported an error for this tool call",
      requiredAction: "工具调用已被宿主标记为出错，先处理失败原因再继续。",
    });
  }
  const decision = findings.length > 0 ? "block" : "pass";
  return {
    kind: "hook_result_gate",
    at: nowIso(),
    decision,
    toolName,
    findings,
    summary: summarizeDecision(decision, findings),
  };
}

/** 从结构化响应字段提取失败发现；不做文本正则扫描。 */
function detectToolResultFindings(response) {
  const findings = [];
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
