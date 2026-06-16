import { existsSync } from "node:fs";
import { appendFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { blockedCommandResult, evaluateCommandSafety } from "./helix-command-safety.mjs";
import {
  DEFAULT_LEAD_AGENT,
  appendLedger,
  ensureHelixDirs,
  hashContent,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "./helix-foundation.mjs";
import { loadTaskState } from "./helix-plan.mjs";

const DEFAULT_COMMAND_OUTPUT_MAX_CHARS = 200_000;
const COMMAND_SIGKILL_GRACE_MS = 2_000;

export function runCommand(command, cwd, timeoutMs = 120_000, options = {}) {
  return new Promise((resolve) => {
    const safety = evaluateCommandSafety(command, { allowUnsafe: options.allowUnsafe === true });
    if (!safety.allowed) {
      resolve(blockedCommandResult(command, safety));
      return;
    }
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HELIX_RUNTIME: "1" },
    });
    let stdout = "";
    let stderr = "";
    const maxOutputChars = Number.isInteger(options.maxOutputChars) && options.maxOutputChars > 0
      ? options.maxOutputChars
      : DEFAULT_COMMAND_OUTPUT_MAX_CHARS;
    const outputTruncated = { stdout: false, stderr: false };
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    function finish(result) {
      if (settled) return;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      settled = true;
      resolve({ ...result, outputTruncated });
    }
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, COMMAND_SIGKILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const next = appendCapped(stdout, chunk.toString(), maxOutputChars);
      stdout = next.value;
      outputTruncated.stdout ||= next.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const next = appendCapped(stderr, chunk.toString(), maxOutputChars);
      stderr = next.value;
      outputTruncated.stderr ||= next.truncated;
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish({
          exitCode: 124,
          stdout,
          stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms`.trim(),
          timedOut: true,
        });
        return;
      }
      finish({ exitCode: code ?? 1, stdout, stderr, timedOut: false });
    });
  });
}

function appendCapped(current, chunk, maxChars) {
  if (current.length >= maxChars) return { value: current, truncated: true };
  const available = maxChars - current.length;
  if (chunk.length <= available) return { value: current + chunk, truncated: false };
  return { value: current + chunk.slice(0, available), truncated: true };
}

export async function runVerifier(rootDir, task) {
  if (!Array.isArray(task.verify_commands) || task.verify_commands.length === 0) {
    return {
      kind: "verifier",
      at: nowIso(),
      pass: false,
      results: [{
        command: null,
        exitCode: 1,
        stdout: "",
        stderr: "verify_commands must contain at least one command",
      }],
    };
  }

  const results = [];
  for (const command of task.verify_commands) {
    const result = await runCommand(command, rootDir);
    results.push({ command, ...result });
    if (result.exitCode !== 0) break;
  }

  return {
    kind: "verifier",
    at: nowIso(),
    pass: results.every((result) => result.exitCode === 0),
    results,
  };
}

export async function collectGitDiff(rootDir) {
  const gitDir = path.join(rootDir, ".git");
  if (!existsSync(gitDir)) return "";
  const result = await runCommand("git diff -- . ':!.helix'", rootDir, 30_000);
  return result.exitCode === 0 ? result.stdout : "";
}

export async function collectGitChangedPaths(rootDir) {
  const gitDir = path.join(rootDir, ".git");
  if (!existsSync(gitDir)) {
    try {
      const manifest = await collectFileManifest(rootDir);
      return { available: true, source: "file_manifest", paths: Object.keys(manifest).sort(), fingerprints: manifest };
    } catch (error) {
      return { available: false, reason: `git repository not found and file manifest failed: ${error instanceof Error ? error.message : String(error)}`, paths: [] };
    }
  }

  const diff = await runCommand("git diff --name-only -- . ':!.helix'", rootDir, 30_000);
  const untracked = await runCommand("git ls-files --others --exclude-standard -- . ':!.helix'", rootDir, 30_000);
  if (diff.exitCode !== 0 || untracked.exitCode !== 0) {
    return {
      available: false,
      reason: [diff.stderr, untracked.stderr].filter(Boolean).join("\n") || "git changed path collection failed",
      paths: [],
    };
  }

  return {
    available: true,
    source: "git",
    paths: [...new Set([...splitPathLines(diff.stdout), ...splitPathLines(untracked.stdout)])].sort(),
  };
}

export function changedPathsIntroducedByTask(beforeChanged, afterChanged) {
  if (!beforeChanged.available || !afterChanged.available) {
    return undefined;
  }
  if (beforeChanged.fingerprints && afterChanged.fingerprints) {
    return classifyManifestPathChanges(beforeChanged.fingerprints, afterChanged.fingerprints)
      .map((change) => change.path);
  }
  const before = new Set(beforeChanged.paths.map(normalizeRelativePath));
  return afterChanged.paths.map(normalizeRelativePath).filter((filePath) => !before.has(filePath));
}

export function classifyManifestPathChanges(beforeFingerprints = {}, afterFingerprints = {}) {
  const allPaths = new Set([
    ...Object.keys(beforeFingerprints).map(normalizeRelativePath),
    ...Object.keys(afterFingerprints).map(normalizeRelativePath),
  ]);
  return [...allPaths]
    .map((filePath) => {
      const beforeHas = Object.hasOwn(beforeFingerprints, filePath);
      const afterHas = Object.hasOwn(afterFingerprints, filePath);
      if (!beforeHas && afterHas) return { path: filePath, status: "added" };
      if (beforeHas && !afterHas) return { path: filePath, status: "deleted" };
      if (beforeFingerprints[filePath] !== afterFingerprints[filePath]) return { path: filePath, status: "modified" };
      return null;
    })
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path));
}

const FILE_MANIFEST_SKIP_DIRS = new Set([".git", ".helix", "node_modules"]);

async function collectFileManifest(rootDir, relativeDir = "") {
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const manifest = {};
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      if (FILE_MANIFEST_SKIP_DIRS.has(entry.name)) continue;
      Object.assign(manifest, await collectFileManifest(rootDir, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStat = await stat(path.join(rootDir, relativePath));
    manifest[relativePath] = `${fileStat.size}:${fileStat.mtimeMs}`;
  }
  return manifest;
}

function splitPathLines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function scopeGuard(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");

  const task = resolveGuardTask(taskState.tasks, options.taskId);
  const collected = Array.isArray(options.changedPaths)
    ? { available: true, paths: options.changedPaths }
    : await collectGitChangedPaths(rootDir);

  if (!collected.available) {
    const guarded = (task.writable_paths || []).length > 0;
    const result = {
      status: guarded ? "fail" : "inconclusive",
      taskId: task.id,
      reason: options.unavailableReason || collected.reason,
      changedPaths: [],
      writablePaths: task.writable_paths,
      deniedPaths: [],
    };
    await appendLedger(rootDir, { type: guarded ? "scope_guard_failed" : "scope_guard_inconclusive", planId: taskState.planId, taskId: task.id, reason: result.reason });
    return result;
  }

  const changedPaths = collected.paths.map(normalizeRelativePath);
  const writablePaths = task.writable_paths.map(normalizeRelativePath);
  const realpathFindings = await resolveChangedPathRealpaths(rootDir, changedPaths);
  const deniedPaths = [
    ...changedPaths.filter((filePath) => !pathAllowed(filePath, writablePaths)),
    ...realpathFindings
      .filter((finding) => finding.escapesRoot || (finding.realRelativePath && !pathAllowed(finding.realRelativePath, writablePaths)))
      .map((finding) => finding.displayPath),
  ];
  const status = deniedPaths.length === 0 ? "pass" : "fail";
  const result = {
    status,
    taskId: task.id,
    changedPaths,
    writablePaths,
    deniedPaths: [...new Set(deniedPaths)],
    realpathFindings,
  };

  await appendLedger(rootDir, {
    type: status === "pass" ? "scope_guard_passed" : "scope_guard_failed",
    planId: taskState.planId,
    taskId: task.id,
    changedPathCount: changedPaths.length,
    deniedPaths: result.deniedPaths,
  });
  return result;
}

async function resolveChangedPathRealpaths(rootDir, changedPaths) {
  const rootReal = await realpath(rootDir).catch(() => rootDir);
  const findings = [];
  for (const filePath of changedPaths) {
    const absolutePath = path.join(rootDir, filePath);
    const actual = await realpath(absolutePath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!actual) continue;
    const realRelative = normalizeRelativePath(path.relative(rootReal, actual));
    const escapesRoot = realRelative === ".." || realRelative.startsWith("../") || path.isAbsolute(realRelative);
    if (escapesRoot || realRelative !== filePath) {
      findings.push({
        path: filePath,
        realRelativePath: escapesRoot ? null : realRelative,
        escapesRoot,
        displayPath: escapesRoot ? `${filePath} -> ${actual}` : `${filePath} -> ${realRelative}`,
      });
    }
  }
  return findings;
}

function resolveGuardTask(tasks, taskId) {
  const task = taskId
    ? tasks.find((candidate) => candidate.id === taskId)
    : tasks.find((candidate) => ["in_progress", "verifying", "pending"].includes(candidate.status));
  if (!task) {
    throw new Error(taskId ? `unknown task: ${taskId}` : "no active or pending task found");
  }
  return task;
}

function normalizeRelativePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export function pathAllowed(filePath, writablePaths) {
  if (writablePaths.length === 0) return false;
  const normalizedFile = normalizeRelativePath(filePath);
  return writablePaths.some((pattern) => pathMatchesPattern(normalizedFile, pattern));
}

export function pathMatchesPattern(filePath, pattern) {
  const normalizedPattern = normalizeRelativePath(pattern);
  if (normalizedPattern === filePath) return true;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  if (!normalizedPattern.includes("*")) {
    const literalPattern = normalizedPattern.replace(/\/$/, "");
    return filePath === literalPattern || filePath.startsWith(`${literalPattern}/`);
  }

  const escaped = normalizedPattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(filePath);
}

export async function writeCheckpoint(rootDir, planId, task, verifyResult, scopeResult = null, reviewResult = null) {
  const checkpointPath = resolveHelixPath(rootDir, "checkpoints", `${planId}-${task.id}.json`);
  await writeJsonAtomic(checkpointPath, {
    planId,
    taskId: task.id,
    subject: task.subject,
    verifiedAt: nowIso(),
    verifyResult,
    scopeResult,
    reviewResult,
  });
}

export async function writeChangeRequest(rootDir, planId, task, scopeResult, source = "scope_guard") {
  await ensureHelixDirs(rootDir);
  const signature = hashContent(JSON.stringify({
    planId,
    taskId: task.id,
    deniedPaths: scopeResult.deniedPaths || [],
    writablePaths: scopeResult.writablePaths || task.writable_paths || [],
  })).slice(0, 12);
  const id = `CR-${signature}`;
  const jsonPath = resolveHelixPath(rootDir, "changes", `${id}.json`);
  const mdPath = resolveHelixPath(rootDir, "changes", `${id}.md`);
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

export function renderChangeRequestMarkdown(changeRequest) {
  const legacyLeadReviewKey = ["requires", "Sisy", "phus", "Review"].join("");
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
- requiresLeadReview: ${changeRequest.invariants.requiresLeadReview ?? changeRequest.invariants[legacyLeadReviewKey]}
- mustNotWeakenVerification: ${changeRequest.invariants.mustNotWeakenVerification}
`;
}

export async function writeOpenChangesIndex(rootDir) {
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
  await writeFile(resolveHelixPath(rootDir, "changes", "open.md"), `${lines.join("\n")}\n`, "utf8");
}

export async function listChangeRequests(rootDir) {
  await ensureHelixDirs(rootDir);
  let entries = [];
  try {
    entries = await readdir(resolveHelixPath(rootDir, "changes"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const changes = [];
  for (const entry of entries.filter((name) => /^CR-.+\.json$/.test(name)).sort()) {
    changes.push(await readJson(resolveHelixPath(rootDir, "changes", entry)));
  }
  return changes;
}

export async function writeReviewReport(rootDir, planId, task, reviewResult) {
  await ensureHelixDirs(rootDir);
  const basePath = resolveHelixPath(rootDir, "reports", "reviews", `${planId}-${task.id}`);
  const jsonPath = `${basePath}.json`;
  const mdPath = `${basePath}.md`;
  reviewResult.reportJsonPath = path.relative(rootDir, jsonPath);
  reviewResult.reportMdPath = path.relative(rootDir, mdPath);
  const report = {
    planId,
    taskId: task.id,
    subject: task.subject,
    status: reviewResult.pass ? "pass" : "fail",
    reviewerAgents: reviewResult.reviewerAgents,
    lanes: reviewResult.lanes,
    findings: reviewResult.findings || [],
    testingGaps: reviewResult.testingGaps || [],
    residualRisks: reviewResult.residualRisks || [],
    qualityResults: reviewResult.qualityResults || null,
    llmReviews: reviewResult.llmReviews || [],
    reviewCommandResults: reviewResult.reviewCommandResults,
    standardsCommandResults: reviewResult.standardsCommandResults || [],
    at: reviewResult.at,
  };
  await writeJsonAtomic(jsonPath, report);
  await writeFile(mdPath, renderReviewMarkdown(report), "utf8");
  await appendLedger(rootDir, {
    type: "review_report_written",
    planId,
    taskId: task.id,
    pass: reviewResult.pass,
    reportPath: reviewResult.reportMdPath,
  });
  return report;
}

function renderReviewMarkdown(report) {
  const lanes = report.lanes.map((lane) => `| ${lane.name} | ${lane.agent} | ${lane.status} | ${lane.summary} |`).join("\n");
  const failed = report.lanes
    .filter((lane) => lane.status === "fail")
    .map((lane) => `- ${lane.name}: ${lane.fixBy}`)
    .join("\n");
  const standards = (report.standardsCommandResults || [])
    .map((result) => `| \`${result.command}\` | ${result.exitCode} |`)
    .join("\n");
  const llmReviews = (report.llmReviews || [])
    .map((review) => `- ${review.agent}: ${review.status}${review.summary ? ` - ${review.summary}` : review.reason ? ` - ${review.reason}` : ""}`)
    .join("\n");
  const commentFindings = report.qualityResults?.commentResult?.findings || [];
  const findings = (report.findings || [])
    .map((finding) => [
      `- ${finding.id} [${finding.severity}] ${finding.title}`,
      `  - Source: ${finding.source}${finding.lane ? ` / ${finding.lane}` : ""}`,
      `  - Evidence: ${finding.evidence}`,
      `  - Required fix: ${finding.requiredFix}`,
      `  - Validator: ${finding.validator?.status || "unknown"} (${finding.validator?.name || "unknown"})`,
    ].join("\n"))
    .join("\n");
  const testingGaps = (report.testingGaps || [])
    .map((gap) => `- ${gap.lane}: ${gap.summary}`)
    .join("\n");
  const residualRisks = (report.residualRisks || [])
    .map((risk) => `- ${risk.lane}: ${risk.summary}`)
    .join("\n");
  return `# Review Gate

| Field | Value |
| --- | --- |
| Plan | \`${report.planId}\` |
| Task | \`${report.taskId}\` |
| Subject | ${report.subject} |
| Status | \`${report.status}\` |
| Agents | ${report.reviewerAgents.join(", ")} |

## Lanes

| Lane | Agent | Status | Summary |
| --- | --- | --- | --- |
${lanes}

## Blocking Fixes

${failed || "- None"}

## Structured Findings

${findings || "- None"}

## Testing Gaps

${testingGaps || "- None"}

## Residual Risks

${residualRisks || "- None"}

## Standards Commands

${standards ? `| Command | Exit Code |
| --- | --- |
${standards}` : "- None"}

## LLM Reviews

${llmReviews || "- None"}

## Comment Findings

${commentFindings.length > 0 ? commentFindings.map((finding) => `- ${finding.file}:${finding.line} ${finding.pattern} - ${finding.text}`).join("\n") : "- None"}
`;
}

export async function writeFailureReport(rootDir, planId, task) {
  if (!task.last_failure) return null;
  await ensureHelixDirs(rootDir);
  const basePath = resolveHelixPath(rootDir, "reports", "failures", `${planId}-${task.id}`);
  const jsonPath = `${basePath}.json`;
  const mdPath = `${basePath}.md`;
  task.last_failure.reportJsonPath = path.relative(rootDir, jsonPath);
  task.last_failure.reportMdPath = path.relative(rootDir, mdPath);
  const report = {
    planId,
    taskId: task.id,
    subject: task.subject,
    status: task.status,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    failure: task.last_failure,
  };
  await writeJsonAtomic(jsonPath, report);
  await writeFile(mdPath, renderFailureMarkdown(report), "utf8");
  await appendLedger(rootDir, {
    type: "failure_report_written",
    planId,
    taskId: task.id,
    reason: task.last_failure.reason,
    reportPath: task.last_failure.reportMdPath,
  });
  return report;
}

function renderFailureMarkdown(report) {
  const failure = report.failure;
  return `# Task Failure

| Field | Value |
| --- | --- |
| Plan | \`${report.planId}\` |
| Task | \`${report.taskId}\` |
| Subject | ${report.subject} |
| Status | \`${report.status}\` |
| Attempts | ${report.attempts}/${report.maxAttempts} |
| Reason | \`${failure.reason}\` |

## Retry Hint

\`\`\`text
${failure.retryHint}
\`\`\`

${failure.changeRequest ? `## ChangeRequest

- ID: \`${failure.changeRequest.id}\`
- Report: ${failure.changeRequest.reportMdPath}
- Denied paths: ${(failure.changeRequest.deniedPaths || []).join(", ") || "(none)"}
` : ""}
`;
}

export async function appendWisdom(rootDir, task, verifyResult) {
  const line = `- ${nowIso()} ${task.id}: ${task.subject} verified by ${verifyResult.results.length} command(s).\n`;
  await appendFile(resolveHelixPath(rootDir, "wisdom", "verification.md"), line, "utf8");
}
