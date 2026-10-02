// =============================================================================
// 文件名称：runtime-plan-approval.test.mjs
// 所属模块：test
// 作用说明：
//   计划批准门与 host 语义计划：批准前不可运行、owner/worker 校验、旧批准记录语义。
// =============================================================================

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { approvePlan, importPlan, loadPlanApproval } from "../src/orchestration/plan-state.mjs";
import { runNextTask } from "../src/orchestration/linear-runtime.mjs";
import { attentionReport } from "../src/orchestration/status.mjs";
import { continuationDirective, resumeReport } from "../src/ai/context.mjs";
import { preToolUseGuard } from "../src/ai/pre-tool-guard.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withExternalProject, declare } from "./helpers/external-fixture.mjs";
import { nodeEval, runInjectionHook, writePolicyConfig, installExternalTestAdapter } from "./helpers/runtime-fixtures.mjs";

/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const SRC_RESPONSIBILITY = declare("src/a.js", "src/before-approval.js", "src/missing.js", "src/read-only.js", "src/result.js");

test("plan approval gate blocks run until developer approves", async () => {
  await withExternalProject(async ({ projectRoot, root, governanceRoot }) => {
    const planPath = path.join(root, "approval-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Approval drill",
      tasks: [{
        id: "T001",
        subject: "should not run before approval",
        writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/a.js','X\\n')\"",
        verify_commands: ["node -e \"const fs=require('fs'); if(!fs.readFileSync('src/a.js','utf8').includes('X')) process.exit(1)\""],
        review_commands: [nodeEval("const fs=require('fs');const lines=fs.readFileSync('src/a.js','utf8').trim().split(/\\r?\\n/);if(lines.length!==1||lines[0]!=='X')process.exit(1)")],
      }],
    }, null, 2));
    await importPlan(projectRoot, planPath);

    const pending = await loadPlanApproval(projectRoot);
    assert.equal(pending.required, true);
    assert.equal(pending.status, "pending");

    const blocked = await runNextTask(projectRoot);
    assert.equal(blocked.status, "awaiting_plan_approval");
    assert.equal(blocked.task, null);

    // attention surfaces the pending approval for the hook/dashboard channel
    const attention = await attentionReport(projectRoot);
    assert.ok(attention.awaitingPlanApproval.length === 1);

    // hook injects the "ask the developer" directive
    const hook = await runInjectionHook(projectRoot, { hook_event_name: "UserPromptSubmit", prompt: "继续" });
    const hookText = JSON.stringify(hook);
    assert.match(hookText, /需要开发者决策/);
    assert.match(hookText, /计划待确认/);

    await approvePlan(projectRoot);
    const approved = await loadPlanApproval(projectRoot);
    assert.equal(approved.status, "approved");

    const ran = await runNextTask(projectRoot);
    assert.equal(ran.status, "completed");
    assert.equal(ran.task.id, "T001");
  });
});

