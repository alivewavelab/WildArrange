import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const HELIX_DIR = ".helix";
export const STATE_VERSION = 1;
export const TASK_STATUSES = new Set(["pending", "in_progress", "verifying", "completed", "failed", "review_blocked", "needs_user_decision"]);

export function nowIso() {
  return new Date().toISOString();
}

export function createWorkId(prefix = "work") {
  return `${prefix}_${randomUUID()}`;
}

export function resolveHelixPath(rootDir, ...segments) {
  return path.join(rootDir, HELIX_DIR, ...segments);
}

export async function ensureHelixDirs(rootDir) {
  const dirs = [
    [],
    ["plans"],
    ["team"],
    ["team", "inbox"],
    ["team", "outbox"],
    ["sessions"],
    ["snapshots"],
    ["artifacts"],
    ["adapters"],
    ["adapters", "codex"],
    ["adapters", "cursor"],
    ["checkpoints"],
    ["reports"],
    ["reports", "failures"],
    ["reports", "reviews"],
    ["reports", "acceptance"],
    ["rules"],
    ["wisdom"],
    ["changes"],
    ["context-agents"],
    ["agent-runs"],
    ["memory"],
    ["memory", "digests"],
    ["memory", "stage-summaries"],
    ["routing"],
    ["routing", "suggestions"],
  ];

  for (const dir of dirs) {
    await mkdir(resolveHelixPath(rootDir, ...dir), { recursive: true });
  }
}

export async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}
