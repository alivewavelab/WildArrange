import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LEAD_AGENT,
  appendLedger,
  createWorkId,
  ensureHelixDirs,
  loadHelixConfig,
  normalizeAgentKey,
  nowIso,
  readJson,
  resolveHelixPath,
  withTaskStateLock,
  writeJsonAtomic,
  writeSnapshot,
} from "../infra/foundation.mjs";
import { readVerifiedLedgerEntries } from "../infra/ledger.mjs";
import { buildFailureSummary } from "../infra/failure-analysis.mjs";
import { appendWisdom, writeFailureReport, writeReviewReport } from "../infra/task-reports.mjs";
import { writeMemoryDigest } from "../infra/memory-digest.mjs";
import { resolveAgentSpawn } from "../infra/agent-spawn.mjs";
import { applyAgentPatch, collectAgentWorktreePatch, extractPatchPaths, prepareAgentWorktree } from "../infra/git-worktree.mjs";
import { runCommand } from "../infra/command-runner.mjs";
import { pathAllowed } from "../infra/path-match.mjs";
import { runDeliveryPipeline, runPostCompletionSideEffects } from "./delivery-pipeline.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { findRunnableTask, persistTaskState, sendTeamMessage } from "./task-board.mjs";

const DEFAULT_PARALLEL_TIMEOUT_MS = 120_000;

export async function runParallelAgents(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const { config } = await loadHelixConfig(rootDir);

  const tasks = selectParallelTasks(taskState.tasks, options);
  if (tasks.length === 0) {
    await appendLedger(rootDir, { type: "parallel_agents_idle", reason: "no runnable tasks" });
    return { status: "idle", runId: null, tasks: [] };
  }

  const runId = createWorkId("agent_run");
  const runDir = resolveHelixPath(rootDir, "agent-runs", runId);
  await mkdir(runDir, { recursive: true });
  const startedAt = nowIso();
  await appendLedger(rootDir, { type: "parallel_agents_started", runId, taskIds: tasks.map((task) => task.id) });
  // Pre-register the run in index.json AND as a running batch JSON before
  // any agent starts: if the process dies mid-run (or the final index write
  // fails), the run is still discoverable by `parallel status` instead of
  // silently invisible with orphan result.json files on disk
  // (cross-review P1, round 5, 2026-07-21).
  await registerRunIndexEntry(rootDir, runId);
  await writeJsonAtomic(resolveHelixPath(rootDir, "agent-runs", `${runId}.json`), {
    kind: "parallel_agent_batch",
    runId,
    at: startedAt,
    startedAt,
    status: "running",
    planId: taskState.planId,
    taskCount: tasks.length,
    results: [],
  });
  await writeSnapshot(rootDir, "parallel_agents_started", { runId, taskIds: tasks.map((task) => task.id) });

  const results = await Promise.all(tasks.map((task, index) => runOneAgent(rootDir, runDir, runId, task, {
    ...options,
    config,
    index,
  })));
  await appendRunIndex(rootDir, runId, results);
  const skipped = results.length > 0 && results.every((result) => result.status === "skipped");
  const pass = results.every((result) => result.pass === true);
  const batch = {
    kind: "parallel_agent_batch",
    runId,
    at: nowIso(),
    startedAt,
    status: skipped ? "skipped" : pass ? "completed" : "failed",
    isolation: "run-dir",
    planId: taskState.planId,
    taskCount: results.length,
    results,
  };
  await writeJsonAtomic(resolveHelixPath(rootDir, "agent-runs", `${runId}.json`), batch);
  await appendLedger(rootDir, { type: "parallel_agents_completed", runId, status: batch.status, taskCount: results.length });
  await writeSnapshot(rootDir, "parallel_agents_completed", { runId, status: batch.status, taskCount: results.length });
  return batch;
}

export async function listParallelAgentRuns(rootDir) {
  await ensureHelixDirs(rootDir);
  const index = await readJson(resolveHelixPath(rootDir, "agent-runs", "index.json"), { runs: [] });
  return reconcileRunIndex(rootDir, index);
}

/**
 * Self-healing for the run index: a run whose per-task result.json files
 * exist on disk but which never made it into index.json (index write failed
 * or the process died mid-run) used to be permanently invisible to
 * `parallel status` (cross-review P1, round 5, 2026-07-21). Every index read
 * scans the agent-runs directory and adopts orphan run dirs back into the
 * index, rebuilding their entries from the result.json files.
 */
async function reconcileRunIndex(rootDir, index) {
  const runsDir = resolveHelixPath(rootDir, "agent-runs");
  let dirEntries = [];
  try {
    dirEntries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return index;
  }
  const known = new Set((index.runs || []).map((run) => run.runId));
  const adopted = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory() || known.has(entry.name)) continue;
    const runDir = path.join(runsDir, entry.name);
    const results = [];
    for (const taskEntry of await readdir(runDir, { withFileTypes: true }).catch(() => [])) {
      if (!taskEntry.isDirectory()) continue;
      const result = await readJson(path.join(runDir, taskEntry.name, "result.json"), null);
      if (!result) continue;
      results.push({
        taskId: result.taskId || taskEntry.name,
        agent: result.agent || null,
        pass: result.pass ?? null,
        runDir: result.runDir || path.relative(rootDir, path.join(runDir, taskEntry.name)),
        lifecycle: result.lifecycle || null,
      });
    }
    if (results.length === 0) continue;
    index.runs = index.runs || [];
    index.runs.push({
      runId: entry.name,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      recovered: true,
      results,
    });
    adopted.push(entry.name);
  }
  if (adopted.length > 0) {
    await writeJsonAtomic(resolveHelixPath(rootDir, "agent-runs", "index.json"), index);
    await appendLedger(rootDir, { type: "parallel_run_index_reconciled", adoptedRunIds: adopted }).catch(() => {});
  }
  return index;
}

