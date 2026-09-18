// =============================================================================
// 文件名称：workflow.mjs
// 所属模块：orchestration
// 作用说明：
//   线性工作流驱动：导入计划后循环 runNextTask，直到完成、阻塞或需人工决策；
//   结束时写快照与工作流摘要。含 sample 计划生成供 smoke 路径使用。
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
import {
  ensureWildArrangeDirs,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { initRuntime } from "../infra/runtime-bootstrap.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { importPlan } from "./plan-state.mjs";
import { statusReport, writeWorkflowSummary } from "./status.mjs";
import { runNextTask } from "./linear-runtime.mjs";

/**
 * 运行线性工作流：导入计划后循环推进任务直至终止条件。
 * @param {string} rootDir 项目根目录
 * @param {object} [options] planPath、sample、maxSteps 等
 */
export async function runWorkflow(rootDir, options = {}) {
  await initRuntime(rootDir);
  let plan = null;
  if (options.planPath) {
    plan = await importPlan(rootDir, path.resolve(rootDir, options.planPath), { requireResponsibility: true });
  } else if (options.sample) {
    const samplePath = await createSamplePlan(rootDir);
    plan = await importPlan(rootDir, samplePath);
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

/**
 * 生成 M1 线性 smoke 样例计划 JSON 并写入 plans 目录。
 * @param {string} rootDir 项目根目录
 * @param {string} [targetPath] 输出路径
 */
export async function createSamplePlan(rootDir, targetPath = resolveWildArrangePath(rootDir, "plans", "sample-plan.json")) {
  await ensureWildArrangeDirs(rootDir);
  const workerScript = nodeEvalCommand("const fs=require('fs'); fs.mkdirSync('.wildarrange/artifacts',{recursive:true}); fs.writeFileSync('.wildarrange/artifacts/linear-smoke.txt','ok\\n')");
  const verifyScript = nodeEvalCommand("const fs=require('fs'); const v=fs.readFileSync('.wildarrange/artifacts/linear-smoke.txt','utf8').trim(); if(v!=='ok') process.exit(1)");
  // review_not_tautological 是验收硬地板：样例计划必须自带真实复核信号，
  // 否则 workflow --sample（README 快速上手路径）会在 proof 处被拦下。
  const reviewScript = nodeEvalCommand("const fs=require('fs'); const v=fs.readFileSync('.wildarrange/artifacts/linear-smoke.txt','utf8'); if(!v.includes('ok')) { console.error('review: artifact content mismatch'); process.exit(1); }");
  const sample = {
    title: "M1 linear loop smoke",
    objective: "Prove Jiuwei can run one worker task and verify it before checkpoint.",
    tasks: [
      {
        id: "T001",
        subject: "Write smoke artifact",
        description: "Worker writes a small artifact; verifier checks exact content.",
        category: "quick",
        writable_paths: [".wildarrange/artifacts/linear-smoke.txt"],
        worker_command: workerScript,
        verify_commands: [verifyScript],
        review_commands: [reviewScript],
        successCriteria: [
          {
            id: "C001",
            title: "smoke artifact verified",
            status: "pending",
            expectedEvidence: "verifier checks exact smoke artifact content",
            verifierCommandRefs: [0],
          },
        ],
      },
    ],
  };
  await writeJsonAtomic(targetPath, sample);
  return targetPath;
}

/** 将内联 Node 脚本编码为 `node -e` 单行命令，供样例计划 worker/verify 使用。 */
function nodeEvalCommand(source) {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}
