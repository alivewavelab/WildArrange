// =============================================================================
// 文件名称：change-governance.mjs
// 所属模块：orchestration
// 作用说明：
//   ChangeRequest 存储与裁决：scope 越界 CR、契约变更 CR 的写入/索引/审阅/resolve。
//   计划 steering 见 plan-steering，review blocker 见 review-blocker。
// =============================================================================
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LEAD_AGENT, normalizeAgentKey } from "../infra/agent-registry.mjs";
import { appendLedger, readVerifiedLedgerEntries } from "../infra/ledger.mjs";
import {
  ensureWildArrangeDirs,
  hashContent,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { transactWithLedger, withTaskStateLock } from "../infra/task-state-lock.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { uniqueStrings } from "../infra/text-utils.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { persistTaskState } from "./task-board.mjs";

/** 读取并渲染 ChangeRequest 供人类 review。 */
export async function reviewChangeRequest(rootDir, id) {
  const changeRequest = await readChangeRequest(rootDir, id);
  const reasons = [];
  if (changeRequest.kind !== "change_request") reasons.push("invalid kind");
  if (changeRequest.status !== "open") reasons.push(`change request is ${changeRequest.status}`);
  if (!changeRequest.evidence || !changeRequest.rationale) reasons.push("missing evidence or rationale");
  if (changeRequest.invariants?.autoApply !== false) reasons.push("autoApply invariant must be false");
  if (changeRequest.invariants?.requiresLeadReview !== true) {
    reasons.push("requiresLeadReview invariant must be true");
  }
  if (changeRequest.invariants?.mustNotWeakenVerification !== true) reasons.push("mustNotWeakenVerification invariant must be true");
  if (hasWeakeningLanguage(`${changeRequest.evidence}\n${changeRequest.rationale}`)) reasons.push("proposal appears to weaken verification");

  const audit = {
    kind: "change_request_review",
    at: nowIso(),
    id: changeRequest.id,
    status: reasons.length === 0 ? "reviewable" : "blocked",
    reviewer: DEFAULT_LEAD_AGENT,
    reasons,
    allowedDecisions: reasons.length === 0 ? ["accept", "reject"] : [],
    invariant: {
      accepted: reasons.length === 0,
      evidenceBackedNecessity: Boolean(changeRequest.evidence && changeRequest.rationale),
      noAutomaticScopeExpansion: changeRequest.invariants?.autoApply === false,
      noWeakenedVerification: !hasWeakeningLanguage(`${changeRequest.evidence}\n${changeRequest.rationale}`),
    },
    changeRequest,
  };
  await appendLedger(rootDir, {
    type: "change_request_reviewed",
    changeRequestId: changeRequest.id,
    status: audit.status,
    reasons,
  });
  return audit;
}

/** 人类 accept/reject scope ChangeRequest 并更新任务状态。 */
export async function resolveChangeRequest(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `change-resolve:${options.id || "unknown"}`, () => resolveChangeRequestUnlocked(rootDir, options));
}

/** 按 id 读取 ChangeRequest JSON 记录。 */
export async function readChangeRequest(rootDir, id) {
  if (!/^CR-[a-z0-9]+$/i.test(id || "")) throw new Error(`invalid change request id: ${id}`);
  const changeRequest = await readJson(resolveWildArrangePath(rootDir, "changes", `${id}.json`), null);
  if (!changeRequest) throw new Error(`unknown change request: ${id}`);
  return changeRequest;
}

