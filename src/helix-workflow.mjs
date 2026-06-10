import { copyFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureHelixDirs,
  initRuntime,
  resolveHelixPath,
  writeJsonAtomic,
  writeSnapshot,
} from "./helix-foundation.mjs";
import { importPlan } from "./helix-plan.mjs";
import { statusReport, writeWorkflowSummary } from "./helix-status.mjs";
import { runNextTask } from "./helix-core.mjs";

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
    if (["complete", "blocked", "failed"].includes(result.status)) break;
  }

  const report = await statusReport(rootDir);
  await writeSnapshot(rootDir, "workflow_finished", { status: report });
  const summary = await writeWorkflowSummary(rootDir, { reason: "workflow_finished" });
  return {
    ok: report.failed === 0 && report.pending === 0 && report.in_progress === 0 && report.verifying === 0,
    planId: plan?.id || report.planId,
    results,
    status: report,
    summaryPath: summary.reportMdPath,
  };
}

export async function createSamplePlan(rootDir, targetPath = resolveHelixPath(rootDir, "plans", "sample-plan.json")) {
  await ensureHelixDirs(rootDir);
  const workerScript = "node -e \"const fs=require('fs'); fs.mkdirSync('.helix/artifacts',{recursive:true}); fs.writeFileSync('.helix/artifacts/linear-smoke.txt','ok\\\\n')\"";
  const verifyScript = "node -e \"const fs=require('fs'); const v=fs.readFileSync('.helix/artifacts/linear-smoke.txt','utf8').trim(); if(v!=='ok') process.exit(1)\"";
  const sample = {
    title: "M1 linear loop smoke",
    objective: "Prove Atlas can run one worker task and verify it before checkpoint.",
    tasks: [
      {
        id: "T001",
        subject: "Write smoke artifact",
        description: "Worker writes a small artifact; verifier checks exact content.",
        category: "quick",
        writable_paths: [".helix/artifacts/linear-smoke.txt"],
        worker_command: workerScript,
        verify_commands: [verifyScript],
      },
    ],
  };
  await writeJsonAtomic(targetPath, sample);
  return targetPath;
}

export async function copyPlanTemplate(rootDir, destinationPath) {
  const samplePath = await createSamplePlan(rootDir);
  await copyFile(samplePath, destinationPath);
  return destinationPath;
}
