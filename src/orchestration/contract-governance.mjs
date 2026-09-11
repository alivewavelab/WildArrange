import { readFile } from "node:fs/promises";
import path from "node:path";
import { invokeCapability } from "../capabilities/gateway.mjs";
import { hashContent } from "../infra/runtime-store.mjs";
import { readVerifiedLedgerEntries } from "../infra/ledger.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";
import { loadTaskState, normalizeTask } from "./plan-state.mjs";
import { persistTaskState } from "./task-board.mjs";
import { readChangeRequest, writeContractChangeRequest, recordContractChangeDecision, contractRequestFingerprint } from "./change-governance.mjs";

const digest = (value) => hashContent(JSON.stringify(value));
const itemsOf = (task) => task.contractChanges?.items || [];

// Approval is bound to the exact normalized declarations, not an editable
// worker-supplied boolean. Existing plan approval events are the authority.
async function approvedScope(rootDir, planId, task) {
  const fingerprint = digest(itemsOf(task));
  const events = await readVerifiedLedgerEntries(rootDir);
  if (events.some((event) => event.type === "plan_approved" && event.planId === planId
    && event.contractScopes?.[task.id] === fingerprint)) return true;
  if (!task.contractDecisionRef) return false;
  const request = await readChangeRequest(rootDir, task.contractDecisionRef);
  return request.planId === planId && request.taskId === task.id && request.status === "accepted"
    && request.fingerprint === contractRequestFingerprint(request)
    && digest(request.content.proposedDeclarations) === fingerprint
    && events.some((event) => event.type === "contract_change_decided" && event.changeRequestId === request.id
      && event.fingerprint === request.fingerprint && event.decision === "accept");
}

function candidateDeclaration(card) {
  const value = card.candidate || card.baseline;
  const sources = value?.source || {};
  return {
    contractId: card.contractId, kind: value?.kind || "manual", action: card.action,
    summary: value?.summary || value?.name || card.contractId,
    sourcePaths: [...new Set([...(sources.declarations || []), ...(sources.registrations || [])].map((item) => item.path))],
    expected: { signatures: (sources.declarations || []).map((item) => item.signature).filter(Boolean).sort() },
    compatibility: "需要主 Agent 评估兼容性", migration: "需要主 Agent 说明迁移影响", rollback: "保留原批准范围",
  };
}

function matchesApprovedDeclaration(item, card) {
  if (item.contractId !== card.contractId || item.action !== card.action) return false;
  if (card.action === "remove") return Boolean(item.compatibility && item.rollback);
  const candidate = card.candidate;
  if (!candidate || item.kind !== candidate.kind) return false;
  const paths = [...(candidate.source?.declarations || []), ...(candidate.source?.registrations || [])].map((entry) => entry.path);
  if (paths.some((p) => !(item.sourcePaths || []).includes(p))) return false;
  if (candidate.source?.discoverer === "tauri-ipc") {
    const signatures = (candidate.source.declarations || []).map((entry) => entry.signature).filter(Boolean).sort();
    return signatures.length > 0 && (candidate.source.registrations || []).length > 0
      && digest([...(item.expected?.signatures || [])].sort()) === digest(signatures);
  }
  // Manual database definitions are explicit declarations, not scanner proof.
  // Their implementation must still pass the task's independent verification.
  return Boolean(item.expected && Object.keys(item.expected).length && item.verificationRefs?.length);
}

async function scanTask(rootDir, task, executionRoot, evidence) {
  const result = await invokeCapability("contract-governance-scan", { rootDir: executionRoot,
    options: { write: false, inspectTask: task, evidence, controlRoot: rootDir } });
  if (result.status !== "pass") throw new Error(result.error?.message || "contract scan failed");
  return result.evidence;
}

