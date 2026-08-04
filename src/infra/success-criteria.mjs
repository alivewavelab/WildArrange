/**
 * Pure success-criteria state machine for a task. Needed by both
 * orchestration (task-board, delivery-pipeline) and capabilities
 * (review-gate, acceptance-proof) to answer "did this task's declared
 * criteria pass", so it lives in infra rather than either side.
 */
import { nowIso } from "./runtime-store.mjs";

export function criteriaStatus(task) {
  const criteria = task.successCriteria || [];
  if (criteria.length === 0) return { total: 0, passed: 0, failed: 0, pending: 0, pass: true };
  const passed = criteria.filter((criterion) => criterion.status === "pass").length;
  const failed = criteria.filter((criterion) => criterion.status === "fail").length;
  const pending = criteria.filter((criterion) => criterion.status === "pending").length;
  return { total: criteria.length, passed, failed, pending, pass: failed === 0 && pending === 0 && passed === criteria.length };
}

export function applyVerifierEvidenceToCriteria(task, verifyResult) {
  if (!verifyResult?.pass) return [];
  const recorded = [];
  for (const criterion of task.successCriteria || []) {
    if (criterion.status === "pass") continue;
    const matchedCommands = matchedVerifierCommands(criterion, task.verify_commands || [], verifyResult.results || []);
    if (matchedCommands.length === 0) continue;
    const entry = {
      kind: "criterion_evidence",
      at: nowIso(),
      taskId: task.id,
      criterionId: criterion.id,
      status: "pass",
      source: "verifier",
      evidence: `Verifier passed explicitly bound command(s): ${matchedCommands.join(" && ")}`,
      verifierCommandRefs: criterion.verifierCommandRefs || [],
    };
    criterion.status = "pass";
    criterion.evidence = [...(criterion.evidence || []), entry];
    criterion.lastUpdatedAt = entry.at;
    task.evidence.push(entry);
    recorded.push(entry);
  }
  return recorded;
}

function matchedVerifierCommands(criterion, verifyCommands, results) {
  const refs = Array.isArray(criterion?.verifierCommandRefs) ? criterion.verifierCommandRefs : [];
  if (refs.length === 0) return [];
  const passedCommands = new Set(results.filter((result) => result.exitCode === 0).map((result) => result.command));
  const matched = [];
  for (const ref of refs) {
    const command = /^\d+$/.test(String(ref)) ? verifyCommands[Number(ref)] : String(ref);
    if (!command || !passedCommands.has(command)) return [];
    matched.push(command);
  }
  return matched;
}
