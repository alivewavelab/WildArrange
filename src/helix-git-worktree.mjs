import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./helix-gates.mjs";

export async function prepareAgentWorktree(rootDir, taskRunDir, options = {}) {
  if (options.isolation !== "git-worktree") {
    return {
      isolation: "run-dir",
      workDir: taskRunDir,
      available: false,
      reason: "git-worktree isolation is not requested",
    };
  }

  const git = await gitAvailable(rootDir);
  if (!git.available) {
    return {
      isolation: "git-worktree",
      workDir: taskRunDir,
      available: false,
      reason: git.reason,
    };
  }

  const worktreeDir = path.join(taskRunDir, "worktree");
  await mkdir(taskRunDir, { recursive: true });
  const add = await runCommand(`git -C ${shellEscape(rootDir)} worktree add --detach ${shellEscape(worktreeDir)} HEAD`, rootDir, options.timeoutMs);
  if (add.exitCode !== 0) {
    return {
      isolation: "git-worktree",
      workDir: taskRunDir,
      available: false,
      reason: `git worktree add failed: ${add.stderr || add.stdout}`,
    };
  }
  return {
    isolation: "git-worktree",
    workDir: worktreeDir,
    available: true,
    reason: null,
  };
}

export async function collectAgentWorktreePatch(rootDir, worktree, options = {}) {
  if (worktree?.isolation !== "git-worktree" || worktree.available !== true) {
    return null;
  }

  await runCommand(`git -C ${shellEscape(worktree.workDir)} add -N .`, worktree.workDir, options.timeoutMs);
  const patchResult = await runCommand(`git -C ${shellEscape(worktree.workDir)} diff --binary -- .`, worktree.workDir, options.timeoutMs);
  const namesResult = await runCommand(`git -C ${shellEscape(worktree.workDir)} diff --name-only -- .`, worktree.workDir, options.timeoutMs);
  const statusResult = await runCommand(`git -C ${shellEscape(worktree.workDir)} status --short`, worktree.workDir, options.timeoutMs);
  const patch = patchResult.stdout || "";
  const changedPaths = uniqueStrings([
    ...splitLines(namesResult.stdout),
    ...extractPatchPaths(patch),
  ]);
  const patchPath = path.join(path.dirname(worktree.workDir), "agent.patch");
  await writeFile(patchPath, patch, "utf8");

  return {
    kind: "agent_worktree_patch",
    worktreeDir: path.relative(rootDir, worktree.workDir),
    patchPath: path.relative(rootDir, patchPath),
    patch,
    changedPaths,
    status: statusResult.stdout || "",
    exitCode: patchResult.exitCode,
    stderr: patchResult.stderr || "",
  };
}

export async function applyAgentPatch(rootDir, patch, options = {}) {
  if (!patch || typeof patch !== "string" || patch.trim().length === 0) {
    throw new Error("parallel admission patch is empty");
  }
  const patchPath = path.join(rootDir, ".helix", "agent-runs", `admit-${Date.now()}-${process.pid}.patch`);
  await writeFile(patchPath, patch, "utf8");
  const check = await runCommand(`git -C ${shellEscape(rootDir)} apply --check --whitespace=nowarn ${shellEscape(patchPath)}`, rootDir, options.timeoutMs);
  if (check.exitCode !== 0) {
    throw new Error(`parallel admission patch check failed: ${check.stderr || check.stdout}`);
  }
  const apply = await runCommand(`git -C ${shellEscape(rootDir)} apply --whitespace=nowarn ${shellEscape(patchPath)}`, rootDir, options.timeoutMs);
  if (apply.exitCode !== 0) {
    throw new Error(`parallel admission patch apply failed: ${apply.stderr || apply.stdout}`);
  }
  return {
    patchPath: path.relative(rootDir, patchPath),
    exitCode: apply.exitCode,
  };
}

export function extractPatchPaths(patch) {
  return uniqueStrings(String(patch || "")
    .split(/\r?\n/)
    .map((line) => line.match(/^diff --git a\/(.+?) b\/(.+)$/))
    .filter(Boolean)
    .flatMap((match) => [normalizePatchPath(match[1]), normalizePatchPath(match[2])])
    .filter(Boolean));
}

async function gitAvailable(rootDir) {
  const result = await runCommand(`git -C ${shellEscape(rootDir)} rev-parse --show-toplevel`, rootDir, 15_000);
  if (result.exitCode !== 0) {
    return { available: false, reason: "project is not a Git repository" };
  }
  return { available: true, topLevel: result.stdout.trim() };
}

function normalizePatchPath(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/");
  if (!normalized || normalized === "/dev/null") return null;
  if (path.isAbsolute(normalized) || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return normalized;
}

function splitLines(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
