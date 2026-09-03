/**
 * Shared delivery pipeline: the one place that owns gate order.
 *
 * Both the linear runtime and the parallel-agent admission path are meant
 * to call this instead of re-implementing the verify -> scope -> review ->
 * acceptance-proof -> checkpoint sequence themselves. Changing gate order,
 * or inserting a new gate, only happens here.
 *
 * Faithfully mirrors the existing gating semantics in wildarrange-node-runtime.mjs:
 * verify / scope / review always run in full (no early bail between them so
 * every gate's evidence is always collected), and acceptance-proof +
 * checkpoint only run if every prior gate (worker, verify, criteria, scope,
 * review) already passed.
 */
import { invokeCapability } from "../capabilities/gateway.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { emitDecision } from "../infra/decision-log.mjs";
import { buildErrorProtocol, capabilityModule } from "../infra/error-protocol.mjs";
import { writeMemoryDigest } from "../infra/memory-digest.mjs";
import { normalizeRelativePath } from "../infra/path-match.mjs";
import { nowIso, resolveTaskReportPath } from "../infra/runtime-store.mjs";
import { applyVerifierEvidenceToCriteria, criteriaStatus } from "../infra/success-criteria.mjs";
import { appendWisdom } from "../infra/task-reports.mjs";
import { persistTaskState } from "./task-board.mjs";

export function shouldFailDeliveryAttempt(task, verifyResult, scopeResult, reviewResult) {
  if (scopeResult?.status === "fail") return true;
  if (scopeResult && scopeResult.status !== "pass") return true;
  if (verifyResult?.pass === true && reviewResult?.kind === "review_gate" && reviewResult.pass === false) return true;
  return task.attempts >= task.maxAttempts;
}

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
 * Runs post-commit conveniences (snapshot, workflow summary, …) after a task
 * is already durably completed. Their failure must not un-complete the task,
 * but it must not vanish either (cross-review P1, round 5, 2026-07-21): the
 * failure is recorded as a `completion_side_effect_failed` ledger event
 * (best-effort) and returned to the caller as a warning list. Anything that
 * MUST exist for a completed task (wisdom, digest) belongs BEFORE the
 * canonical persist instead, where a failure keeps the task recoverable.
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