async function registerRunIndexEntry(rootDir, runId) {
  const indexPath = resolveHelixPath(rootDir, "agent-runs", "index.json");
  const index = await readJson(indexPath, { runs: [] });
  if (!index.runs.some((run) => run.runId === runId)) {
    index.runs.push({ runId, createdAt: nowIso(), updatedAt: nowIso(), results: [] });
    await writeJsonAtomic(indexPath, index);
  }
}

export async function parallelAgentStatus(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const index = await listParallelAgentRuns(rootDir);
  const selectedRuns = options.runId
    ? (index.runs || []).filter((run) => run.runId === options.runId)
    : (index.runs || []);
  const runs = [];
  for (const run of selectedRuns) {
    const results = [];
    for (const entry of run.results || []) {
      const resultPath = resolveHelixPath(rootDir, "agent-runs", run.runId, entry.taskId, "result.json");
      const result = await readJson(resultPath, null);
      results.push({
        taskId: entry.taskId,
        agent: entry.agent,
        pass: entry.pass,
        runDir: entry.runDir,
        lifecycle: result?.lifecycle || entry.lifecycle || null,
        adapter: result?.adapter || null,
        isolation: result?.isolation || null,
        command: result?.command || null,
        resultPath: path.relative(rootDir, resultPath),
      });
    }
    runs.push({
      runId: run.runId,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      summary: summarizeRunLifecycle(results),
      results,
    });
  }
  return {
    kind: "parallel_agent_status",
    runId: options.runId || null,
    runCount: runs.length,
    runs,
  };
}

export async function closeParallelAgentRun(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  if (!options.runId) throw new Error("parallel close requires --run <runId>");
  const index = await listParallelAgentRuns(rootDir);
  const run = (index.runs || []).find((candidate) => candidate.runId === options.runId);
  if (!run) throw new Error(`parallel run not found: ${options.runId}`);
  const closed = [];
  for (const entry of run.results || []) {
    if (options.taskId && entry.taskId !== options.taskId) continue;
    const status = options.status || "closed";
    await updateAgentRunLifecycle(rootDir, options.runId, entry.taskId, status, {
      closedAt: nowIso(),
      closeReason: options.reason || "user_closed",
    });
    closed.push(entry.taskId);
  }
  await appendLedger(rootDir, { type: "parallel_agent_run_closed", runId: options.runId, taskIds: closed, reason: options.reason || "user_closed" });
  return {
    kind: "parallel_agent_close",
    runId: options.runId,
    closed,
  };
}

export async function cleanupParallelAgentRun(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  if (!options.runId) throw new Error("parallel cleanup requires --run <runId>");
  const status = await parallelAgentStatus(rootDir, { runId: options.runId });
  const cleaned = [];
  for (const run of status.runs || []) {
    for (const entry of run.results || []) {
      const resultPath = resolveHelixPath(rootDir, "agent-runs", run.runId, entry.taskId, "result.json");
      const result = await readJson(resultPath, null);
      if (!result || result.isolation !== "git-worktree" || result.worktreeAvailable !== true) continue;
      const worktreeDir = path.join(rootDir, result.workDir || "");
      const remove = await runCommand(`git -C ${shellEscape(rootDir)} worktree remove --force ${shellEscape(worktreeDir)}`, rootDir, 30_000);
      if (remove.exitCode !== 0 && !/is not a working tree|No such file/i.test(remove.stderr || remove.stdout || "")) {
        cleaned.push({ taskId: entry.taskId, status: "failed", path: result.workDir, error: remove.stderr || remove.stdout });
        continue;
      }
      await runCommand(`git -C ${shellEscape(rootDir)} worktree prune`, rootDir, 30_000);
      await updateAgentRunLifecycle(rootDir, run.runId, entry.taskId, "cleaned", {
        cleanedAt: nowIso(),
        cleanedPath: result.workDir,
      });
      cleaned.push({ taskId: entry.taskId, status: "cleaned", path: result.workDir });
    }
  }
  await appendLedger(rootDir, { type: "parallel_agent_worktree_cleanup", runId: options.runId, cleanedCount: cleaned.filter((item) => item.status === "cleaned").length });
  return {
    kind: "parallel_agent_cleanup",
    runId: options.runId,
    cleaned,
  };
}

