/**
 * Raw read of the current task-state file. Deliberately just the read half:
 * writes (persistTaskState) also re-render tasks.md, which is an
 * orchestration-level concern, so that half stays in
 * orchestration/task-board.mjs. This file exists so capabilities (scope-guard)
 * and infra (memory-digest) can look up "what tasks exist right now" without
 * depending upward on orchestration.
 */
import {
  readJson,
  resolveHelixPath,
} from "./runtime-store.mjs";

export async function loadTaskState(rootDir) {
  return readJson(resolveHelixPath(rootDir, "team", "tasks.json"), null);
}
