// =============================================================================
// 文件名称：memory-digest.mjs
// 所属模块：infra
// 作用说明：
//   任务/路由/ledger 进度快照写入 memory/digests 供 Archivist 消费。
//
// 【运行原理速读】
//   buildMemoryDigest 聚合 → writeJsonAtomic + markdown → digest-index 更新。
// =============================================================================
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "./ledger.mjs";
import { readGitHead } from "./git-diff.mjs";
import {
  createWorkId,
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveLegacyTaskCheckpointPath,
  resolveWildArrangePath,
  resolveTaskCheckpointPath,
  writeJsonAtomic,
} from "./runtime-store.mjs";
import { loadTaskState } from "./task-state-store.mjs";

/**
 * writeMemoryDigest：本模块对外异步 API。
 */
export async function writeMemoryDigest(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const digest = await buildMemoryDigest(rootDir, options);
  const fileStem = `${digest.at.replace(/[:.]/g, "-")}-${sanitizeSegment(digest.reason)}`;
  const jsonPath = resolveWildArrangePath(rootDir, "memory", "digests", `${fileStem}.json`);
  const mdPath = resolveWildArrangePath(rootDir, "memory", "digests", `${fileStem}.md`);
  digest.reportJsonPath = path.relative(rootDir, jsonPath);
  digest.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, digest);
  await writeFile(mdPath, renderDigestMarkdown(digest), "utf8");
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "memory", "last-digest.json"), digest);
  await updateDigestIndex(rootDir, digest);
  await appendLedger(rootDir, {
    type: "memory_digest_written",
    reason: digest.reason,
    stage: digest.stage,
    taskId: digest.task?.id || null,
    reportPath: digest.reportMdPath,
  });
  return digest;
}

/**
 * buildMemoryDigest：本模块对外异步 API。
 */
export async function buildMemoryDigest(rootDir, options = {}) {
  const taskState = await loadTaskState(rootDir).catch(() => null);
  const task = options.task || (options.taskId && taskState?.tasks?.find((candidate) => candidate.id === options.taskId)) || null;
  const work = await readJson(resolveWildArrangePath(rootDir, "work.json"), null);
  const latestArchivist = await readJson(resolveWildArrangePath(rootDir, "memory", "last-archivist-result.json"), null);
  const route = options.route || latestArchivist?.decision?.routeDecision || null;
  const checkpoint = taskState && task
    ? await readTaskCheckpoint(rootDir, taskState.planId, task.id)
    : null;
  const ledgerTail = await readLedgerTail(rootDir, Number(options.ledgerLimit) || 20);
  const gitHead = await readDigestGitHead(rootDir);
  const stage = options.stage || route?.route || work?.stage || "default";
  return {
    kind: "memory_digest",
    id: createWorkId("digest"),
    at: nowIso(),
    reason: options.reason || "manual",
    stage,
    gitHead,
    work: work ? { workId: work.workId, stage: work.stage, status: work.status, activePlanId: work.activePlanId } : null,
    planId: taskState?.planId || null,
    task: task ? summarizeTask(task) : null,
    route: route ? {
      intent: route.intent,
      route: route.route,
      domain: route.domain,
      category: route.category,
      confidence: route.confidence ?? null,
      risk: route.risk,
    } : null,
    progress: progressFromLedger(ledgerTail, task),
    decisions: decisionsFromTask(task, checkpoint, latestArchivist),
    artifacts: artifactRefs(taskState?.planId || null, task, checkpoint),
    implementationNotes: implementationNotes(task),
    researchNotes: normalizeList(options.researchNotes),
    pitfalls: pitfallsFromTask(task),
    openQuestions: normalizeList(options.openQuestions),
  };
}

/**
 * updateDigestIndex 内部辅助。
 */
async function updateDigestIndex(rootDir, digest) {
  const indexPath = resolveWildArrangePath(rootDir, "memory", "digest-index.json");
  const index = await readJson(indexPath, { version: 1, digests: [], keywords: {} });
  index.digests.unshift({
    id: digest.id,
    at: digest.at,
    reason: digest.reason,
    stage: digest.stage,
    taskId: digest.task?.id || null,
    path: digest.reportJsonPath,
  });
  index.digests = index.digests.slice(0, 200);
  for (const keyword of digestKeywords(digest)) {
    index.keywords[keyword] = (index.keywords[keyword] || 0) + 1;
  }
  index.updatedAt = nowIso();
  await writeJsonAtomic(indexPath, index);
}

/**
 * 读取 LedgerTail 并返回结构化结果。
 */
async function readLedgerTail(rootDir, limit) {
  try {
    const content = await readJsonLines(resolveWildArrangePath(rootDir, "ledger.jsonl"));
    return content.slice(-limit);
  } catch {
    return [];
  }
}

/**
 * 读取 JsonLines 并返回结构化结果。
 */