export async function admitParallelAgentResult(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  if (!options.runId) throw new Error("parallel admit requires runId");
  if (!options.taskId) throw new Error("parallel admit requires taskId");
  const result = await readParallelAgentResult(rootDir, options.runId, options.taskId);
  if (!result.pass) throw new Error(`parallel result for ${options.taskId} did not pass`);
  const files = normalizeProposedFiles(result.result?.files);
  if (files.length === 0 && typeof result.result?.patch !== "string") {
    throw new Error("parallel result has no result.files or result.patch to admit");
  }
  const proposedPaths = files.length > 0
    ? files.map((file) => file.path)
    : normalizePatchPaths(result.result?.patchPaths || result.result?.changedPaths || extractPatchPaths(result.result?.patch || ""));

  // Phase 1 — claim. Status adjudication, writable-paths precheck, the task
  // claim (verifying + admission evidence) and the started ledger event all
  // happen under one task-state lock, BEFORE any workspace file is touched
  // (cross-review P0, round 5, 2026-07-21). This both closes the
  // check-then-write race and guarantees that every workspace mutation has
  // an established transaction (started ledger + claimed task) behind it.
  const claim = await withTaskStateLock(rootDir, `parallel-admit:${options.taskId}`, async () => {
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
    const task = taskState.tasks.find((candidate) => candidate.id === options.taskId);
    if (!task) throw new Error(`unknown task: ${options.taskId}`);

    if (task.status === "completed") {
      // A completed task is either an idempotent resume (THIS run completed
      // it through the gates, only the lifecycle release was interrupted) or
      // a hard refusal. "This run completed it" requires a chain-verified
      // completed ledger event for this exact run — the admission-started
      // evidence entry alone is not enough, because a run whose admission
      // failed and rolled back also left one behind (cross-review P1,
      // round 5, 2026-07-21).
      const completedByThisRun = await hasVerifiedRunCompletionEvent(rootDir, options.runId, options.taskId);
      if (!completedByThisRun) {
        throw new Error(`task ${options.taskId} is already completed; refusing to apply parallel result from run ${options.runId}`);
      }
      const admissionEvidence = [...(task.evidence || [])].reverse().find(
        (entry) => entry?.kind === "parallel_agent_admission" && entry.runId === options.runId,
      );
      return { kind: "resume", task, appliedPaths: admissionEvidence?.appliedPaths || [] };
    }
    // Ownership: an active admission claim is persisted on the task, so a
    // "verifying" task can tell apart "another run is admitting right now"
    // (refuse — otherwise two runs can both complete the same task, cross-
    // review P0, round 6, 2026-07-21) from "MY admission crashed mid-flight"
    // (reclaim and continue from the recorded phase, without re-running the
    // parts that already happened).
    if (task.admission_claim?.runId && task.status === "verifying") {
      if (task.admission_claim.runId !== options.runId) {
        throw new Error(`task ${options.taskId} is currently claimed by parallel admission run ${task.admission_claim.runId} (phase: ${task.admission_claim.phase}); refusing run ${options.runId}. 若那次 admission 已崩溃，用原 run 重新 admit 即可续跑`);
      }
      const priorWorker = [...(task.evidence || [])].reverse().find(
        (entry) => entry?.kind === "worker" && entry.source === "parallel_agent_admission" && entry.runId === options.runId,
      );
      await appendLedger(rootDir, {
        type: "parallel_agent_admission_reclaimed",
        runId: options.runId,
        taskId: options.taskId,
        phase: task.admission_claim.phase,
      });
      return {
        kind: "reclaimed",
        phase: task.admission_claim.phase,
        workerResult: priorWorker || {
          kind: "worker",
          at: nowIso(),
          command: `parallel_admit:${options.runId}:${options.taskId}`,
          exitCode: 0,
          stdout: "reclaimed admission (original worker evidence missing)",
          stderr: "",
          source: "parallel_agent_admission",
          runId: options.runId,
          agent: result.agent,
        },
        writablePaths: task.writable_paths || [],
        claimAppliedPaths: task.admission_claim.appliedPaths || proposedPaths,
      };
    }
    if (!["pending", "in_progress", "verifying"].includes(task.status)) {
      throw new Error(`task ${options.taskId} status ${task.status} cannot admit parallel result`);
    }
    const denied = proposedPaths.filter((filePath) => !pathAllowed(filePath, task.writable_paths || []));
    if (denied.length > 0) {
      throw new Error(`parallel admission denied by writable_paths: ${denied.join(", ")}`);
    }

    const workerResult = {
      kind: "worker",
      at: nowIso(),
      command: `parallel_admit:${options.runId}:${options.taskId}`,
      exitCode: 0,
      stdout: files.length > 0
        ? `Admitted ${files.length} file(s) from ${result.agent}`
        : `Admitted patch with ${proposedPaths.length} path(s) from ${result.agent}`,
      stderr: "",
      source: "parallel_agent_admission",
      runId: options.runId,
      agent: result.agent,
      resultPath: result.runDir ? `${result.runDir}/result.json` : null,
    };
    if (task.status === "pending") task.attempts += 1;
    task.status = "verifying";
    // The claim carries the owner and the phase, so concurrent admissions
    // are refused above and a crashed admission can resume deterministically.
    task.admission_claim = {
      runId: options.runId,
      agent: result.agent,
      claimedAt: nowIso(),
      phase: "applying",
      appliedPaths: proposedPaths,
    };
    // New admission round invalidates gate results from previous rounds
    // (same rule as the linear runtime's new-worker-round clearing).
    task.last_verify_result = null;
    task.last_scope_result = null;
    task.last_review_result = null;
    task.evidence.push(workerResult);
    task.evidence.push({
      kind: "parallel_agent_admission",
      at: nowIso(),
      runId: options.runId,
      agent: result.agent,
      appliedPaths: proposedPaths,
      admissionMode: files.length > 0 ? "files" : "patch",
      summary: result.result?.summary || "",
    });
    task.updatedAt = nowIso();
    await appendLedger(rootDir, {
      type: "parallel_agent_admission_started",
      runId: options.runId,
      taskId: options.taskId,
      agent: result.agent,
      appliedPaths: proposedPaths,
    });
    await persistTaskState(rootDir, taskState);
    return { kind: "claimed", workerResult, writablePaths: task.writable_paths || [] };
  });

  if (claim.kind === "resume") {
    await updateAgentRunLifecycle(rootDir, options.runId, options.taskId, "released", {
      admissionStatus: "completed",
      releasedAt: nowIso(),
      rollback: null,
      resumed: true,
    });
    await writeSnapshot(rootDir, "parallel_agent_admission_completed", {
      runId: options.runId,
      taskId: options.taskId,
      status: "completed",
      appliedPaths: claim.appliedPaths,
      resumed: true,
    });
    return {
      kind: "parallel_agent_admission",
      runId: options.runId,
      taskId: options.taskId,
      status: "completed",
      resumed: true,
      appliedPaths: claim.appliedPaths,
      verifyResult: claim.task.last_verify_result || null,
      scopeResult: claim.task.last_scope_result || null,
      reviewResult: claim.task.last_review_result || null,
      acceptanceProof: null,
      rollback: null,
      task: claim.task,
    };
  }

  // Phase 2 — apply the child's changes. ANY failure in here (write error,
  // patch failure, denied actual paths, even the mid-apply crash of a later
  // step) rolls the workspace back to its pre-admission content and releases
  // the claim, so a failed admission never leaves half-applied files plus a
  // task stuck in verifying (cross-review P0, round 5, 2026-07-21).
  // A reclaimed admission that already reached the "finalizing" phase skips
  // this whole block: its files are on disk, re-applying (and above all
  // re-planning a rollback against the already-mutated workspace) would be
  // wrong (cross-review P0, round 6, 2026-07-21).
  let rollbackPlan = { mode: "none", paths: [] };
  let appliedPaths = claim.kind === "reclaimed" && claim.phase === "finalizing"
    ? claim.claimAppliedPaths
    : proposedPaths;
  if (claim.kind === "reclaimed" && claim.phase === "finalizing") {
    // If the resumed gates fail, a patch can still be reverse-applied; the
    // pre-admission file contents from the crashed attempt are gone, so
    // files-mode keeps mode "none" (the failure hint asks for manual review
    // instead of pretending a rollback happened).
    if (typeof result.result?.patch === "string" && files.length === 0) {
      rollbackPlan = { mode: "patch", patch: result.result.patch, paths: claim.claimAppliedPaths };
    }
  } else {
    try {
      if (files.length > 0) {
        rollbackPlan = await createFileRollbackPlan(rootDir, files);
        for (const file of files) {
          const absolutePath = path.join(rootDir, file.path);
          assertInsideRoot(rootDir, absolutePath, file.path);
          await mkdir(path.dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, file.content, "utf8");
        }
      } else {
        rollbackPlan = { mode: "patch", patch: result.result.patch, paths: proposedPaths };
        const alreadyApplied = claim.kind === "reclaimed" && (await patchAlreadyApplied(rootDir, result.result.patch));
        if (!alreadyApplied) await applyAgentPatch(rootDir, result.result.patch);
        const actualPaths = await collectActualAdmissionPaths(rootDir, proposedPaths);
        const actualDenied = actualPaths.filter((filePath) => !pathAllowed(filePath, claim.writablePaths));
        if (actualDenied.length > 0) {
          throw new Error(`parallel admission denied by actual written paths: ${actualDenied.join(", ")}`);
        }
        rollbackPlan.paths = actualPaths;
        appliedPaths = actualPaths;
      }
    } catch (error) {
      const applyError = error instanceof Error ? error : new Error(String(error));
      const rollback = await rollbackAdmissionChanges(rootDir, rollbackPlan);
      await releaseAdmissionClaim(rootDir, options.taskId, {
        runId: options.runId,
        error: applyError,
        rollback,
      });
      await updateAgentRunLifecycle(rootDir, options.runId, options.taskId, "awaiting_revision", {
        admissionStatus: "apply_failed",
        rollback,
      }).catch(() => {});
      throw new Error(`parallel admission failed while applying files (workspace rollback: ${rollback.status}): ${applyError.message}`);
    }
    // Files are on disk: advance the persisted claim phase so a crash from
    // here on resumes into finalize instead of re-applying (or worse,
    // rollback-deleting a patch that a fresh retry could not re-apply).
    await advanceAdmissionClaimPhase(rootDir, options.taskId, options.runId, "finalizing", appliedPaths);
  }

  // Phase 3 — gates through the shared delivery pipeline. A crash anywhere
  // in here (review report, completion ledger, wisdom, digest, canonical
  // persist) must NOT roll the workspace back: the artifact may be good and
  // parts of the completion transaction may already be on the ledger. The
  // claim stays persisted at phase "finalizing", which is exactly the
  // resumable state — re-admitting the same run skips the apply and re-runs
  // the gates (cross-review P0, round 6, 2026-07-21).
  let finalized;
  try {
    finalized = await finalizeAdmission(rootDir, options.taskId, {
      workerResult: claim.workerResult,
      changedPaths: appliedPaths,
      runId: options.runId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendLedger(rootDir, {
      type: "parallel_agent_admission_finalize_interrupted",
      runId: options.runId,
      taskId: options.taskId,
      error: message,
    }).catch(() => {});
    throw new Error(`parallel admission was interrupted while finalizing (workspace changes kept, claim held by run ${options.runId}): ${message}。修复故障后用同一 run 重新 admit 即可从中断处续跑`);
  }
  const { verifyResult, scopeResult, reviewResult } = finalized;
  let rollback = null;
  if (finalized.status !== "completed") {
    rollback = await rollbackAdmissionChanges(rootDir, rollbackPlan);
  }
  // For the completed outcome the admission ledger event was already written
  // inside finalizeAdmission, BEFORE the canonical completed persist (ledger
  // first, state last — same completion-transaction ordering as the linear
  // runtime). Only non-completed outcomes are logged here, with rollback info.
  if (finalized.status !== "completed") {
    await appendLedger(rootDir, {
      type: "parallel_agent_admission_completed",
      runId: options.runId,
      taskId: options.taskId,
      status: finalized.status,
      appliedPaths,
      rollback,
    });
  }
  await updateAgentRunLifecycle(rootDir, options.runId, options.taskId, finalized.status === "completed" ? "released" : "awaiting_revision", {
    admissionStatus: finalized.status,
    releasedAt: finalized.status === "completed" ? nowIso() : null,
    rollback,
  });
  // Post-commit convenience: a snapshot failure after the completion has
  // been persisted must not fail the admission, only leave a ledger trace.
  const sideEffectWarnings = await runPostCompletionSideEffects(rootDir, finalized.planId, finalized.task, async () => {
    await writeSnapshot(rootDir, "parallel_agent_admission_completed", {
      runId: options.runId,
      taskId: options.taskId,
      status: finalized.status,
      appliedPaths,
      rollback,
    });
  });
  return {
    kind: "parallel_agent_admission",
    runId: options.runId,
    taskId: options.taskId,
    status: finalized.status,
    appliedPaths,
    verifyResult,
    scopeResult,
    reviewResult,
    acceptanceProof: finalized.acceptanceProof || null,
    rollback,
    sideEffectWarnings,
    task: finalized.task,
  };
}

function selectParallelTasks(tasks, options) {
  if (Array.isArray(options.taskIds) && options.taskIds.length > 0) {
    const selected = options.taskIds.map((taskId) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`unknown task: ${taskId}`);
      if (task.status !== "pending") throw new Error(`task ${taskId} is ${task.status}; only pending tasks can run in parallel`);
      return task;
    });
    return selected.slice(0, normalizeMaxAgents(options.maxAgents));
  }

  const selected = [];
  const remaining = [...tasks];
  const maxAgents = normalizeMaxAgents(options.maxAgents);
  while (selected.length < maxAgents) {
    const next = findRunnableTask(remaining);
    if (!next) break;
    selected.push(next);
    next.status = "selected";
  }
  for (const task of selected) task.status = "pending";
  return selected;
}

