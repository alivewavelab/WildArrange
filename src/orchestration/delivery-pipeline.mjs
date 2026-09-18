// =============================================================================
// 文件名称：delivery-pipeline.mjs
// 所属模块：orchestration
// 作用说明：
//   共享交付流水线：强制质量门顺序的唯一来源。线性 runtime 与并行 admission
//   均调用此处，而非各自实现 verify → scope → review → proof → checkpoint。
//
// 【运行原理速读】
//   可以把它想成「任务完工前的固定安检通道」：
//
//   · 何时执行？
//     linear-runtime 与 admission 在 worker 成功后进入 gates。
//
//   · 做了什么？
//     verify/scope/review 全量收集证据 → 全通过后 runCompletionSegment → completed。
//
//   · 约束？
//     改门顺序或新增 gate 只能在此文件；verify/scope/review 之间不得 early bail。
// =============================================================================
import { invokeCapability, capabilityModule, capabilityErrorEnvelope } from "../capabilities/gateway.mjs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { assertTaskOrDeliveredOwnership, integrateAdmissionCommit } from "./integration.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { emitDecision } from "../infra/decision-log.mjs";
import { buildErrorProtocol } from "../infra/error-protocol.mjs";
import { writeMemoryDigest } from "../infra/memory-digest.mjs";
import { normalizeRelativePath } from "../infra/path-match.mjs";
import { nowIso, resolveTaskReportPath } from "../infra/runtime-store.mjs";
import { applyVerifierEvidenceToCriteria, criteriaStatus } from "../infra/success-criteria.mjs";
import { appendWisdom } from "../infra/task-reports.mjs";
import { persistTaskState } from "./task-board.mjs";
import { prepareContractReview } from "./contract-governance.mjs";

// --- 门序与完成判定 ---

/**
 * 根据 scope/review 结果与 attempts 判断本次交付尝试是否应标记失败。
 * @param {object} task 含 attempts、maxAttempts
 * @param {object} verifyResult verifier 结果
 * @param {object} scopeResult scope 结果
 * @param {object} reviewResult review 结果
 * @returns {boolean} true 表示应标记 failed 而非 pending 重试
 */
export function shouldFailDeliveryAttempt(task, verifyResult, scopeResult, reviewResult) {
  if (scopeResult?.status === "fail") return true;
  if (scopeResult && scopeResult.status !== "pass") return true;
  if (verifyResult?.pass === true && reviewResult?.kind === "review_gate" && reviewResult.pass === false) return true;
  return task.attempts >= task.maxAttempts;
}

/**
 * 固定顺序提交 completed：账本 → wisdom → digest → persistTaskState。
 * @param {string} rootDir 项目根
 * @param {object} options taskState、task、verifyResult、ledgerEvent、digestReason
 */
export async function commitTaskCompletionState(rootDir, options) {
  const { taskState, task, verifyResult, ledgerEvent, digestReason } = options;
  task.status = "completed";
  task.updatedAt = nowIso();
  await appendLedger(rootDir, ledgerEvent);
  await appendWisdom(rootDir, task, verifyResult);
  await writeMemoryDigest(rootDir, { reason: digestReason, stage: "checkpoint", task, taskId: task.id });
  await persistTaskState(rootDir, taskState);
}

/**
 * 任务已 durable completed 后运行快照/摘要等便利副作用；失败不得反完成，
 * 仅记 completion_side_effect_failed 并返回警告。wisdom/digest 必须在 persist 之前。
 */
export async function runPostCompletionSideEffects(rootDir, planId, task, effects) {
  try {
    await effects();
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendLedger(rootDir, {
      type: "completion_side_effect_failed",
      planId,
      taskId: task.id,
      error: message,
    }).catch(() => {});
    return [{ kind: "post_completion_side_effect", error: message }];
  }
}

const GATE_STEPS = ["verify", "scope", "review"];

const STEP_LABELS = {
  verify: "验证",
  scope: "范围守卫",
  review: "复核",
  "acceptance-proof": "验收证明",
  checkpoint: "存档",
};

