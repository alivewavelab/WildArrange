// =============================================================================
// 文件名称：task-pull-request.mjs
// 所属模块：orchestration
// 作用说明：已完成且 task branch 已推送的任务 → 自动创建或更新同分支 Draft PR 的唯一 owner。
// 运行原理：读验收证明 → 确认已推送到托管远端 → 按 head branch 查打开的 PR，
//   没有则建 Draft，有则只更新正文 → 写 runtime:pull-requests/<planId>/<taskId>.json 与 ledger。
//   不改写任务台账；任何失败只入账并由 attention 提示 `pr sync`，绝不反完成。
// =============================================================================
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import { nowIso, readJson, resolveTaskAcceptancePath, resolveWildArrangePath, runtimeLogicalPath, writeJsonAtomic } from "../infra/runtime-store.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";
import { inspectGitDelivery } from "../infra/git-coordination.mjs";
import { createDraftPullRequest, findOpenPullRequest, isHostedRemote, updatePullRequestBody } from "../infra/pull-request.mjs";
import { resolveTaskRepositoryRoot } from "../infra/workspace-context.mjs";

/** 重试命令；attention 与失败记录共用。 */
export function pullRequestSyncHint(taskId) {
  return `node ./bin/wildarrange.mjs pr sync --task ${taskId}`;
}

/**
 * 为单个已完成任务同步 Draft PR；永不抛错。
 * @param {string} rootDir 项目根
 * @param {string} planId 计划 ID
 * @param {object} task 已完成任务
 * @param {{ proof?: object }} [options] proof 缺省时读取运行态验收证明
 * @returns {Promise<object>} status: created | updated | skipped | failed
 */
export async function syncTaskPullRequest(rootDir, planId, task, options = {}) {
  let record;
  try {
    record = await syncUnsafe(rootDir, planId, task, options.proof);
  } catch (error) {
    record = { status: "failed", reason: "unexpected_error", error: error instanceof Error ? error.message : String(error) };
  }
  const result = { kind: "task_pull_request", at: nowIso(), planId, taskId: task.id, ...record, ...(record.status === "failed" ? { retryHint: pullRequestSyncHint(task.id) } : {}) };
  // 未推送/非托管远端的跳过不留记录，避免覆盖此前成功的 PR 信息。
  if (result.status !== "skipped") {
    await writeJsonAtomic(recordPath(rootDir, planId, task.id), result).catch(() => {});
    await appendLedger(rootDir, { type: result.status === "failed" ? "task_pull_request_failed" : "task_pull_request_synced", planId, taskId: task.id, status: result.status, number: result.number ?? null, error: result.error ?? null }).catch(() => {});
  }
  return result;
}

/**
 * `pr sync`：同步一个或全部已完成任务的 Draft PR。
 * @param {{ taskId?: string }} [options]
 */
export async function syncPullRequests(rootDir, options = {}) {
  const taskState = await loadTaskState(rootDir);
  const tasks = (taskState?.tasks || []).filter((task) => task.status === "completed" && (!options.taskId || task.id === options.taskId));
  if (options.taskId && tasks.length === 0) throw new Error(`task ${options.taskId} is not a completed task in the active plan`);
  const results = [];
  for (const task of tasks) results.push(await syncTaskPullRequest(rootDir, taskState.planId, task));
  return { kind: "pull_request_sync", at: nowIso(), results };
}

/**
 * attention 用：现场仍在、最近一次 Draft PR 同步失败的已完成任务。
 */
export async function listPendingPullRequests(rootDir, planId, tasks) {
  const pending = [];
  if (!planId) return pending;
  for (const task of tasks) {
    if (task.status !== "completed" || !task.delivery_workspace?.workDir || !existsSync(task.delivery_workspace.workDir)) continue;
    const record = await readJson(recordPath(rootDir, planId, task.id), null).catch(() => null);
    if (record?.status !== "failed") continue;
    pending.push({ id: task.id, subject: task.subject, branch: task.delivery_workspace.branch || null, error: record.error || null, syncHint: pullRequestSyncHint(task.id) });
  }
  return pending;
}