async function readParallelAgentResult(rootDir, runId, taskId) {
  const directPath = resolveHelixPath(rootDir, "agent-runs", runId, taskId, "result.json");
  const result = await readJson(directPath, null);
  if (!result) throw new Error(`parallel result not found: ${path.relative(rootDir, directPath)}`);
  return result;
}

/**
 * Releases the admission claim after a failed file application: the task
 * goes back to pending with an apply-failure record so a later admission or
 * linear run can retry cleanly, instead of leaving the task stuck in
 * verifying with a half-applied workspace (cross-review P0, round 5,
 * 2026-07-21).
 */
async function releaseAdmissionClaim(rootDir, taskId, { runId, error, rollback }) {
  await withTaskStateLock(rootDir, `parallel-admit-release:${taskId}`, async () => {
    const taskState = await loadTaskState(rootDir);
    if (!taskState) return;
    const task = taskState.tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.status !== "verifying") return;
    task.status = "pending";
    task.admission_claim = null;
    task.last_failure = {
      at: nowIso(),
      reason: "admission_apply_failed",
      summary: `parallel admission failed while applying files: ${error.message}`,
      retryHint: rollback?.status === "rolled_back"
        ? "工作区已回滚到 admission 前的内容，修复失败原因后重新 admit 即可"
        : `工作区回滚状态: ${rollback?.status || "unknown"}，请先人工核对 ${(rollback?.paths || []).join(", ") || "改动文件"} 再重新 admit`,
    };
    task.updatedAt = nowIso();
    await appendLedger(rootDir, {
      type: "parallel_agent_admission_apply_failed",
      runId: runId || null,
      taskId,
      error: error.message,
      rollback: rollback?.status || null,
      rollbackPaths: rollback?.paths || [],
    });
    await persistTaskState(rootDir, taskState);
  });
}