// --- 主流水线 ---

/**
 * 运行 verify → scope → review → contract → completion 完整交付流水线。
 * @param {string} rootDir 项目根
 * @param {string} planId 计划 ID
 * @param {object} task 任务对象
 * @param {object} [options] initialEvidence、changedPaths、preCompletionGate、delivery、runId
 * @returns {Promise<object>} status 与 steps/evidence/criteria
 */
export async function runDeliveryPipeline(rootDir, planId, task, options = {}) {
  const evidence = { ...(options.initialEvidence || {}) };
  const results = [];
  let criterionEvidenceRecorded = [];

  const finish = async (status, extra = {}) => {
    const currentCriteria = extra.criteria || criteriaStatus(task);
    await emitDecision(rootDir, {
      gate: "pipeline",
      decision: status,
      code: status === "completed" ? null : status,
      reason: pipelineOutcomeReason(status, results, currentCriteria),
      summary: `task ${task.id} delivery pipeline -> ${status}`,
      taskId: task.id,
      planId,
      runId: options.runId || null,
      annotatable: status !== "completed",
    });
    return finalizePipelineResult(status, results, evidence, { criteria: currentCriteria, criterionEvidenceRecorded, ...extra });
  };

  for (const stepName of GATE_STEPS) {
    if (stepName === "review") {
      // 契约治理预处理在网关之外，异常不得无审计穿透：转成 review 门 fail
      // 信封，照常发射门决策并经 finish() 收尾。
      try {
        evidence.contractGovernance = await prepareContractReview(rootDir, planId, task, options.executionRoot || rootDir, evidence);
      } catch (error) {
        const envelope = capabilityErrorEnvelope("review", error, 0);
        results.push(envelope);
        recordStepEvidence(stepName, evidence, envelope, task);
        await emitGateDecision(rootDir, planId, task, envelope, options.runId);
        return finish("blocked");
      }
    }
    const envelope = await invokeCapability(stepName, buildStepContext(stepName, { rootDir, planId, task, evidence, options }));
    results.push(envelope);
    if (stepName === "verify") {
      criterionEvidenceRecorded = recordStepEvidence(stepName, evidence, envelope, task);
    } else {
      recordStepEvidence(stepName, evidence, envelope, task);
    }
    // 每门跑完立即发射决策记录，保证 decisions 的时间序与门的真实执行序一致
    // （acceptance-proof/checkpoint 由 runCompletionSegment 发射）。
    await emitGateDecision(rootDir, planId, task, envelope, options.runId);
    const recoveryEvidence = findCommandRecoveryEvidence(evidence);
    if (recoveryEvidence) {
      evidence.commandRecovery = recoveryEvidence;
      return finish("recovery_required");
    }
  }

  const criteria = criteriaStatus(task);
  if (evidence.contractGovernance?.changeRequest) {
    return finish("awaiting_user_decision", { changeRequest: evidence.contractGovernance.changeRequest });
  }
  const workerExitOk = evidence.workerResult ? evidence.workerResult.exitCode === 0 : true;
  const gatesAllPass = workerExitOk && criteria.pass && results.every((result) => result.status === "pass");

  // pipeline 总账。emitDecision 是 best-effort，绝不反噬门控。
  // §3.4：任一 gate 未全 pass 时不得进入 completion 段，避免部分证据冒充完成。
  if (!gatesAllPass) {
    return finish("blocked");
  }

  if (typeof options.preCompletionGate === "function") {
    const completionGate = await options.preCompletionGate();
    evidence.integrationGuard = completionGate;
    if (completionGate?.pass !== true) {
      return finish("revalidation_required");
    }
  }

  const completion = await runCompletionSegment(rootDir, planId, task, evidence, {
    delivery: options.delivery,
    executionRoot: options.executionRoot,
    runId: options.runId,
  });
  results.push(completion.proofEnvelope);
  recordStepEvidence("acceptance-proof", evidence, completion.proofEnvelope, task);

  if (completion.status === "proof_failed") {
    return finish("blocked");
  }

  if (completion.integrationGate) {
    evidence.integrationCommit = completion.integrationGate;
  }
  if (completion.status === "revalidation_required") {
    return finish("revalidation_required");
  }

  results.push(completion.checkpointEnvelope);
  if (completion.status === "checkpoint_failed") {
    evidence.checkpointError = completion.checkpointEnvelope.error || { code: "checkpoint_failed", message: "checkpoint capability did not pass" };
    return finish("checkpoint_failed");
  }

  return finish("completed");
}