test("host semantic plans require an explicit command-worker task.owner and user approval", async () => {
  await withExternalProject(async ({ projectRoot, root, governanceRoot }) => {
    await installExternalTestAdapter(projectRoot);
    // 治理仓在 plan 导入时被冻结进双仓绑定，所以 reviewer 配置必须先于导入提交。
    const reviewRunner = resolveWildArrangePath(projectRoot, "independent-review-fixture.cjs");
    await writeFile(reviewRunner, `const fs=require('node:fs');const packet=JSON.parse(fs.readFileSync(process.env.WILDARRANGE_READINESS_PACKET||process.env.WILDARRANGE_REVIEW_PACKET,'utf8'));if(packet.kind==='execution_readiness_probe'){console.log(JSON.stringify({ready:true,challenge:packet.challenge,loadedSkills:packet.requiredSkills.map(s=>s.name)}));process.exit(0)}if(!packet.source.files.some(f=>f.path==='src/result.js' && f.content.includes('export const ok = true')))throw Error('missing reviewed implementation');console.log(JSON.stringify({decision:'PASS',checks:Object.keys(packet.rules).map(rule=>({rule,decision:'PASS',reason:'Single fixture artifact, no facts or independent responsibilities added'})),findings:[]}));`);
    await writePolicyConfig(governanceRoot, JSON.stringify({ executionReadiness: { workerProbe: `node "${reviewRunner}"` }, review: { responsibility: { command: `node "${reviewRunner}"` } } }));
    const planPath = path.join(root, "semantic-plan.json");
    await writeFile(planPath, JSON.stringify({
      generated_by: "host_semantic",
      title: "Semantic plan",
      objective: "Deliver one user-approved change.",
      tasks: [{
        id: "T001",
        subject: "Implement the requested change",
        description: "Create the accepted artifact.",
        owner: "ZhuRong",
        writable_paths: ["src/result.js"],
        responsibilityChanges: [{ script: "src/result.js", additions: "Create accepted artifact", responsibilityBefore: "Absent", responsibilityAfter: "Own accepted artifact", facts: [] }],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/result.js','export const ok = true;\\n')\"",
        verify_commands: ["node -e \"const fs=require('fs'); if(!fs.readFileSync('src/result.js','utf8').includes('ok')) process.exit(1)\""],
        review_commands: ["node -e \"const fs=require('fs'); if(!fs.readFileSync('src/result.js','utf8').includes('export const ok = true')) process.exit(1)\""],
        successCriteria: [{
          title: "src/result.js exists and contains ok",
          expectedEvidence: "the verifier reads the file and finds ok",
          verifierCommandRefs: [0],
        }],
      }],
    }, null, 2));

    const imported = await importPlan(projectRoot, planPath);
    assert.equal(imported.tasks[0].owner, "ZhuRong");
    assert.equal(imported.tasks[0].owner_source, "explicit");
    const approval = await loadPlanApproval(projectRoot);
    assert.equal(approval.required, true);
    assert.equal(approval.status, "pending");
    assert.equal((await runNextTask(projectRoot)).status, "awaiting_plan_approval");

    const pendingResume = await resumeReport(projectRoot, { sessionId: "semantic-pending-resume" });
    assert.equal(pendingResume.nextActionDetails.reason, "awaiting_plan_approval");
    assert.equal(pendingResume.nextActionDetails.planId, imported.id);
    assert.equal(pendingResume.nextActionDetails.command, null);
    const pendingContext = await readJson(resolveWildArrangePath(projectRoot, "snapshots", "context.json"));
    assert.equal(pendingContext.nextTask, null);
    const pendingContextMarkdown = await readFile(resolveWildArrangePath(projectRoot, "snapshots", "context.md"), "utf8");
    assert.match(pendingContextMarkdown, /Approve after user confirmation/);
    assert.doesNotMatch(pendingContextMarkdown, /Run next task:.*\brun\b/);
    const pendingStop = await runInjectionHook(projectRoot, {
      hook_event_name: "Stop",
      session_id: "semantic-pending-stop",
      cwd: projectRoot,
    });
    assert.equal(pendingStop.continuation.required, false);
    assert.equal(pendingStop.continuation.reason, "awaiting_plan_approval");
    assert.equal(pendingStop.continuation.nextCommand, null);

    const semanticDraftPath = resolveWildArrangePath(projectRoot, "plan-drafts", "semantic-plan.json");
    const draftEditPending = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "semantic-plan-edit",
      cwd: projectRoot,
      tool_name: "functions.apply_patch",
      tool_input: { command: `*** Begin Patch\n*** Update File: ${semanticDraftPath}\n@@\n {}\n*** End Patch` },
    });
    assert.equal(draftEditPending.decision, "allow");
    assert.equal(draftEditPending.code, "plan_draft_write");

    const arbitraryShellPending = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "semantic-plan-edit",
      cwd: projectRoot,
      tool_name: "Bash",
      tool_input: { command: "node -e \"require('fs').writeFileSync('src/before-approval.js','x')\"" },
    });
    assert.equal(arbitraryShellPending.decision, "deny");
    assert.equal(arbitraryShellPending.code, "awaiting_plan_approval_shell");

    const approveCommandPending = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "semantic-plan-edit",
      cwd: projectRoot,
      tool_name: "Bash",
      tool_input: { command: "node ./bin/wildarrange.mjs plan approve" },
    });
    assert.equal(approveCommandPending.decision, "allow");

    await approvePlan(projectRoot);
    const approvedResume = await resumeReport(projectRoot, { sessionId: "semantic-approved-resume" });
    assert.equal(approvedResume.nextActionDetails.reason, "runnable_task");
    assert.match(approvedResume.nextActionDetails.command, /\brun$/);
    const approvedContinuation = await continuationDirective(projectRoot, { sessionId: "semantic-approved-stop" });
    assert.equal(approvedContinuation.shouldContinue, true);
    assert.match(approvedContinuation.nextCommand, /\brun$/);
    const draftEditApproved = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "semantic-plan-edit",
      cwd: projectRoot,
      taskId: "T001",
      tool_name: "functions.apply_patch",
      tool_input: { command: `*** Begin Patch\n*** Update File: ${semanticDraftPath}\n@@\n {}\n*** End Patch` },
    });
    assert.equal(draftEditApproved.decision, "deny");
    assert.equal(draftEditApproved.code, "out_of_scope");

    const missingOwnerPath = path.join(root, "semantic-plan-missing-owner.json");
    await writeFile(missingOwnerPath, JSON.stringify({
      generated_by: "host_semantic",
      title: "Missing owner",
      tasks: [{
        id: "T002",
        subject: "Must not import",
        description: "The host omitted the actual owner.",
        writable_paths: ["src/missing.js"],
        responsibilityChanges: [{ script: "src/missing.js", additions: "Create accepted artifact", responsibilityBefore: "Absent", responsibilityAfter: "Own accepted artifact", facts: [] }],
        worker_command: "node --version",
        verify_commands: ["node --version"],
        successCriteria: [{
          title: "owner is explicit",
          expectedEvidence: "task.owner is present in the plan",
        }],
      }],
    }, null, 2));
    await assert.rejects(
      () => importPlan(projectRoot, missingOwnerPath),
      /requires explicit command-worker task\.owner.*T002/,
    );

    const readOnlyOwnerPath = path.join(root, "semantic-plan-read-only-owner.json");
    await writeFile(readOnlyOwnerPath, JSON.stringify({
      generated_by: "host_semantic",
      title: "Read-only owner",
      tasks: [{
        id: "T003",
        subject: "Must not enter worker",
        description: "BaiZe cannot own an executable command task.",
        owner: "BaiZe",
        writable_paths: ["src/read-only.js"],
        responsibilityChanges: [{ script: "src/read-only.js", additions: "Create accepted artifact", responsibilityBefore: "Absent", responsibilityAfter: "Own accepted artifact", facts: [] }],
        worker_command: "node --version",
        verify_commands: ["node --version"],
      }],
    }, null, 2));
    await assert.rejects(
      () => importPlan(projectRoot, readOnlyOwnerPath),
      /requires explicit command-worker task\.owner.*T003/,
    );

    const completed = await runNextTask(projectRoot);
    assert.equal(completed.status, "completed");
    assert.match(await readFile(path.join(completed.task.delivery_workspace.workDir, "src", "result.js"), "utf8"), /export const ok = true/);
  });
});