/**
 * Advances the persisted claim phase (applying -> finalizing) once the
 * child's files are on disk, so a crash after this point resumes into the
 * finalize step instead of re-applying files (cross-review P0, round 6,
 * 2026-07-21). No-op if the claim was lost or taken over in the meantime.
 */
async function advanceAdmissionClaimPhase(rootDir, taskId, runId, phase, appliedPaths) {
  await withTaskStateLock(rootDir, `parallel-admit-phase:${taskId}`, async () => {
    const taskState = await loadTaskState(rootDir);
    const task = taskState?.tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.admission_claim?.runId !== runId) return;
    task.admission_claim.phase = phase;
    task.admission_claim.appliedPaths = appliedPaths;
    task.updatedAt = nowIso();
    await persistTaskState(rootDir, taskState);
  });
}

/**
 * True when the patch is already present in the workspace (git can apply it
 * in reverse). Used by the crash-resume path of an "applying"-phase claim,
 * where we cannot know whether the interrupted attempt got the patch in.
 */
async function patchAlreadyApplied(rootDir, patch) {
  const patchPath = path.join(rootDir, ".helix", "agent-runs", `recheck-${Date.now()}-${process.pid}.patch`);
  await writeFile(patchPath, patch, "utf8");
  try {
    const reverseCheck = await runCommand(`git -C ${shellEscape(rootDir)} apply --reverse --check --whitespace=nowarn ${shellEscape(patchPath)}`, rootDir, 30_000);
    return reverseCheck.exitCode === 0;
  } finally {
    await rm(patchPath, { force: true });
  }
}

/**
 * True only when the chain-verified ledger contains a completed admission
 * event for this exact run+task. Used by the resume branch: an admission
 * that failed and rolled back also left admission evidence on the task, so
 * evidence alone cannot prove "this run is the one that completed the task".
 */
async function hasVerifiedRunCompletionEvent(rootDir, runId, taskId) {
  const entries = await readVerifiedLedgerEntries(rootDir);
  return entries.some(
    (entry) => entry.type === "parallel_agent_admission_completed"
      && entry.runId === runId
      && entry.taskId === taskId
      && entry.status === "completed",
  );
}

async function collectActualAdmissionPaths(rootDir, fallbackPaths) {
  const result = await runCommand("git diff --name-only -- . ':!.helix'", rootDir, 30_000);
  if (result.exitCode !== 0) return fallbackPaths;
  const paths = result.stdout.split(/\r?\n/).map((line) => normalizeRelativePath(line.trim())).filter(Boolean);
  return paths.length > 0 ? [...new Set(paths)] : fallbackPaths;
}