/** 从 worker/verify/review 结果中查找需人工确认进程终止的 recovery 证据。 */
function findCommandRecoveryEvidence(evidence) {
  const candidates = [
    evidence.workerResult,
    evidence.reviewResult?.commandRecovery,
    ...(evidence.verifyResult?.results || []),
    ...(evidence.reviewResult?.reviewCommandResults || []),
    ...(evidence.reviewResult?.standardsCommandResults || []),
  ];
  return candidates.find((result) => result?.recoveryRequired === true || result?.terminationFailed === true) || null;
}

/** 从 gate 信封或约定路径推导决策记录用的 evidencePath。 */
function envelopeEvidencePath(envelope, planId, task) {
  const evidence = envelope?.evidence;
  if (evidence && typeof evidence === "object") {
    const direct = evidence.reportMdPath || evidence.reportJsonPath || evidence.checkpointPath;
    if (direct) return direct;
  }
  // review 报告由 linear-runtime/admission 在 pipeline 返回后按固定路径写入；
  // 决策记录先给出约定路径，审计者按图索骥即可。
  if (envelope?.capability === "review" && planId && task?.id) {
    return normalizeRelativePath(resolveTaskReportPath(".", "reviews", planId, task.id, "md"));
  }
  return null;
}

/**
 * 门业务失败（status=fail 但 error=null）时从 evidence 推出 code/reason——
 * 「命中哪条规则」是决策可审判的核心承诺，FAIL 记录不允许两行皆空。
 */
function deriveGateFailure(envelope) {
  if (envelope.error?.code) return { code: envelope.error.code, reason: envelope.error.message || null };
  if (envelope.status === "pass") return { code: null, reason: null };
  const evidence = envelope.evidence;
  const fallback = { code: `${envelope.capability}_failed`, reason: null };
  if (!evidence || typeof evidence !== "object") return fallback;
  switch (envelope.capability) {
    case "verify": {
      const failing = (evidence.results || []).find((result) => result.exitCode !== 0);
      if (!failing) return fallback;
      const stderr = String(failing.stderr || "").trim().slice(0, 200);
      return {
        code: "verify_failed",
        reason: `\`${failing.command}\` exit=${failing.exitCode}${stderr ? `：${stderr}` : ""}`,
      };
    }
    case "scope": {
      const denied = (evidence.deniedPaths || []).slice(0, 5).join(", ");
      return {
        code: evidence.status === "inconclusive" ? "scope_inconclusive" : "scope_violation",
        reason: evidence.reason || (denied ? `越界路径：${denied}` : null),
      };
    }
    case "review": {
      const failedLanes = (evidence.lanes || []).filter((lane) => lane.status === "fail");
      if (failedLanes.length === 0) return fallback;
      const first = failedLanes[0];
      return {
        code: "review_failed",
        reason: `失败 lane：${failedLanes.map((lane) => lane.name).join(", ")}${first.summary ? `（${String(first.summary).slice(0, 160)}）` : ""}`,
      };
    }
    case "acceptance-proof": {
      const failed = (evidence.checks || []).filter((check) => check.status === "fail");
      if (failed.length === 0) return fallback;
      return {
        code: `proof_${failed[0].name}`,
        reason: failed.map((check) => `${check.name}: ${check.evidence}`).join("; ").slice(0, 300),
      };
    }
    case "worker":
      return { code: "worker_failed", reason: `exitCode=${evidence.exitCode}` };
    default:
      return fallback;
  }
}