test("host semantic plans reject missing or trivial workers before formal state writes", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const statePaths = [
      resolveWildArrangePath(projectRoot, "work.json"),
      resolveWildArrangePath(projectRoot, "team", "tasks.json"),
      resolveWildArrangePath(projectRoot, "ledger.jsonl"),
    ];
    const readState = () => Promise.all(statePaths.map((statePath) => readFile(statePath, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error))));
    const baseline = await readState();

    for (const [index, workerCommand] of [undefined, "   ", "node --version", "node -e \"process.exit(0)\""] .entries()) {
      const planId = `semantic-invalid-worker-${index}`;
      const planPath = path.join(root, `${planId}.json`);
      const task = {
        id: "T001",
        subject: "Must use a real implementation worker",
        description: "Create the requested source file.",
        owner: "ZhuRong",
        writable_paths: ["src/result.js"],
        responsibilityChanges: [{ script: "src/result.js", additions: "Create accepted artifact", responsibilityBefore: "Absent", responsibilityAfter: "Own accepted artifact", facts: [] }],
        verify_commands: ["node -e \"if(!require('fs').existsSync('src/result.js')) process.exit(1)\""],
        successCriteria: [{ title: "result exists", expectedEvidence: "verifier finds src/result.js", verifierCommandRefs: [0] }],
      };
      if (workerCommand !== undefined) task.worker_command = workerCommand;
      await writeFile(planPath, JSON.stringify({
        id: planId,
        generated_by: "host_semantic",
        title: "Invalid semantic worker",
        tasks: [task],
      }, null, 2));
      await assert.rejects(() => importPlan(projectRoot, planPath), /requires a non-empty, non-trivial worker_command.*T001.*real implementation command/);
      assert.deepEqual(await readState(), baseline, `invalid worker ${JSON.stringify(workerCommand)} must not mutate formal state`);
      await assert.rejects(readFile(resolveWildArrangePath(projectRoot, "plans", `${planId}.json`), "utf8"), /ENOENT/);
    }

    const manualPath = path.join(root, "manual-external-plan.json");
    await writeFile(manualPath, JSON.stringify({
      id: "manual-external-plan",
      title: "Legacy manual external work",
      tasks: [{
        id: "T001",
        subject: "Verify work completed outside the automatic host plan",
        writable_paths: ["src/result.js"],
        responsibilityChanges: declare("src/result.js"),
        verify_commands: ["node -e \"if(!require('fs').existsSync('src/result.js')) process.exit(1)\""],
      }],
    }, null, 2));
    const manual = await importPlan(projectRoot, manualPath);
    assert.equal(manual.tasks[0].worker_command, null);
  });
});
