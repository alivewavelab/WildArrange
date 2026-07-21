/**
 * Shared delivery pipeline: the one place that owns gate order.
 *
 * Both the linear runtime and the parallel-agent admission path are meant
 * to call this instead of re-implementing the verify -> scope -> review ->
 * acceptance-proof -> checkpoint sequence themselves. Changing gate order,
 * or inserting a new gate, only happens here.
 *
 * Faithfully mirrors the existing gating semantics in helix-node-runtime.mjs:
 * verify / scope / review always run in full (no early bail between them so
 * every gate's evidence is always collected), and acceptance-proof +
 * checkpoint only run if every prior gate (worker, verify, criteria, scope,
 * review) already passed.
 */
import { invokeCapability } from "../capabilities/gateway.mjs";
import { applyVerifierEvidenceToCriteria, criteriaStatus } from "../infra/success-criteria.mjs";

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
  }

  const criteria = criteriaStatus(task);
  const workerExitOk = evidence.workerResult ? evidence.workerResult.exitCode === 0 : true;
  const gatesAllPass = workerExitOk && criteria.pass && results.every((result) => result.status === "pass");

  if (!gatesAllPass) {
    return finalizePipelineResult("blocked", results, evidence, { criteria, criterionEvidenceRecorded });
  }

  const completion = await runCompletionSegment(rootDir, planId, task, evidence);
  results.push(completion.proofEnvelope);
  recordStepEvidence("acceptance-proof", evidence, completion.proofEnvelope, task);

  if (completion.status === "proof_failed") {
    return finalizePipelineResult("blocked", results, evidence, { criteria, criterionEvidenceRecorded });
  }

  results.push(completion.checkpointEnvelope);
  if (completion.status === "checkpoint_failed") {
    evidence.checkpointError = completion.checkpointEnvelope.error || { code: "checkpoint_failed", message: "checkpoint capability did not pass" };
    return finalizePipelineResult("checkpoint_failed", results, evidence, { criteria, criterionEvidenceRecorded });
  }

  return finalizePipelineResult("completed", results, evidence, { criteria, criterionEvidenceRecorded });
}

/**
 * The completion segment (acceptance-proof -> checkpoint) shared by the
 * pipeline above and by the single-step `node checkpoint` workflow, so
 * completion semantics have exactly one definition. A task may only become
 * `completed` when this returns status "completed": a failed or throwing
 * checkpoint write must never be silently absorbed (the gateway converts
 * throws into fail envelopes; we check the envelope status here).
 */
export async function runCompletionSegment(rootDir, planId, task, evidence) {
  const proofEnvelope = await invokeCapability("acceptance-proof", { rootDir, planId, task, evidence });
  if (proofEnvelope.status !== "pass") {
    return { status: "proof_failed", proofEnvelope, checkpointEnvelope: null };
  }
  evidence.acceptanceProof = proofEnvelope.evidence;
  const checkpointEnvelope = await invokeCapability("checkpoint", { rootDir, planId, task, evidence });
  if (checkpointEnvelope.status !== "pass") {
    return { status: "checkpoint_failed", proofEnvelope, checkpointEnvelope };
  }
  return { status: "completed", proofEnvelope, checkpointEnvelope };
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
  if (stepName === "verify") {
    evidence.verifyResult = envelope.evidence;
    // Mirrors helix-node-runtime.mjs: a passing verifier can auto-satisfy
    // successCriteria that declare verifierCommandRefs, so criteriaStatus()
    // reflects it without a separate manual step. The caller (orchestration)
    // still owns deciding whether this is ledger-worthy.
    return applyVerifierEvidenceToCriteria(task, envelope.evidence);
  }
  if (stepName === "scope") evidence.scopeResult = envelope.evidence;
  if (stepName === "review") evidence.reviewResult = envelope.evidence;
  if (stepName === "acceptance-proof") evidence.acceptanceProof = envelope.evidence;
  return undefined;
}

function finalizePipelineResult(status, results, evidence, extra = {}) {
  const totalDurationMs = results.reduce((sum, result) => sum + (result.duration_ms || 0), 0);
  const totalCostAmount = results.reduce((sum, result) => sum + (result.cost?.amount || 0), 0);
  const costCurrency = results.find((result) => result.cost?.currency)?.cost?.currency || "CNY";
  return {
    status,
    steps: results,
    evidence,
    criteria: extra.criteria || null,
    criterionEvidenceRecorded: extra.criterionEvidenceRecorded || [],
    totalDurationMs,
    totalCost: totalCostAmount > 0 ? { amount: totalCostAmount, currency: costCurrency } : null,
    summary: renderPipelineSummary(results, totalDurationMs, totalCostAmount, costCurrency),
  };
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
