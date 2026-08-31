import { copyFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureHelixDirs,
  resolveHelixPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { initRuntime } from "../infra/runtime-bootstrap.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { importPlan } from "./plan-state.mjs";
import { statusReport, writeWorkflowSummary } from "./status.mjs";
import { runNextTask } from "./linear-runtime.mjs";

export async function runWorkflow(rootDir, options = {}) {
  await initRuntime(rootDir);
  let plan = null;
  if (options.planPath) {
    plan = await importPlan(rootDir, path.resolve(rootDir, options.planPath));
  } else if (options.sample) {
    const samplePath = await createSamplePlan(rootDir);
    plan = await importPlan(rootDir, samplePath);
  }

  const results = [];
  const maxSteps = options.maxSteps || 50;
  for (let step = 0; step < maxSteps; step += 1) {
    const result = await runNextTask(rootDir);
    results.push(result);
    if (["complete", "blocked", "failed", "awaiting_plan_approval", "revalidation_required"].includes(result.status)) break;
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

export async function createSamplePlan(rootDir, targetPath = resolveHelixPath(rootDir, "plans", "sample-plan.json")) {
  await ensureHelixDirs(rootDir);
  const workerScript = nodeEvalCommand("const fs=require('fs'); fs.mkdirSync('.helix/artifacts',{recursive:true}); fs.writeFileSync('.helix/artifacts/linear-smoke.txt','ok\\n')");
  const verifyScript = nodeEvalCommand("const fs=require('fs'); const v=fs.readFileSync('.helix/artifacts/linear-smoke.txt','utf8').trim(); if(v!=='ok') process.exit(1)");
  // review_not_tautological 是验收硬地板：样例计划必须自带真实复核信号，
  // 否则 workflow --sample（README 快速上手路径）会在 proof 处被拦下。
  const reviewScript = nodeEvalCommand("const fs=require('fs'); const v=fs.readFileSync('.helix/artifacts/linear-smoke.txt','utf8'); if(!v.includes('ok')) { console.error('review: artifact content mismatch'); process.exit(1); }");
  const sample = {
    title: "M1 linear loop smoke",
    objective: "Prove Jiuwei can run one worker task and verify it before checkpoint.",
    tasks: [
      {
        id: "T001",
        subject: "Write smoke artifact",
        description: "Worker writes a small artifact; verifier checks exact content.",
        category: "quick",
        writable_paths: [".helix/artifacts/linear-smoke.txt"],
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

function nodeEvalCommand(source) {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

export async function copyPlanTemplate(rootDir, destinationPath) {
  const samplePath = await createSamplePlan(rootDir);
  await copyFile(samplePath, destinationPath);
  return destinationPath;
}
