import {
  nowIso,
  resolveHelixPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";

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
