import { nowIso } from "./runtime-store.mjs";

export function buildFailureSummary(task, { workerResult, verifyResult, scopeResult, reviewResult, criteriaResult, nextStatus }) {
  const reason = gateRejectionReason(workerResult, verifyResult, scopeResult, reviewResult, criteriaResult);
  const failed = failureTarget(reason, workerResult, verifyResult, scopeResult, criteriaResult);
  const observed = failureObserved(reason, workerResult, verifyResult, scopeResult, reviewResult, criteriaResult);
  const fixBy = failureFixBy(reason, task, scopeResult, reviewResult, criteriaResult);
  const doNot = failureDoNot(reason);
  return {
    kind: "failure_summary",
    at: nowIso(),
    taskId: task.id,
    reason,
    nextStatus,
    failed,
    observed,
    fixBy,
    doNot,
    changeRequest: task.last_change_request || null,
    retryHint: [
      `FAILED: ${failed}`,
      `OBSERVED: ${observed}`,
      `FIX BY: ${fixBy}`,
      `DO NOT: ${doNot}`,
    ].join("\n"),
  };
}

function rejectionReason(workerResult, verifyResult, scopeResult) {
  if (workerResult.exitCode !== 0) return "worker_failed";
  if (!verifyResult.pass) return "verifier_failed";
  if (scopeResult.status === "fail") return "scope_guard_failed";
  if (scopeResult.status !== "pass") return "scope_guard_inconclusive";
  return "unknown";
}

function gateRejectionReason(workerResult, verifyResult, scopeResult, reviewResult, criteriaResult) {
  const base = rejectionReason(workerResult, verifyResult, scopeResult);
  if (base !== "unknown") return base;
  if (criteriaResult && criteriaResult.pass === false) return "criteria_failed";
  if (reviewResult?.pass === false) return "review_gate_failed";
  return "unknown";
}

function failureTarget(reason, workerResult, verifyResult, scopeResult, criteriaResult) {
  if (reason === "worker_failed") return workerResult.command || "worker command";
  if (reason === "verifier_failed") {
    const failedCommand = verifyResult.results?.find((result) => result.exitCode !== 0);
    return failedCommand?.command || "verifier command";
  }
  if (reason === "scope_guard_failed") return `scope guard denied ${scopeResult.deniedPaths?.join(", ") || "changed paths"}`;
  if (reason === "scope_guard_inconclusive") return "scope guard did not produce passing changed-path evidence";
  if (reason === "criteria_failed") return `success criteria (${criteriaResult?.passed || 0}/${criteriaResult?.total || 0} pass)`;
  if (reason === "review_gate_failed") return "review gate";
  return "checkpoint gate";
}

function failureObserved(reason, workerResult, verifyResult, scopeResult, reviewResult, criteriaResult) {
  if (reason === "worker_failed") return commandObservation(workerResult);
  if (reason === "verifier_failed") {
    const failedCommand = verifyResult.results?.find((result) => result.exitCode !== 0);
    return commandObservation(failedCommand || { exitCode: 1 });
  }
  if (reason === "scope_guard_failed") {
    return `changed=${(scopeResult.changedPaths || []).join(", ") || "none"}; denied=${(scopeResult.deniedPaths || []).join(", ") || "none"}`;
  }
  if (reason === "scope_guard_inconclusive") {
    return `scopeStatus=${scopeResult.status || "missing"}; reason=${scopeResult.reason || "missing changed-path evidence"}`;
  }
  if (reason === "criteria_failed") {
    return `criteria pass=${criteriaResult?.passed || 0}, pending=${criteriaResult?.pending || 0}, fail=${criteriaResult?.failed || 0}`;
  }
  if (reason === "review_gate_failed") {
    const failedLanes = (reviewResult?.lanes || []).filter((lane) => lane.status === "fail");
    return failedLanes.map((lane) => `${lane.name}: ${lane.summary}`).join("; ") || "review gate failed without lane details";
  }
  return "missing or inconclusive gate evidence";
}

function commandObservation(result) {
  const stdout = truncateForSummary((result.stdout || "").trim());
  const stderr = truncateForSummary((result.stderr || "").trim());
  return [`exitCode=${result.exitCode ?? 1}`, stdout ? `stdout=${stdout}` : null, stderr ? `stderr=${stderr}` : null].filter(Boolean).join("; ");
}

function failureFixBy(reason, task, scopeResult, reviewResult, criteriaResult) {
  if (reason === "worker_failed") return "修复 worker_command 或交给 ZhuRong 重新实现同一任务，然后重跑 execute。";
  if (reason === "verifier_failed") return "按失败命令输出修正实现，不改验收标准；修完后重跑 verify 和 checkpoint。";
  if (reason === "scope_guard_failed") {
    return `移除计划外改动或创建 ChangeRequest 扩展 writable_paths。当前允许范围：${task.writable_paths.join(", ") || "(none)"}；被拒绝：${(scopeResult.deniedPaths || []).join(", ") || "(unknown)"}`;
  }
  if (reason === "scope_guard_inconclusive") {
    return "恢复可审计的改动证据后重跑 scope/checkpoint；非 Git 项目应使用文件清单 fallback，或初始化 Git 以获得可靠 changed paths。";
  }
  if (reason === "criteria_failed") {
    return `补齐 successCriteria 证据后重跑 review/checkpoint。当前 pass=${criteriaResult?.passed || 0}, pending=${criteriaResult?.pending || 0}, fail=${criteriaResult?.failed || 0}。`;
  }
  if (reason === "review_gate_failed") {
    const failedLanes = (reviewResult?.lanes || []).filter((lane) => lane.status === "fail");
    return failedLanes.map((lane) => lane.fixBy).filter(Boolean).join("；") || "修复 review gate 指出的阻塞项，然后重跑 review 和 checkpoint。";
  }
  return "补齐缺失证据后重新进入 verify/checkpoint。";
}

function failureDoNot(reason) {
  if (reason === "scope_guard_failed") return "不要直接重试同一 worker；先处理范围漂移。";
  if (reason === "scope_guard_inconclusive") return "不要把“看不到改动”当作“没有越界”。";
  if (reason === "verifier_failed") return "不要降低或删除 verify_commands 来制造 PASS。";
  if (reason === "worker_failed") return "不要跳过 worker 失败直接 checkpoint。";
  if (reason === "review_gate_failed") return "不要绕过 review gate 或删除 review_commands 来制造 PASS。";
  if (reason === "criteria_failed") return "不要删除 successCriteria 或伪造 criterion evidence 来制造 PASS。";
  return "不要在证据不完整时 checkpoint。";
}

function truncateForSummary(value, limit = 500) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 15)}...[truncated]`;
}