async function readJsonLines(filePath) {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(filePath, "utf8");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * 读取 DigestGitHead 并返回结构化结果。
 */
async function readDigestGitHead(rootDir) {
  const current = await readGitHead(rootDir);
  if (current.available && current.sha) {
    return { value: current.sha, source: "git" };
  }
  const head = await readJson(resolveWildArrangePath(rootDir, "routing", "archivist-trigger-state.json"), null);
  return head?.lastGitHead ? { value: head.lastGitHead, source: "archivist-trigger-state" } : null;
}

/**
 * 汇总 Task 为摘要。
 */
function summarizeTask(task) {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    category: task.category,
    attempts: task.attempts,
    writable_paths: task.writable_paths || [],
    verify_commands: task.verify_commands || [],
  };
}

/**
 * progressFromLedger 内部辅助。
 */
function progressFromLedger(events, task) {
  const taskId = task?.id;
  return events
    .filter((event) => !taskId || !event.taskId || event.taskId === taskId)
    .map((event) => `${event.type}${event.taskId ? ` ${event.taskId}` : ""}${event.status || event.nextStatus ? ` ${event.status || event.nextStatus}` : ""}`)
    .slice(-8);
}

/**
 * decisionsFromTask 内部辅助。
 */
function decisionsFromTask(task, checkpoint, latestArchivist) {
  return [
    task?.last_review_result?.pass === true ? "review gate passed" : "",
    checkpoint ? "checkpoint written" : "",
    latestArchivist?.decision?.summary ? latestArchivist.decision.summary : "",
  ].filter(Boolean).slice(0, 8);
}

/**
 * artifactRefs 内部辅助。
 */
function artifactRefs(planId, task, checkpoint) {
  return [
    checkpoint?.reportJsonPath || (planId && task?.id
      ? path.join(".wildarrange", "checkpoints", planId, `${task.id}.json`)
      : null),
    task?.last_review_result?.reportJsonPath,
    task?.last_failure?.reportJsonPath,
  ].filter(Boolean);
}

/**
 * 读取 TaskCheckpoint 并返回结构化结果。
 */
async function readTaskCheckpoint(rootDir, planId, taskId) {
  const current = await readJson(resolveTaskCheckpointPath(rootDir, planId, taskId), null);
  if (current?.planId === planId && current?.taskId === taskId) return current;
  const legacy = await readJson(resolveLegacyTaskCheckpointPath(rootDir, planId, taskId), null);
  return legacy?.planId === planId && legacy?.taskId === taskId ? legacy : null;
}

/**
 * implementationNotes 内部辅助。
 */
function implementationNotes(task) {
  return (task?.evidence || [])
    .filter((entry) => ["worker", "parallel_agent_admission"].includes(entry.kind))
    .slice(-4)
    .map((entry) => entry.summary || entry.stdout || entry.command || entry.kind)
    .filter(Boolean)
    .map((value) => String(value).slice(0, 240));
}

/**
 * pitfallsFromTask 内部辅助。
 */
function pitfallsFromTask(task) {
  const failure = task?.last_failure;
  if (!failure) return [];
  return [`${failure.reason}: ${failure.summary || failure.retryHint || ""}`.trim()];
}

/**
 * digestKeywords 内部辅助。
 */
function digestKeywords(digest) {
  return [
    digest.reason,
    digest.stage,
    digest.task?.id,
    digest.route?.intent,
    digest.route?.domain,
    digest.route?.category,
  ].filter(Boolean);
}

/**
 * 将数组项归一化为相对路径并过滤空值。
 */
function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20);
}

/**
 * 渲染 DigestMarkdown 为 Markdown/HTML。
 */
function renderDigestMarkdown(digest) {
  return `# Memory Digest

| Field | Value |
| --- | --- |
| Reason | \`${digest.reason}\` |
| Stage | \`${digest.stage}\` |
| Plan | \`${digest.planId || ""}\` |
| Task | \`${digest.task?.id || ""}\` |
| Git HEAD | \`${formatGitHead(digest.gitHead)}\` |

## Progress

${listBlock(digest.progress)}

## Decisions

${listBlock(digest.decisions)}

## Artifacts

${listBlock(digest.artifacts)}

## Implementation Notes

${listBlock(digest.implementationNotes)}

## Pitfalls

${listBlock(digest.pitfalls)}

## Open Questions

${listBlock(digest.openQuestions)}
`;
}

/**
 * 列出 Block 条目。
 */
function listBlock(items) {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

/**
 * formatGitHead 内部辅助。
 */
function formatGitHead(gitHead) {
  if (!gitHead) return "";
  if (typeof gitHead === "string") return gitHead;
  return `${gitHead.value || ""}${gitHead.source ? ` (${gitHead.source})` : ""}`;
}

/**
 * sanitizeSegment 内部辅助。
 */
function sanitizeSegment(value) {
  return String(value || "digest").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "digest";
}