/** 锁内解析 ChangeRequest accept/reject 并更新任务状态。 */
async function resolveChangeRequestUnlocked(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const id = options.id;
  if (!id || typeof id !== "string") throw new Error("change request id is required");
  const decision = normalizeDecision(options.decision);
  if (!decision) throw new Error("decision must be accept or reject");
  const evidence = typeof options.evidence === "string" ? options.evidence.trim() : "";
  const rationale = typeof options.rationale === "string" ? options.rationale.trim() : "";
  if (!evidence) throw new Error("decision evidence is required");
  if (!rationale) throw new Error("decision rationale is required");
  if (hasWeakeningLanguage(`${evidence}\n${rationale}`)) {
    throw new Error("decision appears to weaken verification; keep verification/review gates intact");
  }

  const changeRequest = await readChangeRequest(rootDir, id);
  if (changeRequest.source === "contract_change") throw new Error("use contracts resolve for a content-bound human contract decision");
  if (changeRequest.status !== "open") throw new Error(`change request ${id} is already ${changeRequest.status}`);
  const taskState = await loadTaskState(rootDir);
  const task = taskState?.planId === changeRequest.planId
    ? taskState.tasks.find((candidate) => candidate.id === changeRequest.taskId)
    : null;
  const now = nowIso();

  changeRequest.status = decision === "accept" ? "accepted" : "rejected";
  changeRequest.decision = decision;
  changeRequest.reviewedAt = now;
  changeRequest.updatedAt = now;
  changeRequest.reviewer = normalizeAgentKey(options.reviewer || DEFAULT_LEAD_AGENT);
  changeRequest.decisionEvidence = evidence;
  changeRequest.decisionRationale = rationale;
  changeRequest.appliedScope = false;
  changeRequest.decisionInvariant = {
    accepted: true,
    explicitDecisionOnly: true,
    noAutomaticScopeExpansion: true,
    mustNotWeakenVerification: true,
  };

  if (task) {
    task.change_resolution = {
      id,
      decision,
      appliedScope: false,
      at: now,
      evidence,
      rationale,
    };
    if (task.last_failure) task.last_failure.resolvedBy = id;
  }

  if (decision === "accept" && options.applyScope === true) {
    if (!task) throw new Error(`task ${changeRequest.taskId} not found for change request ${id}`);
    task.writable_paths = uniqueStrings([...(task.writable_paths || []), ...(changeRequest.deniedPaths || [])]);
    task.change_resolution.appliedScope = true;
    task.last_scope_result = null;
    changeRequest.appliedScope = true;
    changeRequest.appliedWritablePaths = task.writable_paths;
  }

  const jsonPath = resolveWildArrangePath(rootDir, "changes", `${id}.json`);
  const mdPath = resolveWildArrangePath(rootDir, "changes", `${id}.md`);
  changeRequest.reportJsonPath = path.relative(rootDir, jsonPath);
  changeRequest.reportMdPath = path.relative(rootDir, mdPath);
  await transactWithLedger(rootDir, {
    type: "change_request_resolved",
    planId: changeRequest.planId,
    taskId: changeRequest.taskId,
    changeRequestId: id,
    decision,
    appliedScope: changeRequest.appliedScope,
  }, async () => {
    if (taskState && task) await persistTaskState(rootDir, taskState);
    await writeJsonAtomic(jsonPath, changeRequest);
    await writeFile(mdPath, renderChangeRequestMarkdown(changeRequest), "utf8");
    await writeOpenChangesIndex(rootDir);
  });
  await writeSnapshot(rootDir, "change_request_resolved", { changeRequestId: id, decision, appliedScope: changeRequest.appliedScope });
  return { status: changeRequest.status, changeRequest, task: task || null };
}

/** 检测文本是否含弱化 gate/验收的措辞。 */
export function hasWeakeningLanguage(value) {
  return /\b(skip|bypass|weaken|remove|omit|auto[-\s]?complete|mark complete|complete faster)\b/i.test(value)
    && /\b(test|tests|verification|review|quality gate|complete|completion)\b/i.test(value);
}

/** 归一化人类决定字符串为 accept/reject。 */
function normalizeDecision(decision) {
  if (decision === "accept" || decision === "accepted") return "accept";
  if (decision === "reject" || decision === "rejected") return "reject";
  return null;
}