async function syncUnsafe(rootDir, planId, task, proofInput) {
  const proof = proofInput || await readJson(resolveTaskAcceptancePath(rootDir, planId, task.id, "json"), null);
  if (!proof?.pass) return { status: "skipped", reason: "acceptance_not_passed" };
  const delivery = proof.evidenceRefs?.deliveryBaseline || {};
  if (delivery.pushed !== true || !delivery.branch) return { status: "skipped", reason: "not_pushed" };
  const repositoryRoot = resolveTaskRepositoryRoot(rootDir, task);
  const { config } = await loadWildArrangeConfig(rootDir);
  const gitContext = await inspectGitDelivery(repositoryRoot, config.gitDelivery || {});
  const remote = delivery.remote || gitContext.remote;
  if (!remote || !(await isHostedRemote(repositoryRoot, remote))) return { status: "skipped", reason: "remote_not_hosted" };
  const base = gitContext.integrationBranch || "main";
  const branch = delivery.branch;
  const bodyFile = recordPath(rootDir, planId, task.id).replace(/\.json$/, ".md");
  await mkdir(path.dirname(bodyFile), { recursive: true });
  await writeFile(bodyFile, renderPullRequestBody(planId, task, proof), "utf8");
  const facts = { branch, base, deliverySha: delivery.commitSha || null };

  const existing = await findOpenPullRequest(repositoryRoot, branch);
  if (!existing.ok) return { status: "failed", reason: "gh_failed", error: existing.error, ...facts };
  if (existing.pullRequest) {
    const updated = await updatePullRequestBody(repositoryRoot, existing.pullRequest.number, bodyFile);
    if (!updated.ok) return { status: "failed", reason: "gh_failed", error: updated.error, ...facts };
    return { status: "updated", ...existing.pullRequest, ...facts };
  }
  const created = await createDraftPullRequest(repositoryRoot, { base, head: branch, title: `[${task.id}] ${task.subject || task.id}`, bodyFile });
  if (!created.ok) return { status: "failed", reason: "gh_failed", error: created.error, ...facts };
  return { status: "created", ...created.pullRequest, ...facts };
}

/** PR 正文：验收结论、交付 SHA、检查项与待人工验收清单。 */
function renderPullRequestBody(planId, task, proof) {
  const checks = proof.checks || [];
  const delivery = proof.evidenceRefs?.deliveryBaseline || {};
  const manual = proof.manualAcceptance || [];
  return `## 验收结论

- 任务：${task.id} ${task.subject || ""}（计划 ${planId}）
- 结论：${proof.pass ? `通过，${checks.length} 项检查全部 pass` : "未通过"}
- 交付 commit：\`${delivery.commitSha || "unknown"}\`
- 验收报告：\`${runtimeLogicalPath("reports", "acceptance", planId, `${task.id}.md`)}\`

## 检查项

| 检查 | 结果 | 证据 |
| --- | --- | --- |
${checks.map((check) => `| ${check.name} | ${check.status} | ${String(check.evidence || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ")} |`).join("\n")}
${manual.length ? `
## 待人工验收项（合并前逐条核对）

${manual.map((item) => `- [ ] ${item.id} ${item.title}${item.expectedEvidence ? `：${item.expectedEvidence}` : ""}`).join("\n")}
` : ""}
---
本 PR 由 WildArrange 自动创建为 Draft；approve、转为 Ready 与 merge 由人类完成。
`;
}

/** 复用验收证明路径的 planId/taskId 段校验。 */
function recordPath(rootDir, planId, taskId) {
  resolveTaskAcceptancePath(rootDir, planId, taskId, "json");
  return resolveWildArrangePath(rootDir, "pull-requests", planId, `${taskId}.json`);
}
