// =============================================================================
// 文件名称：workflow.mjs
// 所属模块：orchestration
// 作用说明：
//   线性工作流驱动：导入计划后循环 runNextTask，直到完成、阻塞或需人工决策；
//   结束时写快照与工作流摘要。
//
// 【运行原理速读】
//   可以把它想成「自动跑完计划里能跑的任务」：
//
//   · 何时执行？
//     CLI workflow 命令或集成测试触发。
//
//   · 做了什么？
//     ① 可选导入计划 ② 最多 maxSteps 次 runNextTask ③ 写 snapshot 与 summary。
//
//   · 和谁协作？
//     linear-runtime 推进单步；status 汇总终态。
// =============================================================================
import path from "node:path";
import { initRuntime } from "../infra/runtime-bootstrap.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { importPlan } from "./plan-state.mjs";
import { statusReport, writeWorkflowSummary } from "./status.mjs";
import { runNextTask } from "./linear-runtime.mjs";

/**
 * 运行线性工作流：导入计划后循环推进任务直至终止条件。
 * @param {string} rootDir 项目根目录
 * @param {object} [options] planPath、maxSteps 等
 */
export async function runWorkflow(rootDir, options = {}) {
  await initRuntime(rootDir);
  let plan = null;
  if (options.planPath) {
    plan = await importPlan(rootDir, path.resolve(rootDir, options.planPath));
  }

  const results = [];
  const maxSteps = options.maxSteps || 50;
  for (let step = 0; step < maxSteps; step += 1) {
    const result = await runNextTask(rootDir);
    results.push(result);
    if (["complete", "blocked", "failed", "awaiting_plan_approval", "awaiting_user_decision", "revalidation_required", "readiness_blocked", "recovery_required"].includes(result.status)) break;
  }

  const report = await statusReport(rootDir);
  await writeSnapshot(rootDir, "workflow_finished", { status: report });
  const summary = await writeWorkflowSummary(rootDir, { reason: "workflow_finished" });
  return {
    ok: report.draft === 0 && report.failed === 0 && report.pending === 0 && report.in_progress === 0 && report.verifying === 0,
    planId: plan?.id || report.planId,
    results,
    status: report,
    summaryPath: summary.reportMdPath,
  };
}
