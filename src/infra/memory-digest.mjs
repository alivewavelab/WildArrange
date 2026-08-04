import { writeFile } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "./ledger.mjs";
import {
  createWorkId,
  ensureHelixDirs,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "./runtime-store.mjs";
import { runCommand } from "./command-runner.mjs";
import { loadTaskState } from "./task-state-store.mjs";

export async function writeMemoryDigest(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const digest = await buildMemoryDigest(rootDir, options);
  const fileStem = `${digest.at.replace(/[:.]/g, "-")}-${sanitizeSegment(digest.reason)}`;
  const jsonPath = resolveHelixPath(rootDir, "memory", "digests", `${fileStem}.json`);
  const mdPath = resolveHelixPath(rootDir, "memory", "digests", `${fileStem}.md`);
  digest.reportJsonPath = path.relative(rootDir, jsonPath);
  digest.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, digest);
  await writeFile(mdPath, renderDigestMarkdown(digest), "utf8");
  await writeJsonAtomic(resolveHelixPath(rootDir, "memory", "last-digest.json"), digest);
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

export async function buildMemoryDigest(rootDir, options = {}) {
  const taskState = await loadTaskState(rootDir).catch(() => null);
  const task = options.task || (options.taskId && taskState?.tasks?.find((candidate) => candidate.id === options.taskId)) || null;
  const work = await readJson(resolveHelixPath(rootDir, "work.json"), null);
  const latestArchivist = await readJson(resolveHelixPath(rootDir, "memory", "last-archivist-result.json"), null);
  const route = options.route || latestArchivist?.decision?.routeDecision || null;
  const checkpoint = taskState && task ? await readJson(resolveHelixPath(rootDir, "checkpoints", `${taskState.planId}-${task.id}.json`), null) : null;
  const ledgerTail = await readLedgerTail(rootDir, Number(options.ledgerLimit) || 20);
  const gitHead = await readGitHead(rootDir);
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

async function updateDigestIndex(rootDir, digest) {
  const indexPath = resolveHelixPath(rootDir, "memory", "digest-index.json");
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

async function readLedgerTail(rootDir, limit) {
  try {
    const content = await readJsonLines(resolveHelixPath(rootDir, "ledger.jsonl"));
    return content.slice(-limit);
  } catch {
    return [];
  }
}

async function readJsonLines(filePath) {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(filePath, "utf8");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function readGitHead(rootDir) {
  const current = await runCommand("git rev-parse HEAD", rootDir, 15_000);
  if (current.exitCode === 0 && current.stdout.trim()) {
    return { value: current.stdout.trim(), source: "git" };
  }
  const head = await readJson(resolveHelixPath(rootDir, "routing", "archivist-trigger-state.json"), null);
  return head?.lastGitHead ? { value: head.lastGitHead, source: "archivist-trigger-state" } : null;
}

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

function progressFromLedger(events, task) {
  const taskId = task?.id;
  return events
    .filter((event) => !taskId || !event.taskId || event.taskId === taskId)
    .map((event) => `${event.type}${event.taskId ? ` ${event.taskId}` : ""}${event.status || event.nextStatus ? ` ${event.status || event.nextStatus}` : ""}`)
    .slice(-8);
}

function decisionsFromTask(task, checkpoint, latestArchivist) {
  return [
    task?.last_review_result?.pass === true ? "review gate passed" : "",
    checkpoint ? "checkpoint written" : "",
    latestArchivist?.decision?.summary ? latestArchivist.decision.summary : "",
  ].filter(Boolean).slice(0, 8);
}

function artifactRefs(planId, task, checkpoint) {
  return [
    checkpoint?.reportJsonPath || (planId && task?.id ? path.join(".helix", "checkpoints", `${planId}-${task.id}.json`) : null),
    task?.last_review_result?.reportJsonPath,
    task?.last_failure?.reportJsonPath,
  ].filter(Boolean);
}

function implementationNotes(task) {
  return (task?.evidence || [])
    .filter((entry) => ["worker", "parallel_agent_admission"].includes(entry.kind))
    .slice(-4)
    .map((entry) => entry.summary || entry.stdout || entry.command || entry.kind)
    .filter(Boolean)
    .map((value) => String(value).slice(0, 240));
}

function pitfallsFromTask(task) {
  const failure = task?.last_failure;
  if (!failure) return [];
  return [`${failure.reason}: ${failure.summary || failure.retryHint || ""}`.trim()];
}

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

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20);
}

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

function listBlock(items) {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

function formatGitHead(gitHead) {
  if (!gitHead) return "";
  if (typeof gitHead === "string") return gitHead;
  return `${gitHead.value || ""}${gitHead.source ? ` (${gitHead.source})` : ""}`;
}

function sanitizeSegment(value) {
  return String(value || "digest").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "digest";
}