/** 由 scope 结果创建 scope ChangeRequest 并写报告。 */
export async function writeChangeRequest(rootDir, planId, task, scopeResult, source = "scope_guard") {
  await ensureWildArrangeDirs(rootDir);
  const signature = hashContent(JSON.stringify({
    planId,
    taskId: task.id,
    deniedPaths: scopeResult.deniedPaths || [],
    writablePaths: scopeResult.writablePaths || task.writable_paths || [],
  })).slice(0, 12);
  const id = `CR-${signature}`;
  const jsonPath = resolveWildArrangePath(rootDir, "changes", `${id}.json`);
  const mdPath = resolveWildArrangePath(rootDir, "changes", `${id}.md`);
  const existing = await readJson(jsonPath, null);
  const changeRequest = existing || {
    id,
    kind: "change_request",
    status: "open",
    source,
    planId,
    taskId: task.id,
    subject: task.subject,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    evidence: `scope guard denied paths: ${(scopeResult.deniedPaths || []).join(", ") || "unknown"}`,
    rationale: "Worker changed files outside task.writable_paths; Jiuwei/DiJiang must decide whether to revise scope or reject the change.",
    deniedPaths: scopeResult.deniedPaths || [],
    changedPaths: scopeResult.changedPaths || [],
    writablePaths: scopeResult.writablePaths || task.writable_paths || [],
    proposedActions: [
      "revert_or_move_out_of_scope_changes",
      "revise_plan_writable_paths_after_review",
      "split_into_new_task",
    ],
    invariants: {
      autoApply: false,
      requiresLeadReview: true,
      mustNotWeakenVerification: true,
    },
  };
  if (existing) {
    changeRequest.updatedAt = nowIso();
    changeRequest.lastSeenSource = source;
  }
  changeRequest.reportJsonPath = path.relative(rootDir, jsonPath);
  changeRequest.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, changeRequest);
  await writeFile(mdPath, renderChangeRequestMarkdown(changeRequest), "utf8");
  await writeOpenChangesIndex(rootDir);
  await appendLedger(rootDir, {
    type: existing ? "change_request_reused" : "change_request_created",
    planId,
    taskId: task.id,
    changeRequestId: id,
    deniedPaths: changeRequest.deniedPaths,
    reportPath: changeRequest.reportMdPath,
  });
  return changeRequest;
}

/** 将 ChangeRequest 渲染为 Markdown 报告正文。 */
function renderChangeRequestMarkdown(changeRequest) {
  return `# ChangeRequest ${changeRequest.id}

| Field | Value |
| --- | --- |
| Status | \`${changeRequest.status}\` |
| Source | \`${changeRequest.source}\` |
| Plan | \`${changeRequest.planId}\` |
| Task | \`${changeRequest.taskId}\` |
| Subject | ${changeRequest.subject} |

## Evidence

${changeRequest.evidence}

## Rationale

${changeRequest.rationale}

${changeRequest.decision ? `## Decision

- Reviewer: ${changeRequest.reviewer || DEFAULT_LEAD_AGENT}
- Decision: \`${changeRequest.decision}\`
- Reviewed at: ${changeRequest.reviewedAt}
- Applied scope: ${Boolean(changeRequest.appliedScope)}

### Decision Evidence

${changeRequest.decisionEvidence}

### Decision Rationale

${changeRequest.decisionRationale}
` : ""}

## Paths

- Writable: ${changeRequest.writablePaths.join(", ") || "(none)"}
- Changed: ${changeRequest.changedPaths.join(", ") || "(none)"}
- Denied: ${changeRequest.deniedPaths.join(", ") || "(none)"}
${changeRequest.appliedWritablePaths ? `- Applied writable paths: ${changeRequest.appliedWritablePaths.join(", ") || "(none)"}` : ""}

## Allowed Resolutions

${changeRequest.proposedActions.map((action) => `- ${action}`).join("\n")}

## Invariants

