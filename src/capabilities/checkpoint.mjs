import {
  nowIso,
  resolveTaskCheckpointPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";

export async function writeCheckpoint(rootDir, planId, task, verifyResult, scopeResult = null, reviewResult = null, deliveryBaseline = null) {
  const checkpointPath = resolveTaskCheckpointPath(rootDir, planId, task.id);
  await writeJsonAtomic(checkpointPath, {
    planId,
    taskId: task.id,
    subject: task.subject,
    verifiedAt: nowIso(),
    verifyResult,
    scopeResult,
    reviewResult,
    deliveryBaseline,
  });
}