// Invoked by the delivery owner under its task lock. Detection may block a
// task, but cannot manufacture human approval or rerun the worker.
export async function prepareContractReview(rootDir, planId, task, executionRoot, evidence) {
  let review = await scanTask(rootDir, task, executionRoot, evidence);
  const declared = itemsOf(task);
  // A command worker cannot call a task-locking CLI while run holds that
  // lock. It emits one proposal line and exits; the orchestrator owns intake.
  const line = String(evidence.workerResult?.stdout || "").split(/\r?\n/).find((value) => value.startsWith("WILDARRANGE_CONTRACT_CHANGE="));
  if (line) {
    const proposal = JSON.parse(line.slice("WILDARRANGE_CONTRACT_CHANGE=".length));
    const proposedDeclarations = normalizeProposal(task, proposal);
    if (digest(proposedDeclarations) !== digest(declared) || !await approvedScope(rootDir, planId, task)) {
      const request = await writeContractChangeRequest(rootDir, planId, task, {
        content: { proposedDeclarations, priorScopeFingerprint: digest(declared), cards: [], beforeImplementation: true },
        evidence: proposal.impact, rationale: proposal.reason, alternatives: proposal.alternatives, recommendation: proposal.recommendation,
      });
      task.pendingContractChange = request.id;
      task.status = "needs_user_decision";
      return { ...review, status: "fail", summary: "worker 提案等待人类决定", changeRequest: request };
    }
  }
  const changedPaths = evidence.scopeResult?.changedPaths || [];
  const cards = review.scan.cards.filter((card) => [card.candidate, card.baseline].some((value) =>
    [...(value?.source?.declarations || []), ...(value?.source?.registrations || []), ...(value?.source?.manualDeclarations || []), ...(value?.callers || [])]
      .some((entry) => changedPaths.includes(entry.path))) || declared.some((item) => item.contractId === card.contractId));
  const authorized = await approvedScope(rootDir, planId, task);
  const unexpected = cards.filter((card) => !authorized || !declared.some((item) => matchesApprovedDeclaration(item, card))
    || (card.action === "remove" && review.scan.observedContracts.some((item) => item.id === card.contractId)));
  const missingManual = review.findings.some((finding) => finding.code === "contract_manual_declaration_required");
  if (unexpected.length || missingManual || (declared.length && !authorized)) {
    const proposed = new Map(declared.map((item) => [item.contractId, item]));
    for (const card of unexpected) proposed.set(card.contractId, candidateDeclaration(card));
    const proposedDeclarations = normalizeTask({ ...task, contractChanges: { items: [...proposed.values()] } }).contractChanges.items;
    const request = await writeContractChangeRequest(rootDir, planId, task, {
      content: { proposedDeclarations, cards: cards.map(({ contractId, action, fingerprint, baseline, candidate }) => ({ contractId, action, fingerprint, baseline, candidate })),
        priorScopeFingerprint: digest(declared), manualRequired: review.scan.coverage.manualRequired },
      evidence: `检测到未被当前任务批准内容覆盖的契约变化：${unexpected.map((card) => card.contractId).join(", ") || "声明或数据库手工核查"}`,
      rationale: "主 Agent 必须说明新增接口/字段的必要性、兼容及迁移影响，并取得明确人类决定。扫描结果不是批准。",
      alternatives: "维持原批准范围；移除计划外变化；或拆成另一个任务。",
      recommendation: "先解释必要性和影响，等待开发者决定；不自动扩大范围。", changedPaths,
    });
    task.pendingContractChange = request.id;
    task.status = "needs_user_decision";
    return { ...review, status: "fail", summary: "计划外契约变更等待人类决定", changeRequest: request };
  }
  if (authorized) {
    // The registry is a versioned baseline, not scratch state. Review never
    // writes it (especially not into another worktree). Exact approved task
    // deltas explain pending cards; formal registration remains apply-card.
    const covered = new Set(cards.map((card) => card.id));
    review.findings = review.findings.filter((finding) => finding.code !== "contract_destructive_approval_missing"
      && !(finding.code === "contract_cards_pending" && finding.cards.every((id) => covered.has(id)))
      && !(finding.code === "contract_baseline_required" && cards.length > 0));
    review.status = review.findings.length ? "fail" : "pass";
    review.pendingRegistryUpdates = cards.map((card) => ({ id: card.id, contractId: card.contractId, fingerprint: card.fingerprint }));
  }
  return review;
}

