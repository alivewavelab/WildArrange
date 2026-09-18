// =============================================================================
// 文件名称：acceptance-proof.mjs
// 所属模块：capabilities
// 作用说明：
//   汇总任务完成所需的全部门禁证据（worker、verifier、scope、review、
//   successCriteria、delivery commit 等），生成可审计的 acceptance proof
//   JSON/Markdown 报告，并可选写入 ledger。
//
// 【运行原理速读】
//   可以把它想成「任务毕业的最终成绩单」：
//
//   · 何时执行？
//     交付流水线在 review/verify/scope 均就绪后调用 writeAcceptanceProof。
//
//   · 它具体做了什么？
//     ① 收集各 gate 最新 evidence；② buildAcceptanceProof 逐项 proofCheck；
//     ③ 写出 JSON + Markdown；④ 记录 ledger 事件。
//
//   · 和其他部分的关系？
//     依赖 project-review、responsibility-contract、gate-arming；被 gateway
//     的 acceptance-proof 能力调用；与 checkpoint 共享 delivery SHA 绑定。
//
//   · 缺了它会怎样？
//     任务无法宣称 completed；仅有 worker PASS 不足以关闭任务。
// =============================================================================

import { hasAcceptedProjectReview, prepareProjectReview } from "./project-review.mjs";
import { hasAcceptedResponsibilityAudit } from "../infra/responsibility-contract.mjs";
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

/**
 * 构建 acceptance proof、写入 JSON/Markdown 报告，并可选追加 ledger 事件。
 * @param {string} rootDir 项目根目录
 * @param {string} planId 计划 ID
 * @param {object} task 任务对象（含 evidence、verify_commands 等）
 * @param {object} [evidence] 各 gate 结果与 delivery 上下文
 * @param {object} [options] recordLedger 为 false 时不写 ledger
 * @returns {Promise<object>} 完整 proof 对象（含 pass、checks、evidenceRefs）
 */
export async function writeAcceptanceProof(rootDir, planId, task, evidence = {}, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const { config } = await loadWildArrangeConfig(rootDir);
  let projectReviewContextValid = false;
  try {
    const scope = evidence.scopeResult || task.last_scope_result || latestEvidence(task, "scope_guard");
    const review = evidence.reviewResult || task.last_review_result || latestEvidence(task, "review_gate");
    const current = await prepareProjectReview(rootDir, task, config, scope?.changedPaths || []);
    // §3.4：审查依据或 digest 已变时不得复用旧 projectReview PASS。
    projectReviewContextValid = !current.steps.length || (current.pass && current.contextDigest === review?.projectReview?.contextDigest);
  } catch { /* Missing or changed review inputs cannot reuse an old pass. */ }
  const proof = buildAcceptanceProof(planId, task, { ...evidence, projectReviewContextValid }, config);
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

/**
 * 纯函数：根据任务与 evidence 组装全部 proofCheck 列表与 pass 判定。
 * @param {string} planId 计划 ID
 * @param {object} task 任务对象
 * @param {object} [evidence] gate 结果与 projectReviewContextValid 等
 * @param {object|null} [config] WildArrange 配置（审查 lane 判定用）
 * @returns {object} acceptance_proof 结构体
 */
export function buildAcceptanceProof(planId, task, evidence = {}, config = null) {
  const verifyResult = evidence.verifyResult || task.last_verify_result || latestEvidence(task, "verifier");
  const scopeResult = evidence.scopeResult || task.last_scope_result || latestEvidence(task, "scope_guard");
  const reviewResult = evidence.reviewResult || task.last_review_result || latestEvidence(task, "review_gate");
  const workerResult = evidence.workerResult || latestEvidence(task, "worker");
  const criteria = criteriaStatus(task);
  const verifyCommands = Array.isArray(task.verify_commands) ? task.verify_commands : [];
  const reviewLanes = Array.isArray(reviewResult?.lanes) ? reviewResult.lanes : [];
  const deliveryBaseline = summarizeDeliveryBaseline(evidence.deliveryBaseline || evidence.integrationCommit);
  const executedReview = hasExecutedIndependentReview(reviewResult, config, task);

  const checks = [
    proofCheck("project_review_bound", evidence.projectReviewContextValid !== false && hasAcceptedProjectReview(config || {}, task, scopeResult, reviewResult?.projectReview), {
      evidence: reviewResult?.projectReview ? `policy=${reviewResult.projectReview.policyDigest}` : "no applicable project review receipt",
      requiredFix: "重新执行当前项目必需审查清单，不得使用旧配置的通过结果。",
    }),
    ...(task.responsibilityChanges ? [proofCheck("responsibility_audit_bound", hasAcceptedResponsibilityAudit(task, reviewResult?.responsibilityAudit), {
      evidence: reviewResult?.responsibilityAudit ? `decision=${reviewResult.responsibilityAudit.decision}; declaration=${reviewResult.responsibilityAudit.responsibilityDigest}; source=${reviewResult.responsibilityAudit.sourceDigest}` : "missing responsibility audit receipt",
      requiredFix: "重新执行独立职责审计；旧 Review PASS 或旧职责声明的审计不能作为完成证据。",
    })] : []),
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
      responsibilityAudit: reviewResult?.responsibilityAudit ? { decision: reviewResult.responsibilityAudit.decision, responsibilityDigest: reviewResult.responsibilityAudit.responsibilityDigest, sourceDigest: reviewResult.responsibilityAudit.sourceDigest } : null,
      worker: summarizeCommand(workerResult),
      verifier: verifyResult ? { pass: verifyResult.pass, resultCount: verifyResult.results?.length || 0 } : null,
      scope: scopeResult ? { status: scopeResult.status, deniedPaths: scopeResult.deniedPaths || [] } : null,
      review: reviewResult ? { pass: reviewResult.pass, failedLanes: reviewLanes.filter((lane) => lane.status === "fail").map((lane) => lane.name) } : null,
      successCriteria: criteria,
      deliveryBaseline,
    },
  };
}