async function createFileRollbackPlan(rootDir, files) {
  const entries = [];
  for (const file of files) {
    const absolutePath = path.join(rootDir, file.path);
    assertInsideRoot(rootDir, absolutePath, file.path);
    try {
      entries.push({
        path: file.path,
        existed: true,
        content: await readFile(absolutePath, "utf8"),
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      entries.push({ path: file.path, existed: false, content: "" });
    }
  }
  return { mode: "files", paths: files.map((file) => file.path), entries };
}

async function rollbackAdmissionChanges(rootDir, rollbackPlan) {
  if (!rollbackPlan || rollbackPlan.mode === "none") {
    return { status: "skipped", reason: "no rollback plan" };
  }
  try {
    if (rollbackPlan.mode === "files") {
      for (const entry of rollbackPlan.entries || []) {
        const absolutePath = path.join(rootDir, entry.path);
        assertInsideRoot(rootDir, absolutePath, entry.path);
        if (entry.existed) {
          await mkdir(path.dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, entry.content, "utf8");
        } else {
          await rm(absolutePath, { force: true });
        }
      }
    } else if (rollbackPlan.mode === "patch") {
      const patchPath = path.join(rootDir, ".helix", "agent-runs", `rollback-${Date.now()}-${process.pid}.patch`);
      await writeFile(patchPath, rollbackPlan.patch, "utf8");
      const reverse = await runCommand(`git -C ${shellEscape(rootDir)} apply --reverse --whitespace=nowarn ${shellEscape(patchPath)}`, rootDir, 30_000);
      if (reverse.exitCode !== 0) {
        throw new Error(reverse.stderr || reverse.stdout || "git apply --reverse failed");
      }
    }
    await appendLedger(rootDir, { type: "parallel_agent_admission_rolled_back", mode: rollbackPlan.mode, paths: rollbackPlan.paths || [] });
    return { status: "rolled_back", mode: rollbackPlan.mode, paths: rollbackPlan.paths || [] };
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    await appendLedger(rootDir, { type: "parallel_agent_admission_rollback_failed", mode: rollbackPlan.mode, paths: rollbackPlan.paths || [], error: summary });
    return { status: "rollback_failed", mode: rollbackPlan.mode, paths: rollbackPlan.paths || [], error: summary };
  }
}

async function finalizeAdmission(rootDir, taskId, { workerResult, changedPaths, runId }) {
  return withTaskStateLock(rootDir, `parallel-admit-finalize:${taskId}`, async () => {
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
    const task = taskState.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    // Ownership gate: finalize may only commit on behalf of the run that
    // holds the persisted claim. Without this, a stale in-flight admission
    // could complete a task that has since been released and re-claimed by
    // another run — two owners for one task (cross-review P0, round 6,
    // 2026-07-21).
    if (task.admission_claim?.runId !== runId) {
      throw new Error(`task ${taskId} admission claim is ${task.admission_claim ? `held by run ${task.admission_claim.runId}` : "no longer held"}; refusing to finalize on behalf of run ${runId}`);
    }

    // Same shared pipeline as the linear runtime: gate order lives in
    // delivery-pipeline.mjs only. This function keeps owning the evidence
    // shape, reports, and task status transitions.
    const pipelineResult = await runDeliveryPipeline(rootDir, taskState.planId, task, {
      initialEvidence: { workerResult },
      changedPaths,
    });
    const verifyResult = pipelineResult.evidence.verifyResult;
    const scopeResult = pipelineResult.evidence.scopeResult;
    const reviewResult = pipelineResult.evidence.reviewResult;
    const acceptanceProof = pipelineResult.evidence.acceptanceProof || null;
    const criteria = pipelineResult.criteria;

    task.evidence.push(verifyResult);
    task.last_verify_result = verifyResult;
    task.evidence.push({ kind: "scope_guard", at: nowIso(), ...scopeResult });
    task.last_scope_result = scopeResult;
    task.evidence.push(reviewResult);
    task.last_review_result = reviewResult;
    await writeReviewReport(rootDir, taskState.planId, task, reviewResult);

    if (pipelineResult.status === "completed") {
      task.status = "completed";
      task.admission_claim = null;
      task.updatedAt = nowIso();
      // Ledger first, canonical tasks.json last (commit point): a ledger
      // outage must never leave a completed/released admission without its
      // completion ledger event (cross-review P0, round 3, 2026-07-21).
      await appendLedger(rootDir, {
        type: "parallel_agent_admission_completed",
        runId: runId || null,
        taskId,
        status: "completed",
        appliedPaths: changedPaths || [],
        rollback: null,
      });
      // Wisdom and digest are INSIDE the completion transaction (before the
      // canonical persist): if either write fails, the task stays verifying
      // and the recovery adjudication re-runs the whole completion, so a
      // completed task can never permanently miss them (cross-review P1,
      // round 5, 2026-07-21).
      await appendWisdom(rootDir, task, verifyResult);
      await writeMemoryDigest(rootDir, { reason: "parallel_admission_completed", stage: "checkpoint", task, taskId });
      await persistTaskState(rootDir, taskState);
      return { status: "completed", planId: taskState.planId, task, acceptanceProof, verifyResult, scopeResult, reviewResult };
    }

    if (pipelineResult.status === "checkpoint_failed") {
      task.status = "pending";
      task.admission_claim = null;
      task.last_failure = buildFailureSummary(task, {
        workerResult,
        verifyResult,
        scopeResult,
        reviewResult,
        criteriaResult: criteria,
        nextStatus: task.status,
      });
      task.last_failure.reason = "checkpoint_failed";
      task.last_failure.summary = `checkpoint write failed: ${pipelineResult.evidence.checkpointError?.message || "unknown error"}`;
      task.last_failure.retryHint = "checkpoint 写入失败（检查 .helix/checkpoints 目录是否可写），修复后重新 admit 即可，所有质量门已通过";
      task.updatedAt = nowIso();
      await writeFailureReport(rootDir, taskState.planId, task);
      await persistTaskState(rootDir, taskState);
      await appendLedger(rootDir, { type: "checkpoint_write_failed", planId: taskState.planId, taskId: task.id, error: pipelineResult.evidence.checkpointError?.message || null });
      return { status: "retry", planId: taskState.planId, task, acceptanceProof, verifyResult, scopeResult, reviewResult };
    }

    task.status = shouldFailAdmission(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
    task.admission_claim = null;
    task.last_failure = buildFailureSummary(task, {
      workerResult,
      verifyResult,
      scopeResult,
      reviewResult,
      criteriaResult: criteria,
      nextStatus: task.status,
    });
    if (acceptanceProof && !acceptanceProof.pass) {
      task.last_failure.reason = "acceptance_proof_failed";
      task.last_failure.summary = `acceptance proof failed: ${acceptanceProof.checks.filter((check) => check.status === "fail").map((check) => check.name).join(", ")}`;
    }
    task.updatedAt = nowIso();
    await writeFailureReport(rootDir, taskState.planId, task);
    await persistTaskState(rootDir, taskState);
    return { status: task.status === "failed" ? "failed" : "retry", planId: taskState.planId, task, acceptanceProof, verifyResult, scopeResult, reviewResult };
  });
}

async function runOneAgent(rootDir, runDir, runId, task, options) {
  const agent = normalizeAgentKey(options.agent || task.owner || `Agent${options.index + 1}`) || `Agent${options.index + 1}`;
  const taskRunDir = path.join(runDir, task.id);
  await mkdir(taskRunDir, { recursive: true });
  const config = options.config || (await loadHelixConfig(rootDir)).config;
  const isolation = options.isolation || task.isolation || config.parallelAgents?.isolation || "run-dir";
  const worktree = await prepareAgentWorktree(rootDir, taskRunDir, {
    isolation,
    timeoutMs: normalizeTimeout(options.timeoutMs || config.parallelAgents?.timeoutMs),
  });
  const taskPacketPath = path.join(taskRunDir, "task.json");
  const resultPath = path.join(taskRunDir, "agent-result.json");
  await writeJsonAtomic(taskPacketPath, buildTaskPacket(task, { runId, agent, worktree }));

  const spawn = resolveAgentSpawn(rootDir, config, task, {
    rootDir,
    runDir: taskRunDir,
    workDir: worktree.workDir,
    task,
    agent,
    taskPacketPath,
    resultPath,
  }, options);
  const command = spawn.command;
  const commandConfigured = Boolean(command);
  const startedAt = nowIso();
  const commandResult = worktree.isolation === "git-worktree" && worktree.available !== true
    ? { exitCode: 1, stdout: "", stderr: worktree.reason || "git-worktree isolation unavailable" }
    : command
      ? await runCommand(command, worktree.workDir, normalizeTimeout(options.timeoutMs || config.parallelAgents?.timeoutMs))
      : { exitCode: 78, stdout: "", stderr: "no runner command configured; task packet prepared only" };
  const structuredResult = await readJson(resultPath, null) || {};
  const patchResult = await collectAgentWorktreePatch(rootDir, worktree, {
    timeoutMs: normalizeTimeout(options.timeoutMs || config.parallelAgents?.timeoutMs),
  });
  if (patchResult?.patch && !structuredResult.patch && normalizeProposedFilesOrEmpty(structuredResult.files).length === 0) {
    structuredResult.patch = patchResult.patch;
    structuredResult.patchPaths = patchResult.changedPaths;
    structuredResult.patchPath = patchResult.patchPath;
    structuredResult.summary = structuredResult.summary || `patch with ${patchResult.changedPaths.length} changed path(s)`;
    await writeJsonAtomic(resultPath, structuredResult);
  }
  const result = {
    kind: "parallel_agent_result",
    runId,
    taskId: task.id,
    agent,
    at: nowIso(),
    startedAt,
    command: command || null,
    adapter: spawn.adapter,
    spawnSource: spawn.source,
    isolation: worktree.isolation,
    workDir: path.relative(rootDir, worktree.workDir),
    worktreeAvailable: worktree.available,
    worktreeReason: worktree.reason,
    exitCode: commandResult.exitCode,
    status: commandConfigured ? (commandResult.exitCode === 0 ? "pass" : "fail") : "skipped",
    pass: commandConfigured && commandResult.exitCode === 0,
    stdout: truncate(commandResult.stdout || "", 4000),
    stderr: truncate(commandResult.stderr || "", 4000),
    result: structuredResult,
    lifecycle: buildAgentLifecycle(commandConfigured && commandResult.exitCode === 0, config, commandConfigured ? null : "skipped"),
    patch: patchResult ? {
      patchPath: patchResult.patchPath,
      changedPaths: patchResult.changedPaths,
      status: patchResult.status,
      exitCode: patchResult.exitCode,
    } : null,
    runDir: path.relative(rootDir, taskRunDir),
  };
  await writeJsonAtomic(path.join(taskRunDir, "result.json"), result);
  await sendTeamMessage(rootDir, {
    from: agent,
    to: DEFAULT_LEAD_AGENT,
    summary: `${task.id} parallel result: ${result.status || (result.pass ? "pass" : "fail")}`,
    body: buildMessageBody(task, result),
  });
  await appendLedger(rootDir, { type: "parallel_agent_result", runId, taskId: task.id, agent, pass: result.pass });
  return result;
}

function buildTaskPacket(task, context) {
  return {
    kind: "parallel_agent_task_packet",
    at: nowIso(),
    runId: context.runId,
    agent: context.agent,
    worktree: context.worktree ? {
      isolation: context.worktree.isolation,
      workDir: context.worktree.workDir,
      available: context.worktree.available,
      reason: context.worktree.reason,
    } : null,
    task: {
      id: task.id,
      subject: task.subject,
      description: task.description,
      category: task.category,
      writable_paths: task.writable_paths,
      verify_commands: task.verify_commands,
      successCriteria: task.successCriteria,
      skills: task.skills,
      route_decision: task.route_decision,
    },
    instruction: [
      "Work only inside this run directory unless a host adapter explicitly grants a separate workspace.",
      "If worktree.available is true, edit inside worktree.workDir and let WildArrange collect the patch.",
      "Write optional structured output to agent-result.json.",
      "To propose mainline changes, write agent-result.json with files: [{\"path\":\"relative/path\",\"content\":\"utf8 text\"}].",
      "For Git worktree mode, changed files may be admitted as a generated patch after mainline gates pass.",
      "Do not claim the main task is complete; mainline verifier/review gates decide completion.",
    ],
  };
}

async function appendRunIndex(rootDir, runId, results) {
  const indexPath = resolveHelixPath(rootDir, "agent-runs", "index.json");
  const index = await readJson(indexPath, { runs: [] });
  const existing = index.runs.find((run) => run.runId === runId);
  const entries = results.map((result) => ({
    taskId: result.taskId,
    agent: result.agent,
    pass: result.pass,
    runDir: result.runDir,
    lifecycle: result.lifecycle || null,
  }));
  if (existing) {
    existing.updatedAt = nowIso();
    existing.results.push(...entries);
  } else {
    index.runs.push({
      runId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      results: entries,
    });
  }
  await writeJsonAtomic(indexPath, index);
}

async function updateAgentRunLifecycle(rootDir, runId, taskId, status, details = {}) {
  const resultPath = resolveHelixPath(rootDir, "agent-runs", runId, taskId, "result.json");
  const result = await readJson(resultPath, null);
  if (result) {
    result.lifecycle = {
      ...(result.lifecycle || {}),
      status,
      updatedAt: nowIso(),
      ...details,
    };
    await writeJsonAtomic(resultPath, result);
  }

  const batchPath = resolveHelixPath(rootDir, "agent-runs", `${runId}.json`);
  const batch = await readJson(batchPath, null);
  if (batch) {
    for (const entry of batch.results || []) {
      if (entry.taskId !== taskId) continue;
      entry.lifecycle = {
        ...(entry.lifecycle || {}),
        status,
        updatedAt: nowIso(),
        ...details,
      };
    }
    await writeJsonAtomic(batchPath, batch);
  }

  const indexPath = resolveHelixPath(rootDir, "agent-runs", "index.json");
  const index = await readJson(indexPath, { runs: [] });
  for (const run of index.runs || []) {
    if (run.runId !== runId) continue;
    for (const entry of run.results || []) {
      if (entry.taskId !== taskId) continue;
      entry.lifecycle = {
        ...(entry.lifecycle || {}),
        status,
        updatedAt: nowIso(),
        ...details,
      };
    }
    run.updatedAt = nowIso();
  }
  await writeJsonAtomic(indexPath, index);
  await appendLedger(rootDir, { type: "parallel_agent_lifecycle_updated", runId, taskId, status });
}

function buildAgentLifecycle(pass, config, statusOverride = null) {
  if (statusOverride === "skipped") {
    return {
      status: "skipped",
      retainUntil: null,
      updatedAt: nowIso(),
    };
  }
  if (!pass) {
    return {
      status: "failed",
      retainUntil: null,
      updatedAt: nowIso(),
    };
  }
  if (config.parallelAgents?.retainUntilUserAcceptance === false) {
    return {
      status: "closed",
      retainUntil: null,
      updatedAt: nowIso(),
    };
  }
  return {
    status: "awaiting_user_acceptance",
    retainUntil: "parallel_admission_completed",
    updatedAt: nowIso(),
  };
}

function summarizeRunLifecycle(results) {
  const counts = {};
  for (const result of results) {
    const status = result.lifecycle?.status || (result.pass ? "completed" : "failed");
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function buildMessageBody(task, result) {
  const lines = [
    `Task: ${task.id} ${task.subject}`,
    `Agent: ${result.agent}`,
    `Status: ${result.status || (result.pass ? "pass" : "fail")}`,
    `Run dir: ${result.runDir}`,
  ];
  if (result.result?.summary) lines.push(`Summary: ${result.result.summary}`);
  if (result.stderr) lines.push(`Stderr: ${result.stderr.slice(0, 800)}`);
  if (result.stdout) lines.push(`Stdout: ${result.stdout.slice(0, 800)}`);
  return lines.join("\n");
}

function normalizeMaxAgents(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 2;
  return Math.min(parsed, 8);
}

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PARALLEL_TIMEOUT_MS;
  return parsed;
}

function normalizeProposedFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map((file, index) => {
    if (!file || typeof file !== "object") throw new Error(`result.files[${index}] must be an object`);
    const filePath = normalizeRelativePath(file.path || file.file);
    if (!filePath) throw new Error(`result.files[${index}].path is required`);
    if (path.isAbsolute(filePath) || filePath.startsWith("../") || filePath.includes("/../")) {
      throw new Error(`result.files[${index}].path must stay inside the project`);
    }
    if (typeof file.content !== "string") throw new Error(`result.files[${index}].content must be a string`);
    return { path: filePath, content: file.content };
  });
}

function normalizeProposedFilesOrEmpty(files) {
  try {
    return normalizeProposedFiles(files);
  } catch {
    return [];
  }
}

function normalizePatchPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths.map(normalizeRelativePath).filter((filePath) => filePath && !path.isAbsolute(filePath) && !filePath.startsWith("../") && !filePath.includes("/../"));
}

function assertInsideRoot(rootDir, absolutePath, displayPath) {
  const relative = path.relative(rootDir, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes project root: ${displayPath}`);
  }
}

function shouldFailAdmission(task, verifyResult, scopeResult, reviewResult) {
  if (scopeResult?.status === "fail") return true;
  if (scopeResult && scopeResult.status !== "pass") return true;
  if (verifyResult?.pass === true && reviewResult?.kind === "review_gate" && reviewResult.pass === false) return true;
  return task.attempts >= task.maxAttempts;
}

function normalizeRelativePath(filePath) {
  return String(filePath || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 20)}\n...[truncated]`;
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
