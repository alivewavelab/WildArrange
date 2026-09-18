// =============================================================================
// 文件名称：checkpoint.mjs
// 所属模块：capabilities
// 作用说明：
//   将任务验收时刻的关键证据快照持久化为 checkpoint JSON，供恢复、
//   对账与 delivery 基线绑定使用。不负责判定 pass/fail。
//
// 【运行原理速读】
//   · 何时执行？交付流水线在 verifier/scope/review 通过后、最终 proof 前。
//   · 做了什么？把 verifyResult、scopeResult、reviewResult、deliveryBaseline
//     写入 .wildarrange 下任务级 checkpoint 路径。
//   · 缺了它会怎样？无法追溯「通过验收时」的精确证据组合与 delivery SHA。
// =============================================================================

import {
  nowIso,
  resolveTaskCheckpointPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";

/**
 * 将验收时刻证据快照原子写入任务 checkpoint 文件。
 * @param {string} rootDir 项目根目录
 * @param {string} planId 计划 ID
 * @param {object} task 任务对象
 * @param {object} verifyResult verifier 证据
 * @param {object|null} [scopeResult] scope guard 结果
 * @param {object|null} [reviewResult] review gate 结果
 * @param {object|null} [deliveryBaseline] delivery commit 基线
 */
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