/**
 * 判定 review gate 是否实际执行了至少一条非空转独立复核 lane。
 * @param {object|null} reviewResult review_gate evidence
 * @param {object|null} [config] 质量门与 commentChecker 配置
 * @param {object} [task] 是否声明 responsibilityChanges
 * @returns {{ pass: boolean, sources: string[], reasons: string[] }}
 */
function hasExecutedIndependentReview(reviewResult, config = null, task = {}) {
  if (!reviewResult || reviewResult.kind !== "review_gate") return { pass: false, sources: [], reasons: ["missing review result"] };
  const sources = [];
  // §3.4：职责审计 receipt 本身算一条独立 lane，但须与当前声明 digest 绑定。
  if (task.responsibilityChanges && hasAcceptedResponsibilityAudit(task, reviewResult.responsibilityAudit)) sources.push("responsibility_audit");
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
  if (config?.qualityGates?.commentChecker?.blockOnFindings === true
    && quality.commentResult?.status === "pass" && quality.commentResult?.pass === true
    && (quality.commentResult.checkedPaths || []).length > 0) sources.push("quality:commentResult");
  if ((reviewResult.llmReviews || []).some((result) => result?.status === "pass" && result?.pass === true)) sources.push("llm_review");
  if (sources.length === 0 && reasons.length === 0) reasons.push("all independent lanes were skipped or unavailable");
  return { pass: sources.length > 0, sources, reasons };
}

/** 将 delivery/integration commit 字段归一化为 acceptance proof 可引用的基线摘要。 */
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

/** 构造单项 proof check：condition 为真则 status=pass。 */
function proofCheck(name, condition, details) {
  return {
    name,
    status: condition ? "pass" : "fail",
    evidence: details.evidence,
    requiredFix: details.requiredFix,
  };
}

/** 从 task.evidence 倒序取指定 kind 的最新条目。 */
function latestEvidence(task, kind) {
  return [...(task.evidence || [])].reverse().find((entry) => entry.kind === kind);
}

/** 压缩 worker/command 结果为 acceptance proof 引用字段。 */
function summarizeCommand(result) {
  if (!result) return null;
  return {
    command: result.command || null,
    exitCode: result.exitCode,
    source: result.source || null,
  };
}

/** 将 proof 对象渲染为 Markdown 报告正文。 */
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