export async function runDeliveryPipeline(rootDir, planId, task, options = {}) {
  const evidence = { ...(options.initialEvidence || {}) };
  const results = [];
  let criterionEvidenceRecorded = [];

  for (const stepName of GATE_STEPS) {
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
  }

  const criteria = criteriaStatus(task);
  const workerExitOk = evidence.workerResult ? evidence.workerResult.exitCode === 0 : true;
  const gatesAllPass = workerExitOk && criteria.pass && results.every((result) => result.status === "pass");

  // pipeline 总账。emitDecision 是 best-effort，绝不反噬门控。
  const finish = async (status, extra = {}) => {
      await emitDecision(rootDir, {
        gate: "pipeline",
        decision: status,
        code: status === "completed" ? null : status,
        reason: pipelineOutcomeReason(status, results, extra.criteria || criteria),
        summary: `task ${task.id} delivery pipeline -> ${status}`,
        taskId: task.id,
        planId,
        runId: options.runId || null,
        annotatable: status !== "completed",
      });
    return finalizePipelineResult(status, results, evidence, { criteria, criterionEvidenceRecorded, ...extra });
  };

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
    beforeCheckpointGate: options.beforeCheckpointGate,
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

function pipelineOutcomeReason(status, results, criteria) {
  if (status === "completed") return "全部 gate 通过，checkpoint 已落盘";
  if (status === "revalidation_required") return "集成基线在 gate 期间变化或存在无归属改动";
  const failedStep = results.find((result) => result.status !== "pass");
  if (failedStep) return `${STEP_LABELS[failedStep.capability] || failedStep.capability}门未通过`;
  if (criteria && criteria.pass === false) return "successCriteria 未全部满足";
  return "worker 执行未成功";
}

/**
 * The completion segment (acceptance-proof -> checkpoint) shared by the
 * pipeline above and by the single-step `node checkpoint` workflow, so
 * completion semantics have exactly one definition. A task may only become
 * `completed` when this returns status "completed": a failed or throwing
 * checkpoint write must never be silently absorbed (the gateway converts
 * throws into fail envelopes; we check the envelope status here).
 */
export async function runCompletionSegment(rootDir, planId, task, evidence, options = {}) {
  const proofEnvelope = await invokeCapability("acceptance-proof", { rootDir, planId, task, evidence });
  await emitGateDecision(rootDir, planId, task, proofEnvelope, options.runId);
  if (proofEnvelope.status !== "pass") {
    return { status: "proof_failed", proofEnvelope, checkpointEnvelope: null };
  }
  evidence.acceptanceProof = proofEnvelope.evidence;
  let integrationGate = null;
  if (typeof options.beforeCheckpointGate === "function") {
    integrationGate = await options.beforeCheckpointGate();
    evidence.integrationCommit = integrationGate;
    if (integrationGate?.pass !== true) {
      return { status: "revalidation_required", proofEnvelope, integrationGate, checkpointEnvelope: null };
    }
  }
  const checkpointEnvelope = await invokeCapability("checkpoint", { rootDir, planId, task, evidence });
  await emitGateDecision(rootDir, planId, task, checkpointEnvelope, options.runId);
  if (checkpointEnvelope.status !== "pass") {
    return { status: "checkpoint_failed", proofEnvelope, integrationGate, checkpointEnvelope };
  }
  return { status: "completed", proofEnvelope, integrationGate, checkpointEnvelope };
}

/**
 * Read back, from the persisted evidence trail, the outcome of every gate
 * the pipeline runs. Used by the single-step workflow so its "may this task
 * complete" precondition follows GATE_STEPS instead of a hand-maintained
 * list: adding a gate step here makes the node workflow require it too.
 *
 * Freshness rule (cross-review P0, 2026-07-21): a gate result only counts if
 * its evidence entry was appended AFTER the latest worker run. The evidence
 * array is append-only, so array order is execution order — gate evidence
 * sitting before the last worker entry belongs to a previous execution round
 * (e.g. a round whose checkpoint failed) and must not certify the current
 * round's artifacts. last_* convenience fields are deliberately NOT trusted
 * here for the same reason.
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

function buildStepContext(stepName, { rootDir, planId, task, evidence, options }) {
  switch (stepName) {
    case "verify":
      return { rootDir, task };
    case "scope":
      return {
        rootDir,
        task,
        options: { changedPaths: options.changedPaths, unavailableReason: options.unavailableReason },
      };
    case "review":
      return {
        rootDir,
        task,
        evidence: {
          workerResult: evidence.workerResult,
          verifyResult: evidence.verifyResult,
          scopeResult: evidence.scopeResult,
        },
      };
    case "acceptance-proof":
    case "checkpoint":
      return { rootDir, planId, task, evidence };
    default:
      return { rootDir, planId, task, evidence, options };
  }
}

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

function finalizePipelineResult(status, results, evidence, extra = {}) {
  const totalDurationMs = results.reduce((sum, result) => sum + (result.duration_ms || 0), 0);
  const totalCostAmount = results.reduce((sum, result) => sum + (result.cost?.amount || 0), 0);
  const costCurrency = results.find((result) => result.cost?.currency)?.cost?.currency || "CNY";
  return {
    status,
    error: status === "completed" ? null : pipelineErrorProtocol(status, results, extra),
    steps: results,
    evidence,
    criteria: extra.criteria || null,
    criterionEvidenceRecorded: extra.criterionEvidenceRecorded || [],
    totalDurationMs,
    totalCost: totalCostAmount > 0 ? { amount: totalCostAmount, currency: costCurrency } : null,
    summary: renderPipelineSummary(results, totalDurationMs, totalCostAmount, costCurrency),
  };
}

function pipelineErrorProtocol(status, results, extra) {
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

function formatDuration(ms) {
  if (typeof ms !== "number") return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
