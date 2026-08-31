import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandFile } from "./command-runner.mjs";
import {
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "./runtime-store.mjs";

const GIT_TIMEOUT_MS = 30_000;

export async function ensureDeviceIdentity(rootDir, options = {}) {
  const devicePath = resolveHelixPath(rootDir, "device.json");
  const current = await readJson(devicePath, null);
  if (current && options.force !== true) return current;
  const device = {
    kind: "wildarrange_device",
    version: 1,
    deviceId: current?.deviceId || randomUUID(),
    name: normalizeDeviceName(options.name || current?.name || os.hostname()),
    registeredAt: current?.registeredAt || nowIso(),
    updatedAt: nowIso(),
  };
  await writeJsonAtomic(devicePath, device);
  return device;
}

export async function inspectGitCoordination(rootDir, config = {}) {
  const mode = config.mode || "guarded";
  if (mode === "off") {
    return { enabled: false, active: false, mode, reason: "git coordination is disabled" };
  }
  const topLevelResult = await runGit(rootDir, ["rev-parse", "--show-toplevel"]);
  if (!topLevelResult.ok) {
    return unavailable(mode, "project is not a Git repository");
  }
  const topLevel = await canonicalPath(topLevelResult.stdout.trim());
  if (topLevel !== await canonicalPath(rootDir)) {
    return unavailable(mode, "project root is not the Git toplevel");
  }
  const remote = config.remote || "origin";
  const remoteResult = await runGit(rootDir, ["remote", "get-url", remote]);
  if (!remoteResult.ok) {
    return unavailable(mode, `Git remote ${remote} is not configured`, { topLevel, remote });
  }
  const integrationBranch = await resolveIntegrationBranch(rootDir, remote, config.integrationBranch || "auto");
  const head = await gitHead(rootDir);
  return {
    enabled: true,
    active: true,
    mode,
    topLevel,
    remote,
    remoteConfigured: true,
    integrationBranch,
    headSha: head,
    reason: null,
  };
}

export async function gitHead(rootDir) {
  const result = await runGit(rootDir, ["rev-parse", "HEAD"]);
  if (!result.ok) throw new Error(`cannot resolve Git HEAD: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export async function gitTree(rootDir, ref = "HEAD") {
  const result = await runGit(rootDir, ["rev-parse", `${ref}^{tree}`]);
  if (!result.ok) throw new Error(`cannot resolve Git tree for ${ref}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export async function remoteBranchHead(rootDir, remote, branch) {
  const result = await runGit(rootDir, ["ls-remote", "--heads", remote, `refs/heads/${branch}`], { timeoutMs: 60_000 });
  if (!result.ok) throw new Error(`cannot read ${remote}/${branch}: ${result.stderr || result.stdout}`);
  const first = result.stdout.trim().split(/\s+/)[0];
  return /^[0-9a-f]{40,64}$/i.test(first || "") ? first : null;
}

export async function createRemoteClaim(rootDir, options) {
  const remoteHead = await remoteBranchHead(rootDir, options.remote, options.branch);
  if (remoteHead) {
    throw new Error(`task branch ${options.remote}/${options.branch} is already claimed at ${remoteHead}`);
  }
  const baseSha = options.baseSha || await gitHead(rootDir);
  const claimSha = await createMetadataCommit(rootDir, {
    parentSha: baseSha,
    message: options.message,
  });
  const pushed = await pushCommit(rootDir, {
    remote: options.remote,
    branch: options.branch,
    commitSha: claimSha,
  });
  if (!pushed.ok) {
    throw new Error(`remote task claim lost for ${options.branch}: ${pushed.stderr || pushed.stdout}`);
  }
  return { baseSha, claimSha, remoteHeadSha: claimSha };
}

export async function createMetadataCommit(rootDir, options) {
  const tree = await runGit(rootDir, ["rev-parse", `${options.parentSha}^{tree}`]);
  if (!tree.ok) throw new Error(`cannot resolve parent tree ${options.parentSha}: ${tree.stderr || tree.stdout}`);
  return commitTree(rootDir, tree.stdout.trim(), options.parentSha, options.message);
}

export async function createTaskCheckpointCommit(rootDir, options) {
  const indexPath = resolveHelixPath(rootDir, "coordination", "tmp", `index-${process.pid}-${randomUUID()}`);
  await mkdir(path.dirname(indexPath), { recursive: true });
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    const readTree = await runGit(rootDir, ["read-tree", options.parentSha], { env });
    if (!readTree.ok) throw new Error(`cannot prepare checkpoint index: ${readTree.stderr || readTree.stdout}`);
    if (options.changedPaths.length > 0) {
      const add = await runGit(rootDir, ["add", "-A", "--", ...options.changedPaths], { env });
      if (!add.ok) throw new Error(`cannot stage task paths in temporary index: ${add.stderr || add.stdout}`);
    }
    const tree = await runGit(rootDir, ["write-tree"], { env });
    if (!tree.ok) throw new Error(`cannot write checkpoint tree: ${tree.stderr || tree.stdout}`);
    return commitTree(rootDir, tree.stdout.trim(), options.parentSha, options.message);
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
  }
}

export async function pushCommit(rootDir, options) {
  return runGit(rootDir, [
    "push",
    options.remote,
    `${options.commitSha}:refs/heads/${options.branch}`,
  ], { timeoutMs: 120_000 });
}

export async function fetchRemoteBranch(rootDir, remote, branch) {
  const result = await runGit(rootDir, ["fetch", "--no-tags", remote, `refs/heads/${branch}`], { timeoutMs: 120_000 });
  if (!result.ok) throw new Error(`cannot fetch ${remote}/${branch}: ${result.stderr || result.stdout}`);
  return gitHeadForRef(rootDir, "FETCH_HEAD");
}

export async function commitIsAncestor(rootDir, ancestorSha, descendantRef = "HEAD") {
  if (!ancestorSha) return false;
  const result = await runGit(rootDir, ["merge-base", "--is-ancestor", ancestorSha, descendantRef]);
  return result.ok;
}

export async function switchToTaskBranch(rootDir, branch, commitSha) {
  const result = await runGit(rootDir, ["switch", "-C", branch, commitSha], { timeoutMs: 60_000 });
  if (!result.ok) throw new Error(`cannot switch to task branch ${branch}: ${result.stderr || result.stdout}`);
  return { branch, commitSha };
}

export async function readCommitMessage(rootDir, commitSha) {
  const result = await runGit(rootDir, ["show", "-s", "--format=%B", commitSha]);
  if (!result.ok) throw new Error(`cannot read commit ${commitSha}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export async function listWorkingTreeChanges(rootDir) {
  const groups = await Promise.all([
    runGit(rootDir, ["diff", "--name-only", "-z", "--"]),
    runGit(rootDir, ["diff", "--cached", "--name-only", "-z", "--"]),
    runGit(rootDir, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  for (const result of groups) {
    if (!result.ok) throw new Error(`cannot inspect Git working tree: ${result.stderr || result.stdout}`);
  }
  return [...new Set(groups.flatMap((result) => result.stdout.split("\0").filter(Boolean)))]
    .filter((filePath) => filePath !== ".helix" && !filePath.startsWith(".helix/"))
    .sort();
}

export async function listTreeChanges(rootDir, fromSha, toRef = "HEAD") {
  const result = await runGit(rootDir, ["diff", "--name-only", "-z", fromSha, toRef, "--"]);
  if (!result.ok) throw new Error(`cannot inspect Git tree changes ${fromSha}..${toRef}: ${result.stderr || result.stdout}`);
  return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
}

export async function assertCleanWorkingTree(rootDir) {
  const changedPaths = await listWorkingTreeChanges(rootDir);
  if (changedPaths.length > 0) {
    throw new Error(`working tree must be clean before accepting handoff: ${changedPaths.join(", ")}`);
  }
  return true;
}

export async function captureIntegrationGuard(rootDir, config, options = {}) {
  if (config?.mode === "manual" && options.force !== true) {
    return { active: false, mode: "manual", reason: "manual mode did not request an integration guard" };
  }
  const context = await inspectGitCoordination(rootDir, config);
  if (!context.active) return { active: false, mode: context.mode, reason: context.reason };
  const advertisedSha = await remoteBranchHead(rootDir, context.remote, context.integrationBranch);
  if (!advertisedSha) {
    const reason = `remote integration branch ${context.remote}/${context.integrationBranch} does not exist`;
    if (context.mode === "strict") throw new Error(`git coordination strict mode: ${reason}`);
    return { active: false, mode: context.mode, reason };
  }
  // Fetching here is part of the guard: the later temporary-index commit
  // needs the guarded parent object locally. FETCH_HEAD is deliberately used
  // so no local branch is moved behind the user's back.
  const expectedSha = await fetchRemoteBranch(rootDir, context.remote, context.integrationBranch);
  return {
    active: true,
    remote: context.remote,
    branch: context.integrationBranch,
    expectedSha,
    capturedAt: nowIso(),
  };
}

export async function verifyIntegrationGuard(rootDir, guard) {
  if (!guard?.active) return { pass: true, active: false, reason: guard?.reason || null };
  if (!guard.expectedSha) {
    return { pass: false, active: true, reason: "missing_expected_integration_sha", expectedSha: null, actualSha: null };
  }
  const actualSha = await remoteBranchHead(rootDir, guard.remote, guard.branch);
  return {
    pass: actualSha === guard.expectedSha,
    active: true,
    remote: guard.remote,
    branch: guard.branch,
    expectedSha: guard.expectedSha,
    actualSha,
  };
}

export function taskBranchName(config, planId, taskId) {
  const prefix = String(config.taskBranchPrefix || "wildarrange/task").replace(/^\/+|\/+$/g, "");
  return [prefix, safeRefSegment(planId), safeRefSegment(taskId)].join("/");
}

async function resolveIntegrationBranch(rootDir, remote, configured) {
  if (configured && configured !== "auto") return configured;
  const advertisedHead = await runGit(rootDir, ["ls-remote", "--symref", remote, "HEAD"], { timeoutMs: 60_000 });
  if (advertisedHead.ok) {
    const match = advertisedHead.stdout.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
    if (match) return match[1];
  }
  const remoteHead = await runGit(rootDir, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  if (remoteHead.ok && remoteHead.stdout.trim().startsWith(`${remote}/`)) {
    return remoteHead.stdout.trim().slice(remote.length + 1);
  }
  return "main";
}

async function gitHeadForRef(rootDir, ref) {
  const result = await runGit(rootDir, ["rev-parse", ref]);
  if (!result.ok) throw new Error(`cannot resolve ${ref}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function commitTree(rootDir, treeSha, parentSha, message) {
  const result = await runGit(rootDir, ["commit-tree", treeSha, "-p", parentSha, "-m", message], {
    env: {
      GIT_AUTHOR_NAME: "WildArrange",
      GIT_AUTHOR_EMAIL: "wildarrange@local.invalid",
      GIT_COMMITTER_NAME: "WildArrange",
      GIT_COMMITTER_EMAIL: "wildarrange@local.invalid",
    },
  });
  if (!result.ok) throw new Error(`cannot create coordination commit: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function runGit(rootDir, args, options = {}) {
  const result = await runCommandFile("git", ["-C", rootDir, ...args], rootDir, options.timeoutMs || GIT_TIMEOUT_MS, {
    env: options.env,
    maxOutputChars: 2_000_000,
  });
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function unavailable(mode, reason, extra = {}) {
  if (mode === "strict") throw new Error(`git coordination strict mode: ${reason}`);
  return { enabled: true, active: false, mode, reason, ...extra };
}

function safeRefSegment(value) {
  const normalized = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") throw new Error(`invalid Git task branch segment: ${value}`);
  return normalized;
}

function normalizeDeviceName(value) {
  const normalized = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("device name is required");
  return normalized;
}

async function canonicalPath(value) {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}
