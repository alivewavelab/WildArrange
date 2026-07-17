import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  appendLedger,
  ensureHelixDirs,
  nowIso,
  resolveHelixPath,
  writeJsonAtomic,
} from "./helix-foundation.mjs";
import { isPossibleNoopTask } from "./helix-plan.mjs";
import { criteriaStatus } from "./helix-team.mjs";

export async function writeAcceptanceProof(rootDir, planId, task, evidence = {}) {
  await ensureHelixDirs(rootDir);
  const proof = buildAcceptanceProof(planId, task, evidence);
  const basePath = resolveHelixPath(rootDir, "reports", "acceptance", `${planId}-${task.id}`);
  const jsonPath = `${basePath}.json`;
  const mdPath = `${basePath}.md`;
  proof.reportJsonPath = path.relative(rootDir, jsonPath);
  proof.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, proof);
  await writeFile(mdPath, renderAcceptanceProofMarkdown(proof), "utf8");
  await appendLedger(rootDir, {
    type: proof.pass ? "acceptance_proof_passed" : "acceptance_proof_failed",
    planId,
    taskId: task.id,
    reportPath: proof.reportMdPath,
    failedCount: proof.checks.filter((check) => check.status === "fail").length,
  });
  return proof;
}

export function buildAcceptanceProof(planId, task, evidence = {}) {
  const verifyResult = evidence.verifyResult || task.last_verify_result || latestEvidence(task, "verifier");
  const scopeResult = evidence.scopeResult || task.last_scope_result || latestEvidence(task, "scope_guard");
  const reviewResult = evidence.reviewResult || task.last_review_result || latestEvidence(task, "review_gate");
  const workerResult = evidence.workerResult || latestEvidence(task, "worker");
  const criteria = criteriaStatus(task);
  const verifyCommands = Array.isArray(task.verify_commands) ? task.verify_commands : [];
  const reviewLanes = Array.isArray(reviewResult?.lanes) ? reviewResult.lanes : [];

  const checks = [
    proofCheck("worker_result", workerResult?.kind === "worker" && workerResult.exitCode === 0, {
      evidence: workerResult ? `exitCode=${workerResult.exitCode}` : "missing worker result",
      requiredFix: "重新运行 execute/worker，确保 worker evidence 写入任务。",
    }),
    proofCheck("verify_commands_present", verifyCommands.length > 0, {
      evidence: `${verifyCommands.length} verify command(s)`,
      requiredFix: "补充不可为空的 verify_commands，不允许清空验收门。",
    }),
    proofCheck("not_noop_task", !isPossibleNoopTask(task), {
      evidence: isPossibleNoopTask(task)
        ? "worker/verify commands are empty or trivial and writable_paths is empty"
        : "task declares a real worker, verifier, or writable path",
      requiredFix: "补充真实的 worker_command / verify_commands 或 writable_paths；trivial 命令组合不能作为完成证据。",
    }),
    proofCheck("verifier_passed", verifyResult?.kind === "verifier" && verifyResult.pass === true, {
      evidence: verifyResult ? `pass=${verifyResult.pass}; results=${verifyResult.results?.length || 0}` : "missing verifier result",
      requiredFix: "运行并修复 verifier，直到所有验收命令通过。",
    }),
    proofCheck("verifier_matches_commands", Array.isArray(verifyResult?.results) && verifyResult.results.length === verifyCommands.length && verifyCommands.length > 0, {
      evidence: `verifyResults=${verifyResult?.results?.length || 0}; verifyCommands=${verifyCommands.length}`,
      requiredFix: "重新运行 verifier，确保每条 verify_commands 都有对应结果。",
    }),
    proofCheck("success_criteria_passed", criteria.pass === true, {
      evidence: `${criteria.passed}/${criteria.total} success criteria passed`,
      requiredFix: "补齐 successCriteria 证据，或修复实现后重新验收。",
    }),
    proofCheck("scope_passed", scopeResult?.status === "pass", {
      evidence: scopeResult ? `status=${scopeResult.status}` : "missing scope result",
      requiredFix: "移除越界改动，或走 ChangeRequest 审批扩展范围。",
    }),
    proofCheck("review_passed", reviewResult?.kind === "review_gate" && reviewResult.pass === true, {
      evidence: reviewResult ? `pass=${reviewResult.pass}; lanes=${reviewLanes.length}` : "missing review gate",
      requiredFix: "修复 review gate blocker，不允许跳过复核。",
    }),
    proofCheck("review_lanes_complete", reviewLanes.length > 0 && reviewLanes.every((lane) => lane.status !== "fail"), {
      evidence: reviewLanes.length > 0 ? reviewLanes.map((lane) => `${lane.name}:${lane.status}`).join(", ") : "missing review lanes",
      requiredFix: "确保 BaiZe/QiongQi/LuanNiao 等复核 lane 都有可审计结果。",
    }),
  ];

  return {
    kind: "acceptance_proof",
    at: nowIso(),
    planId,
    taskId: task.id,
    subject: task.subject,
    pass: checks.every((check) => check.status === "pass"),
    checks,
    evidenceRefs: {
      worker: summarizeCommand(workerResult),
      verifier: verifyResult ? { pass: verifyResult.pass, resultCount: verifyResult.results?.length || 0 } : null,
      scope: scopeResult ? { status: scopeResult.status, deniedPaths: scopeResult.deniedPaths || [] } : null,
      review: reviewResult ? { pass: reviewResult.pass, failedLanes: reviewLanes.filter((lane) => lane.status === "fail").map((lane) => lane.name) } : null,
      successCriteria: criteria,
    },
  };
}

function proofCheck(name, condition, details) {
  return {
    name,
    status: condition ? "pass" : "fail",
    evidence: details.evidence,
    requiredFix: details.requiredFix,
  };
}

function latestEvidence(task, kind) {
  return [...(task.evidence || [])].reverse().find((entry) => entry.kind === kind);
}

function summarizeCommand(result) {
  if (!result) return null;
  return {
    command: result.command || null,
    exitCode: result.exitCode,
    source: result.source || null,
  };
}

function renderAcceptanceProofMarkdown(proof) {
  const checks = proof.checks
    .map((check) => `| ${check.name} | ${check.status} | ${check.evidence} | ${check.requiredFix} |`)
    .join("\n");
  return `# Acceptance Proof

| Field | Value |
| --- | --- |
| Plan | \`${proof.planId}\` |
| Task | \`${proof.taskId}\` |
| Subject | ${proof.subject} |
| Status | \`${proof.pass ? "pass" : "fail"}\` |

## Checks

| Check | Status | Evidence | Required Fix |
| --- | --- | --- | --- |
${checks}
`;
}