- autoApply: ${changeRequest.invariants.autoApply}
- requiresLeadReview: ${changeRequest.invariants.requiresLeadReview}
- mustNotWeakenVerification: ${changeRequest.invariants.mustNotWeakenVerification}
`;
}

/** 刷新 open changes 索引文件供 dashboard 使用。 */
async function writeOpenChangesIndex(rootDir) {
  const changes = await listChangeRequests(rootDir);
  const openChanges = changes.filter((change) => change.status === "open");
  const lines = ["# Open ChangeRequests", ""];
  if (openChanges.length === 0) {
    lines.push("No open change requests.");
  } else {
    for (const change of openChanges) {
      lines.push(`- ${change.id}: ${change.subject}`);
      lines.push(`  - Task: ${change.taskId}`);
      lines.push(`  - Denied: ${(change.deniedPaths || []).join(", ") || "(none)"}`);
      lines.push(`  - Report: ${change.reportMdPath}`);
    }
  }
  await writeFile(resolveWildArrangePath(rootDir, "changes", "open.md"), `${lines.join("\n")}\n`, "utf8");
}

// Called under the task-state lock by the contract workflow. Changes keep one
// authoritative JSON record; task state contains only a reference to it.

/** 创建契约类 ChangeRequest（contract_change 来源）。 */
export async function writeContractChangeRequest(rootDir, planId, task, proposal) {
  const fingerprint = contractRequestFingerprint(proposal);
  const id = `CR-${hashContent(`${planId}/${task.id}/${fingerprint}`).slice(0, 24)}`;
  const file = resolveWildArrangePath(rootDir, "changes", `${id}.json`);
  const existing = await readJson(file, null);
  if (existing) return existing;
  const record = {
    id, kind: "change_request", source: "contract_change", status: "open",
    planId, taskId: task.id, subject: task.subject, fingerprint,
    createdAt: nowIso(), updatedAt: nowIso(),
    evidence: proposal.evidence, rationale: proposal.rationale,
    content: proposal.content, alternatives: proposal.alternatives,
    recommendation: proposal.recommendation,
    deniedPaths: [], changedPaths: proposal.changedPaths || [], writablePaths: task.writable_paths || [],
    proposedActions: ["human_accept_exact_contract_change", "human_reject_and_use_alternative"],
    invariants: { autoApply: false, requiresLeadReview: true, mustNotWeakenVerification: true },
    reportJsonPath: path.relative(rootDir, file),
    reportMdPath: path.relative(rootDir, resolveWildArrangePath(rootDir, "changes", `${id}.md`)),
  };
  await persistContractRequest(rootDir, record);
  await appendLedger(rootDir, { type: "contract_change_requested", planId, taskId: task.id, changeRequestId: id, fingerprint });
  return record;
}

/** 记录人类对契约 ChangeRequest 的 accept/reject 决策。 */
export async function recordContractChangeDecision(rootDir, options) {
  const request = await readChangeRequest(rootDir, options.id);
  if (request.source !== "contract_change" || request.fingerprint !== options.expectedFingerprint
    || request.fingerprint !== contractRequestFingerprint(request)) throw new Error("contract request changed; review the current content before deciding");
  if (!["accept", "reject"].includes(options.decision) || !String(options.reason || "").trim()) throw new Error("explicit accept/reject and reason are required");
  const status = options.decision === "accept" ? "accepted" : "rejected";
  if (request.status !== "open") {
    if (request.status !== status) throw new Error("contract request already has a different decision");
  } else {
    request.status = status;
    request.decision = options.decision;
    request.decisionReason = String(options.reason).trim();
    request.decidedAt = nowIso();
    request.updatedAt = request.decidedAt;
    await persistContractRequest(rootDir, request);
  }
  const events = await readVerifiedLedgerEntries(rootDir);
  if (!events.some((event) => event.type === "contract_change_decided" && event.changeRequestId === request.id
    && event.fingerprint === request.fingerprint && event.decision === request.decision)) {
    await appendLedger(rootDir, { type: "contract_change_decided", planId: request.planId, taskId: request.taskId,
      changeRequestId: request.id, fingerprint: request.fingerprint, decision: request.decision });
  }
  return request;
}

/** 持久化契约 ChangeRequest 到 .wildarrange/changes。 */
async function persistContractRequest(rootDir, record) {
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "changes", `${record.id}.json`), record);
  await writeFile(resolveWildArrangePath(rootDir, "changes", `${record.id}.md`),
    `${renderChangeRequestMarkdown(record)}\n## Contract decision\n\n${record.decisionReason || "等待人类决定"}\n\n${JSON.stringify(record.content, null, 2)}\n\n替代方案：${record.alternatives}\n建议：${record.recommendation}\n`, "utf8");
  await writeOpenChangesIndex(rootDir);
}

/** 计算契约 ChangeRequest 内容指纹，供 resolve 时校验。 */
export function contractRequestFingerprint(request) {
  return hashContent(JSON.stringify({ content: request.content, evidence: request.evidence,
    rationale: request.rationale, alternatives: request.alternatives, recommendation: request.recommendation }));
}

/** 列出所有 ChangeRequest 记录（含 open 与已决议）。 */
export async function listChangeRequests(rootDir) {
  await ensureWildArrangeDirs(rootDir);
  let entries = [];
  try {
    entries = await readdir(resolveWildArrangePath(rootDir, "changes"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const changes = [];
  for (const entry of entries.filter((name) => /^CR-.+\.json$/.test(name)).sort()) {
    changes.push(await readJson(resolveWildArrangePath(rootDir, "changes", entry)));
  }
  return changes;
}