/** 单门完成后发射 decisions.jsonl 记录；构造失败不得反噬门控主流程。 */
async function emitGateDecision(rootDir, planId, task, envelope, runId = null) {
  // 防御深度：记录构造也必须 best-effort，未来字段提取逻辑抛错不得反噬门控。
  try {
    const derived = deriveGateFailure(envelope);
    await emitDecision(rootDir, {
      gate: envelope.capability,
      decision: envelope.status,
      code: derived.code,
      reason: derived.reason,
      summary: `${STEP_LABELS[envelope.capability] || envelope.capability}门 ${envelope.status}`,
      evidencePath: envelopeEvidencePath(envelope, planId, task),
      taskId: task.id,
      planId,
      runId,
      // 标注队列规则：拦截（非 pass）一律可标注；review 门的放行可能含
      // LLM/主观判断，属于非确定性放行，同样可标注。其余确定性 PASS 只进流水。
      annotatable: envelope.status !== "pass" || envelope.capability === "review",
    });
  } catch {
    // 决策日志是派生物，任何故障都不反噬主流程。
  }
}

/** 为 pipeline 总账决策生成人类可读 reason 摘要。 */
function pipelineOutcomeReason(status, results, criteria) {
  if (status === "completed") return "全部 gate 通过，checkpoint 已落盘";
  if (status === "revalidation_required") return "集成基线在 gate 期间变化或存在无归属改动";
  const failedStep = results.find((result) => result.status !== "pass");
  if (failedStep) return `${STEP_LABELS[failedStep.capability] || failedStep.capability}门未通过`;
  if (criteria && criteria.pass === false) return "successCriteria 未全部满足";
  return "worker 执行未成功";
}

// --- 完成段 ---

/**
 * acceptance-proof → integration → checkpoint 共享完成段；仅 status "completed" 可置 completed。
 * 线性单步 checkpoint 与主流水线共用此语义，checkpoint 失败不得静默吞掉。
 */
export async function runCompletionSegment(rootDir, planId, task, evidence, options = {}) {
  // 交付事实解析在网关之外（含 admission claim 围栏），异常不得无审计穿透：
  // 转成 acceptance-proof fail 信封，由调用方按既有 proof_failed 分支经 finish() 收尾。
  let delivery;
  try {
    delivery = await resolveDeliveryFacts(rootDir, task, options);
  } catch (error) {
    const proofEnvelope = capabilityErrorEnvelope("acceptance-proof", error, 0);
    await emitGateDecision(rootDir, planId, task, proofEnvelope, options.runId);
    return { status: "proof_failed", proofEnvelope, checkpointEnvelope: null };
  }
  evidence.deliveryRequired = delivery.required;
  evidence.deliveryPending = delivery.required && Boolean(delivery.target);
  // Entry flags cannot waive Git delivery. Missing targets fail the proof,
  // rather than making an unversioned task look like a non-Git task.
  evidence.deliveryBaseline = null;
  evidence.integrationCommit = null;
  let proofEnvelope = await invokeCapability("acceptance-proof", { rootDir, planId, task, evidence });
  if (proofEnvelope.status !== "pass") {
    await emitGateDecision(rootDir, planId, task, proofEnvelope, options.runId);
    return { status: "proof_failed", proofEnvelope, checkpointEnvelope: null };
  }
  evidence.acceptanceProof = proofEnvelope.evidence;
  let integrationGate = null;
  if (delivery.required) {
    // integration owns the owner/base/remote-intent fences for both paths.
    // A second linear-only assertion would reject a recovered admission push.
    integrationGate = await integrateAdmissionCommit(rootDir, {
      ...delivery.target, planId, task, taskId: task.id,
      changedPaths: evidence.scopeResult?.changedPaths || [],
    });
    evidence.integrationCommit = integrationGate;
    evidence.deliveryBaseline = integrationGate;
    evidence.deliveryPending = false;
    // §3.4：integration 围栏失败只回滚本 run 路径，已 push 的 delivery 由 integration 层保留 intent。
    if (integrationGate?.pass !== true) {
      await emitGateDecision(rootDir, planId, task, proofEnvelope, options.runId);
      return { status: "revalidation_required", proofEnvelope, integrationGate, checkpointEnvelope: null };
    }
    // The first proof pass authorizes creation of the delivery commit. Rewrite
    // the same proof after the commit/push so its durable evidence references
    // the exact SHA that checkpoint will bind. This is not a second approval
    // event, only completion of the first proof's evidence record.
    const boundProof = await invokeCapability("acceptance-proof", {
      rootDir,
      planId,
      task,
      evidence,
      options: { recordLedger: false },
    });
    if (boundProof.status !== "pass") {
      await emitGateDecision(rootDir, planId, task, boundProof, options.runId);
      return { status: "checkpoint_failed", proofEnvelope: boundProof, integrationGate, checkpointEnvelope: boundProof };
    }
    proofEnvelope = boundProof;
    evidence.acceptanceProof = proofEnvelope.evidence;
    if (task.delivery_workspace?.runId === delivery.target.runId && integrationGate.pass === true) {
      task.delivery_workspace.deliverySha = integrationGate.integrationSha || integrationGate.commitSha || integrationGate.actualSha;
    }
  } else {
    await assertTaskOrDeliveredOwnership(rootDir, planId, task);
  }
  await emitGateDecision(rootDir, planId, task, proofEnvelope, options.runId);
  const checkpointEnvelope = await invokeCapability("checkpoint", { rootDir, planId, task, evidence });
  await emitGateDecision(rootDir, planId, task, checkpointEnvelope, options.runId);
  if (checkpointEnvelope.status !== "pass") {
    return { status: "checkpoint_failed", proofEnvelope, integrationGate, checkpointEnvelope };
  }
  return { status: "completed", proofEnvelope, integrationGate, checkpointEnvelope };
}

