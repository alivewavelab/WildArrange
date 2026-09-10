import { writeFile } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import {
  ensureWildArrangeDirs,
  nowIso,
  resolveTaskAcceptancePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { isPossibleNoopTask, isTrivialCommand } from "../infra/task-predicates.mjs";
import { criteriaStatus } from "../infra/success-criteria.mjs";
import { hasRealReviewLane } from "../infra/gate-arming.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";

export async function writeAcceptanceProof(rootDir, planId, task, evidence = {}, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const { config } = await loadWildArrangeConfig(rootDir);
  const proof = buildAcceptanceProof(planId, task, evidence, config);
  const jsonPath = resolveTaskAcceptancePath(rootDir, planId, task.id, "json");
  const mdPath = resolveTaskAcceptancePath(rootDir, planId, task.id, "md");
  proof.reportJsonPath = path.relative(rootDir, jsonPath);
  proof.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, proof);
  await writeFile(mdPath, renderAcceptanceProofMarkdown(proof), "utf8");
  if (options.recordLedger !== false) {
    await appendLedger(rootDir, {
      type: proof.pass ? "acceptance_proof_passed" : "acceptance_proof_failed",
      planId,
      taskId: task.id,
      reportPath: proof.reportMdPath,
      failedCount: proof.checks.filter((check) => check.status === "fail").length,
    });
  }
  return proof;
}

export function buildAcceptanceProof(planId, task, evidence = {}, config = null) {
  const verifyResult = evidence.verifyResult || task.last_verify_result || latestEvidence(task, "verifier");
  const scopeResult = evidence.scopeResult || task.last_scope_result || latestEvidence(task, "scope_guard");
  const reviewResult = evidence.reviewResult || task.last_review_result || latestEvidence(task, "review_gate");
  const workerResult = evidence.workerResult || latestEvidence(task, "worker");
  const criteria = criteriaStatus(task);
  const verifyCommands = Array.isArray(task.verify_commands) ? task.verify_commands : [];
  const reviewLanes = Array.isArray(reviewResult?.lanes) ? reviewResult.lanes : [];
  const deliveryBaseline = summarizeDeliveryBaseline(evidence.deliveryBaseline || evidence.integrationCommit);
  const executedReview = hasExecutedIndependentReview(reviewResult);

  const checks = [
    proofCheck("worker_result", workerResult?.kind === "worker" && workerResult.exitCode === 0, {
      evidence: workerResult ? `exitCode=${workerResult.exitCode}` : "missing worker result",
      requiredFix: "重新运行 execute/worker，确保 worker evidence 写入任务。",
    }),
    proofCheck("verify_commands_present", verifyCommands.length > 0, {
      evidence: `${verifyCommands.length} verify command(s)`,
      requiredFix: "补充不可为空的 verify_commands，不允许清空验收门。",
    }),
    proofCheck("verify_not_trivial", verifyCommands.some((command) => !isTrivialCommand(command)), {
      evidence: verifyCommands.some((command) => !isTrivialCommand(command))
        ? "at least one verify command exercises real behavior"
        : "every verify command is trivial (e.g. `true`); the verification proves nothing",
      requiredFix: "把 verify_commands 换成覆盖真实行为的命令；trivial 验证不能作为完成证据。",
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
      requiredFix: "确保 BaiZe 的独立复核 lane 都有可审计结果。",
    }),
    // 与 verify_not_trivial 同类：同义反复的复核是「门在撒谎」——没有任何
    // 独立信号 lane 时 review PASS 不证明任何东西，不得进入 completed。
    proofCheck("review_not_tautological", hasRealReviewLane(task, config) && executedReview.pass, {
      evidence: executedReview.pass
        ? `independent review executed: ${executedReview.sources.join(", ")}`
        : `configured review did not produce a substantive passing result: ${executedReview.reasons.join("; ") || "no executed lane"}`,
      requiredFix: "本轮至少实际执行一条非空转 review/standards 命令、启用并运行质量门，或取得成功 LLM review；仅有配置、skipped/fallback 或 echo/node --version 不能完成任务。",
    }),
    proofCheck("delivery_commit_bound", evidence.deliveryRequired !== true || evidence.deliveryPending === true || Boolean(deliveryBaseline?.commitSha), {
      evidence: evidence.deliveryPending === true
        ? "delivery commit will be created before the final proof is persisted"
        : deliveryBaseline?.commitSha ? `delivery commit ${deliveryBaseline.commitSha}` : "missing delivery commit SHA",
      requiredFix: "在独立 task worktree/branch 形成 delivery commit，并让 acceptance proof 与 checkpoint 绑定同一 SHA。",
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
      deliveryBaseline,
    },
  };
}

function hasExecutedIndependentReview(reviewResult) {
  if (!reviewResult || reviewResult.kind !== "review_gate") return { pass: false, sources: [], reasons: ["missing review result"] };
  const sources = [];
  const reasons = [];
  for (const [name, results] of [["review_commands", reviewResult.reviewCommandResults], ["standards_commands", reviewResult.standardsCommandResults]]) {
    const substantive = (results || []).filter((result) => result.skipped !== true && !isTrivialCommand(result.command));
    if (substantive.some((result) => result.exitCode === 0)) sources.push(name);
    else if ((results || []).length > 0) reasons.push(`${name} were skipped, trivial, or failed`);
  }
  const quality = reviewResult.qualityResults || {};
  for (const name of ["lspResult", "astResult"]) {
    const result = quality[name];
    if (result?.status === "pass" && result?.pass === true
      && (result.results || []).some((entry) => entry.exitCode === 0 && !isTrivialCommand(entry.command))) sources.push(`quality:${name}`);
  }
  if (quality.hashlineResult?.status === "pass" && quality.hashlineResult?.pass === true
    && (quality.hashlineResult.anchors || []).length > 0) sources.push("quality:hashlineResult");
  if ((reviewResult.llmReviews || []).some((result) => result?.status === "pass" && result?.pass === true)) sources.push("llm_review");
  if (sources.length === 0 && reasons.length === 0) reasons.push("all independent lanes were skipped or unavailable");
  return { pass: sources.length > 0, sources, reasons };
}

function summarizeDeliveryBaseline(delivery) {
  if (!delivery) return null;
  return {
    status: delivery.status || null,
    commitSha: delivery.commitSha || delivery.integrationSha || delivery.actualSha || null,
    baseSha: delivery.baseSha || delivery.expectedSha || null,
    branch: delivery.branch || null,
    remote: delivery.remote || null,
    pushed: delivery.pushed === true,
    noChange: delivery.status === "no_change",
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
