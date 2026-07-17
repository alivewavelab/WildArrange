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
import { applyVerifierEvidenceToCriteria, criteriaStatus } from "../helix-team.mjs";

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

  const proofEnvelope = await invokeCapability(
    "acceptance-proof",
    buildStepContext("acceptance-proof", { rootDir, planId, task, evidence, options }),
  );
  results.push(proofEnvelope);
  recordStepEvidence("acceptance-proof", evidence, proofEnvelope, task);

  if (proofEnvelope.status !== "pass") {
    return finalizePipelineResult("blocked", results, evidence, { criteria, criterionEvidenceRecorded });
  }

  const checkpointEnvelope = await invokeCapability(
    "checkpoint",
    buildStepContext("checkpoint", { rootDir, planId, task, evidence, options }),
  );
  results.push(checkpointEnvelope);

  return finalizePipelineResult("completed", results, evidence, { criteria, criterionEvidenceRecorded });
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