export async function applyContractDecision(rootDir, options) {
  if (!["approve", "reject"].includes(options.decision) || !options.expectedFingerprint || !String(options.reason || "").trim()) {
    throw new Error("a current contract fingerprint and explicit decision reason are required");
  }
  return invokeCapability("contract-governance-apply-card", { rootDir, options });
}

export async function proposeContractChange(rootDir, options) {
  return withTaskStateLock(rootDir, "contract-change-propose", async () => {
    const state = await loadTaskState(rootDir);
    const task = state?.tasks.find((entry) => entry.id === options.taskId);
    if (!task || task.status === "completed") throw new Error("an unfinished current task is required");
    const proposal = JSON.parse(await readFile(path.resolve(rootDir, options.from), "utf8"));
    const proposedDeclarations = normalizeProposal(task, proposal);
    const request = await writeContractChangeRequest(rootDir, state.planId, task, {
      content: { proposedDeclarations, priorScopeFingerprint: digest(itemsOf(task)), cards: [] },
      evidence: proposal.impact, rationale: proposal.reason, alternatives: proposal.alternatives, recommendation: proposal.recommendation,
    });
    task.pendingContractChange = request.id;
    task.status = "needs_user_decision";
    await persistTaskState(rootDir, state);
    return { status: "awaiting_user_decision", request };
  });
}

export async function resolveContractChange(rootDir, options) {
  return withTaskStateLock(rootDir, "contract-change-resolve", async () => {
    const before = await readChangeRequest(rootDir, options.id);
    const state = await loadTaskState(rootDir);
    const task = state?.planId === before.planId && state.tasks.find((entry) => entry.id === before.taskId);
    if (task?.contractDecisionRef === before.id && !task.pendingContractChange && before.status === "accepted") {
      const request = await recordContractChangeDecision(rootDir, options);
      return { status: request.status, request, task };
    }
    if (!task || task.pendingContractChange !== before.id) throw new Error("request is not the task's current pending contract change");
    if (task.admission_claim && task.admission_claim.workspaceRestored !== true) throw new Error("admission recovery required: restore the shared workspace with the original run before deciding");
    if (before.status === "open" && digest(itemsOf(task)) !== before.content.priorScopeFingerprint) throw new Error("task scope changed after proposal; prepare a new request");
    const request = await recordContractChangeDecision(rootDir, options);
    if (request.status === "accepted") {
      task.contractChanges = { declared: request.content.proposedDeclarations.length > 0, items: request.content.proposedDeclarations };
      task.contractDecisionRef = request.id;
      task.pendingContractChange = null;
      // A retained admission must resume its own transaction; a linear task
      // with a successful worker rechecks gates instead of rerunning it.
      task.status = task.admission_claim || (task.last_verify_result && !request.content.beforeImplementation) ? "verifying" : "pending";
    } else {
      task.status = "needs_user_decision";
      // The admission owner proved rollback before offering the decision.
      if (task.admission_claim?.workspaceRestored === true) task.admission_claim = null;
      // Rejection is not permission to retry the same unapproved changes.
    }
    await persistTaskState(rootDir, state);
    return { status: request.status, request, task };
  });
}

function normalizeProposal(task, proposal) {
  for (const key of ["reason", "impact", "alternatives", "recommendation"]) {
    if (typeof proposal[key] !== "string" || !proposal[key].trim()) throw new Error(`contract proposal requires ${key}`);
  }
  if (!Array.isArray(proposal.items) || !proposal.items.length) throw new Error("contract proposal requires nonempty items");
  return normalizeTask({ ...task, contractChanges: { items: proposal.items } }).contractChanges.items;
}