/** 判定本任务是否必须 Git delivery commit，并解析 delivery target（含 admission claim 对齐）。 */
async function resolveDeliveryFacts(rootDir, task, options) {
  const workspace = task.delivery_workspace;
  const target = options.delivery || (workspace?.workDir && workspace?.runId && workspace?.baseSha
    ? { runId: workspace.runId, integrationGuard: { active: false, expectedSha: workspace.baseSha },
        deliveryWorktreeDir: workspace.workDir, deliveryFromWorktree: true }
    : null);
  if (options.delivery && task.admission_claim?.runId !== options.delivery.runId) {
    throw new Error("delivery target does not match the current admission claim");
  }
  const roots = new Set([rootDir, options.executionRoot, workspace?.workDir, target?.deliveryWorktreeDir].filter(Boolean));
  let required = Boolean(workspace || task.coordination?.localGit || task.coordination?.remote || target?.integrationGuard?.active);
  for (const root of roots) {
    try { await lstat(path.join(root, ".git")); required = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { required, target: target?.runId ? target : null };
}

// --- 证据收集 ---

/**
 * 从 task.evidence 轨迹回读各 gate 结果；单步 workflow 的前置条件与此 GATE_STEPS 对齐。
 * 新鲜度规则：gate 证据必须在最近一次 worker 条目之后，否则属上一轮执行。
 */
export function collectGateEvidenceFromTask(task) {
  const specs = {
    verify: { key: "verifyResult", kind: "verifier", passed: (record) => record?.pass === true },
    scope: { key: "scopeResult", kind: "scope_guard", passed: (record) => record?.status === "pass" },
    review: { key: "reviewResult", kind: "review_gate", passed: (record) => record?.pass === true },
  };
  const trail = task.evidence || [];
  const lastWorkerIndex = trail.reduce((found, entry, index) => (entry?.kind === "worker" ? index : found), -1);
  const evidence = {};
  const failedSteps = [];
  for (const stepName of GATE_STEPS) {
    const spec = specs[stepName];
    if (!spec) {
      failedSteps.push(stepName);
      continue;
    }
    let record = null;
    if (lastWorkerIndex >= 0) {
      for (let index = trail.length - 1; index > lastWorkerIndex; index -= 1) {
        if (trail[index]?.kind === spec.kind) {
          record = trail[index];
          break;
        }
      }
    }
    evidence[spec.key] = record;
    if (!spec.passed(record)) failedSteps.push(stepName);
  }
  return { evidence, failedSteps };
}

/** 按 gate 名组装 invokeCapability 所需的 ctx 对象。 */
function buildStepContext(stepName, { rootDir, planId, task, evidence, options }) {
  switch (stepName) {
    case "verify":
      return { rootDir, task, options: { executionRoot: options.executionRoot } };
    case "scope":
      return {
        rootDir,
        task,
        options: { changedPaths: options.changedPaths, unavailableReason: options.unavailableReason, executionRoot: options.executionRoot },
      };
    case "review":
      return {
        rootDir,
        task,
        evidence: {
          workerResult: evidence.workerResult,
          verifyResult: evidence.verifyResult,
          scopeResult: evidence.scopeResult,
          contractGovernance: evidence.contractGovernance,
        },
        options: { executionRoot: options.executionRoot },
      };
    case "acceptance-proof":
    case "checkpoint":
      return { rootDir, planId, task, evidence };
    default:
      return { rootDir, planId, task, evidence, options };
  }
}

/** 将网关信封归一化写入 evidence，verify 步额外更新 successCriteria。 */
function recordStepEvidence(stepName, evidence, envelope, task) {
  const stepEvidence = normalizeStepEvidence(stepName, envelope);
  if (stepName === "verify") {
    evidence.verifyResult = stepEvidence;
    // Mirrors wildarrange-node-runtime.mjs: a passing verifier can auto-satisfy
    // successCriteria that declare verifierCommandRefs, so criteriaStatus()
    // reflects it without a separate manual step. The caller (orchestration)
    // still owns deciding whether this is ledger-worthy.
    return applyVerifierEvidenceToCriteria(task, stepEvidence);
  }
  if (stepName === "scope") evidence.scopeResult = stepEvidence;
  if (stepName === "review") evidence.reviewResult = stepEvidence;
  if (stepName === "acceptance-proof") evidence.acceptanceProof = stepEvidence;
  return undefined;
}

/** 能力抛错或无 evidence 时合成最小 fail/inconclusive 结构，供后续 gate 与 proof 读取。 */
function normalizeStepEvidence(stepName, envelope) {
  if (envelope.evidence && typeof envelope.evidence === "object") return envelope.evidence;
  const error = envelope.error || null;
  const message = error?.message || `${stepName} capability failed without evidence`;
  if (stepName === "verify") {
    return {
      kind: "verifier",
      at: nowIso(),
      pass: false,
      results: [{ command: null, exitCode: 1, stdout: "", stderr: message }],
      error,
    };
  }
  if (stepName === "scope") {
    return {
      kind: "scope_guard",
      at: nowIso(),
      status: "inconclusive",
      reason: message,
      changedPaths: [],
      deniedPaths: [],
      error,
    };
  }
  if (stepName === "review") {
    return {
      kind: "review_gate",
      at: nowIso(),
      pass: false,
      reviewerAgents: ["gateway"],
      lanes: [{ name: "capability_error", agent: "gateway", status: "fail", summary: message, fixBy: error?.next_action || "运行 doctor 后修复能力异常" }],
      findings: [],
      testingGaps: [],
      residualRisks: [],
      reviewCommandResults: [],
      standardsCommandResults: [],
      error,
    };
  }
  return { kind: `${stepName}_evidence`, at: nowIso(), pass: false, error };
}

const GATE_NEXT_ACTIONS = {
  verify: "查看 .wildarrange 下最新 verify report，修复验证失败后重跑 node ./bin/wildarrange.mjs run",
  scope: "改动超出任务 writable_paths；缩小改动范围或走 ChangeRequest 调整计划",
  review: "查看 review report 处理复核发现后重跑",
  "acceptance-proof": "验收证明未通过：确认 verifier/scope/review 证据齐全且属于最新一轮执行",
  checkpoint: "运行 node ./bin/wildarrange.mjs doctor 检查状态完整性",
};

/** 组装 pipeline 返回体：步骤列表、耗时、费用与 error 协议。 */
function finalizePipelineResult(status, results, evidence, extra = {}) {
  const totalDurationMs = results.reduce((sum, result) => sum + (result.duration_ms || 0), 0);
  const totalCostAmount = results.reduce((sum, result) => sum + (result.cost?.amount || 0), 0);
  const costCurrency = results.find((result) => result.cost?.currency)?.cost?.currency || "CNY";
  return {
    status,
    error: status === "completed" ? null : pipelineErrorProtocol(status, results, extra),
    steps: results,
    evidence,
    changeRequest: extra.changeRequest || null,
    criteria: extra.criteria || null,
    criterionEvidenceRecorded: extra.criterionEvidenceRecorded || [],
    totalDurationMs,
    totalCost: totalCostAmount > 0 ? { amount: totalCostAmount, currency: costCurrency } : null,
    summary: renderPipelineSummary(results, totalDurationMs, totalCostAmount, costCurrency),
  };
}

/** 非 completed 时为 CLI/AI 生成统一 error-protocol 结构。 */
function pipelineErrorProtocol(status, results, extra) {
  if (status === "awaiting_user_decision") return buildErrorProtocol({ code: status, module: "orchestration/contract-governance.mjs",
    message: "计划外契约变更等待人类决定", nextAction: `主 Agent 阅读 ${extra.changeRequest?.reportMdPath || "变更报告"}，解释必要性、影响和替代方案；得到明确决定后运行 contracts resolve。` });
  if (status === "revalidation_required") {
    return buildErrorProtocol({
      code: "revalidation_required",
      module: "orchestration/integration.mjs",
      message: "集成基线在 gate 期间发生变化，或工作目录存在无归属改动",
      nextAction: "重新执行 admission/复核流程；不要手动改写任务状态文件",
    });
  }
  const failedStep = results.find((result) => result.status !== "pass");
  if (failedStep) {
    return buildErrorProtocol({
      code: status === "checkpoint_failed" ? "checkpoint_failed" : "gate_failed",
      module: capabilityModule(failedStep.capability),
      message: `${STEP_LABELS[failedStep.capability] || failedStep.capability}门未通过（${failedStep.capability}: ${failedStep.status}）`,
      nextAction: GATE_NEXT_ACTIONS[failedStep.capability] || "运行 node ./bin/wildarrange.mjs doctor；把本错误完整贴给 AI",
    });
  }
  if (extra.criteria && extra.criteria.pass === false) {
    return buildErrorProtocol({
      code: "success_criteria_unmet",
      module: "infra/success-criteria.mjs",
      message: "successCriteria 未全部满足",
      nextAction: "为每条判据绑定 verifier 命令或人工证据，不得清空判据来制造 PASS",
    });
  }
  return buildErrorProtocol({
    code: "worker_failed",
    module: "capabilities/worker.mjs",
    message: "worker 执行未成功",
    nextAction: "查看 worker 输出，修复后重跑 node ./bin/wildarrange.mjs run",
  });
}

/** 渲染各 gate 耗时/费用的一行摘要，供 status 与决策投影使用。 */
function renderPipelineSummary(results, totalDurationMs, totalCostAmount, costCurrency) {
  const stepLine = results
    .map((result) => {
      const mark = result.status === "pass" ? "✓" : result.status === "inconclusive" ? "?" : "✗";
      const label = STEP_LABELS[result.capability] || result.capability;
      const cost = result.cost?.amount ? `, ¥${result.cost.amount}` : "";
      return `${mark} ${label}(${formatDuration(result.duration_ms)}${cost})`;
    })
    .join(" → ");
  const costPart = totalCostAmount > 0 ? ` ｜ 总费用 ${costCurrency === "CNY" ? "¥" : costCurrency}${totalCostAmount}` : "";
  return `${stepLine}\n总耗时 ${formatDuration(totalDurationMs)}${costPart}`;
}

/** 毫秒格式化为 ms 或 s 字符串。 */
function formatDuration(ms) {
  if (typeof ms !== "number") return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
