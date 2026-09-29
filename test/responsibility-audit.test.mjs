// =============================================================================
// 文件名称：responsibility-audit.test.mjs
// 所属模块：test
// 作用说明：
//   验证责任声明与审计：字段/重复/越界拒绝、新 host plan 须先声明、
//   独立 reviewer 全脚本、R3 拒绝带证据、伪造/矛盾 PASS 不可过。
//   不测：多语言源码语义理解或自动 codegen。
//
// 【运行原理速读】
//   fixture reviewer 命令 + importPlan/approvePlan，
//   跑 runResponsibilityAudit/runReviewGate 断言 verdict 与 evidence 绑定。
// =============================================================================

import { resolveTaskAcceptancePath, resolveTaskCheckpointPath, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { gitCommitAll, withExternalProject } from "./helpers/external-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeResponsibilityChanges, RESPONSIBILITY_RULES } from "../src/infra/responsibility-contract.mjs";
import { collectResponsibilityEvidence } from "../src/infra/responsibility-evidence.mjs";
import { runResponsibilityAudit, validateResponsibilityVerdict } from "../src/capabilities/responsibility-audit.mjs";
import { importPlan, approvePlan, loadTaskState } from "../src/orchestration/plan-state.mjs";
import { runReviewGate } from "../src/capabilities/review-gate.mjs";

const changes = () => [{ script: "router.mjs", additions: "Select config", responsibilityBefore: "Route requests", responsibilityAfter: "Route requests by version", facts: [{ name: "gameId/buildId", ownerBefore: "records.mjs", ownerAfter: "records.mjs", access: "records.readGame()" }] }];
const verdict = () => ({ decision: "PASS", checks: Object.keys(RESPONSIBILITY_RULES).map((rule) => ({ rule, decision: "PASS", reason: "Reviewed source and approved declaration" })), findings: [] });
/** 项目仓之外的临时目录：reviewer 脚本与计划文件放这里，保持项目工作区基线干净。 */
function auxDir(root) {
  return path.dirname(root);
}
/** 打开外置三根项目并随测试结束（t.after）释放。 */
async function openProject(t, options) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const finished = withExternalProject(async (roots) => { ready(roots); await held; }, options);
  finished.catch((error) => ready(Promise.reject(error)));
  t.after(async () => { release(); await finished; });
  return started;
}
/** 写入 reviewer 脚本并返回指向它的 review 配置。 */
async function writeReviewer(root, answer, name = "reviewer.cjs", { probe = false } = {}) {
  const file = path.join(auxDir(root), name);
  // probe：同一脚本兼作执行就绪握手（readiness packet 没有 source 字段）
  const packetEnv = probe ? "process.env.WILDARRANGE_READINESS_PACKET||process.env.WILDARRANGE_REVIEW_PACKET" : "process.env.WILDARRANGE_REVIEW_PACKET";
  const probeBranch = probe ? "if(packet.kind==='execution_readiness_probe'){console.log(JSON.stringify({ready:true,challenge:packet.challenge,loadedSkills:packet.requiredSkills.map(s=>s.name)}));process.exit(0);}" : "";
  await writeFile(file, `const fs=require('node:fs');const packet=JSON.parse(fs.readFileSync(${packetEnv},'utf8'));${probeBranch}if(!packet.source.files.some(f=>f.path==='records.mjs'))process.exit(1);console.log(${JSON.stringify(JSON.stringify(answer))});`);
  const command = `node "${file}"`;
  return { ...(probe ? { executionReadiness: { workerProbe: command } } : {}), review: { responsibility: { command } } };
}
// options.reviewerAnswer：把 reviewer 配置提交进治理仓后再导入计划；options.taskOverrides：覆盖计划任务字段。
async function fixture(t, options = {}) {
  const { projectRoot: root, governanceRoot } = await openProject(t, { projectFiles: {
    "README.md": "# Fixture project\n",
    "router.mjs": "export const route = () => 'config';\n",
    "records.mjs": "export const readGame = () => ({ gameId: 'g', buildId: 'b' });\n",
  } });
  if (options.reviewerAnswer) {
    await writeFile(path.join(governanceRoot, "policy", "wildarrange.config.json"), JSON.stringify(await writeReviewer(root, options.reviewerAnswer, "reviewer.cjs", { probe: true })));
    await gitCommitAll(governanceRoot, "responsibility reviewer config");
  }
  const planPath = path.join(auxDir(root), "probe-plan.json");
  const raw = { title: "Responsibility check", generated_by: "host_semantic", tasks: [{ id: "T001", subject: "Adjust routing", owner: "ZhuRong", writable_paths: ["router.mjs"], worker_command: "node implement.mjs", verify_commands: ["node validate.mjs"], responsibilityChanges: changes(), ...options.taskOverrides }] };
  await writeFile(planPath, JSON.stringify(raw));
  await importPlan(root, planPath);
  await approvePlan(root);
  const task = (await loadTaskState(root)).tasks[0];
  const scope = { status: "pass", changedPaths: ["router.mjs"] };
  return { root, task, scope, raw, planPath };
}
async function reviewer(root, answer) {
  return writeReviewer(root, answer);
}

test("responsibility declaration rejects absent fields, duplicate scripts and out-of-scope targets", () => {
  assert.throws(() => normalizeResponsibilityChanges([{}], ["router.mjs"]), /required/);
  assert.throws(() => normalizeResponsibilityChanges([...changes(), ...changes()], ["router.mjs"]), /duplicate/);
  assert.throws(() => normalizeResponsibilityChanges(changes(), ["other.mjs"]), /outside/);
  assert.deepEqual(normalizeResponsibilityChanges(changes(), ["router.mjs"]), changes());
});

test("new host plans require declarations before writing formal task state", async (t) => {
  const { root, raw, planPath } = await fixture(t);
  delete raw.tasks[0].responsibilityChanges;
  await writeFile(planPath, JSON.stringify(raw));
  const before = await readFile(resolveWildArrangePath(root, "team", "tasks.json"), "utf8");
  await assert.rejects(importPlan(root, planPath), /requires responsibilityChanges/);
  assert.equal(await readFile(resolveWildArrangePath(root, "team", "tasks.json"), "utf8"), before);
});

test("audit requires a real reviewer and rejects post-approval declaration changes", async (t) => {
  const { root, task, scope } = await fixture(t);
  assert.match((await runResponsibilityAudit(root, task, scope, {})).summary, /unavailable/);
  task.responsibilityChanges[0].responsibilityAfter = "Own all state";
  assert.match((await runResponsibilityAudit(root, task, scope, {})).summary, /R1/);
  delete task.responsibilityChanges;
  assert.equal((await runResponsibilityAudit(root, task, scope, {})).pass, false);
});

test("independent reviewer sees full scripts and owners; valid PASS remains bound to current evidence", async (t) => {
  const { root, task, scope } = await fixture(t);
  const result = await runResponsibilityAudit(root, task, scope, await reviewer(root, verdict()));
  assert.equal(result.pass, true, result.summary);
  assert.equal(result.checks.length, 5);
  assert.ok(result.sourceDigest);
  const packet = JSON.parse(await readFile(result.packetPath, "utf8"));
  assert.equal(packet.source.files.find((f) => f.path === "records.mjs").content, await readFile(path.join(root, "records.mjs"), "utf8"));
});

test("R3 rejection carries verified code evidence and fixing the finding allows re-review", async (t) => {
  const { root, task, scope } = await fixture(t);
  await writeFile(path.join(root, "router.mjs"), "const duplicateBuildId = 'b';\n");
  const answer = verdict();
  answer.decision = "RETURN";
  answer.checks.find((c) => c.rule === "R3").decision = "RETURN";
  answer.findings.push({ rule: "R3", file: "router.mjs", line: 1, evidence: "const duplicateBuildId = 'b';", reason: "Maintains build identity independently", requiredFix: "Read from records.mjs" });
  const failed = await runResponsibilityAudit(root, task, scope, await reviewer(root, answer));
  assert.equal(failed.pass, false);
  assert.match(failed.summary, /R3 router.mjs:1/);
  await writeFile(path.join(root, "router.mjs"), "export { readGame } from './records.mjs';\n");
  const passed = await runResponsibilityAudit(root, task, scope, await reviewer(root, verdict()));
  assert.equal(passed.pass, true, passed.summary);
  assert.notEqual(passed.sourceDigest, failed.sourceDigest);
});

test("fabricated evidence, missing rules and contradictory PASS cannot pass review", () => {
  const source = { files: [{ path: "router.mjs", content: "real line" }] };
  assert.throws(() => validateResponsibilityVerdict({ decision: "PASS" }, source), /cover/);
  const answer = verdict(); answer.checks[0].decision = "RETURN";
  assert.throws(() => validateResponsibilityVerdict(answer, source), /needs evidence/);
  answer.findings = [{ rule: "R1", file: "router.mjs", line: 1, evidence: "invented", reason: "Mismatch", requiredFix: "Fix" }];
  assert.throws(() => validateResponsibilityVerdict(answer, source), /exact reviewed/);
});

test("source collection refuses truncation and undeclared changed scripts are rejected", async (t) => {
  const { root, task, scope } = await fixture(t);
  await assert.rejects(collectResponsibilityEvidence(root, changes(), scope.changedPaths, 10), /budget/);
  const result = await runResponsibilityAudit(root, task, { ...scope, changedPaths: ["other.mjs"] }, {});
  assert.match(result.summary, /R1.*other.mjs/);
});

test("shared Review fails when responsibility audit is unavailable", async (t) => {
  const { root, task, scope } = await fixture(t);
  const result = await runReviewGate(root, task, { scopeResult: scope });
  assert.equal(result.pass, false);
  assert.equal(result.lanes.find((lane) => lane.name === "responsibility_audit").status, "fail");
  assert.match(result.findings.find((f) => f.lane === "responsibility_audit").evidence, /unavailable/);
});
import { runDeliveryPipeline } from "../src/orchestration/delivery-pipeline.mjs";
import { steerWorkflow } from "../src/orchestration/change-governance.mjs";
import { loadPlanApproval } from "../src/orchestration/plan-state.mjs";

test("responsibility rejection prevents acceptance proof and checkpoint even when verifier passes", async (t) => {
  const { root, task } = await fixture(t);
  task.verify_commands = ["node -e \"require('node:assert/strict').ok(require('node:fs').existsSync('router.mjs'))\""];
  const result = await runDeliveryPipeline(root, task.planId, task, {
    changedPaths: ["router.mjs"],
    initialEvidence: { workerResult: { kind: "worker", exitCode: 0, stdout: "", stderr: "" } },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.steps.find((s) => s.capability === "verify").status, "pass");
  assert.deepEqual(result.steps.map((s) => s.capability), ["verify", "scope", "review"]);
  await assert.rejects(readFile(resolveTaskCheckpointPath(root, task.planId, "T001")), /ENOENT/);
});

test("revising responsibilities uses existing steering and returns to human approval", async (t) => {
  const { root, task } = await fixture(t);
  const revised = changes(); revised[0].additions = "Select version-specific config";
  const result = await steerWorkflow(root, { kind: "revise_acceptance", targetTaskId: task.id, evidence: "Review R1 identified a missing responsibility", rationale: "Clarify approved routing behavior", responsibilityChanges: revised });
  assert.equal(result.accepted, true);
  assert.equal((await loadPlanApproval(root)).status, "pending");
  const current = (await loadTaskState(root)).tasks[0];
  const config = await reviewer(root, verdict());
  assert.equal((await runResponsibilityAudit(root, current, { status: "pass", changedPaths: ["router.mjs"] }, config)).pass, false);
  await approvePlan(root);
  assert.equal((await runResponsibilityAudit(root, current, { status: "pass", changedPaths: ["router.mjs"] }, config)).pass, true);
});

test("public-style import cannot omit host marker to avoid declarations", async (t) => {
  const { root, raw, planPath } = await fixture(t);
  delete raw.generated_by; delete raw.tasks[0].responsibilityChanges;
  await writeFile(planPath, JSON.stringify(raw));
  await assert.rejects(importPlan(root, planPath, { requireResponsibility: true }), /requires responsibilityChanges/);
});

test("reviewer changes to source invalidate the verdict", async (t) => {
  const { root, task, scope } = await fixture(t);
  const file = path.join(auxDir(root), "mutating-reviewer.cjs");
  await writeFile(file, `require('node:fs').appendFileSync('router.mjs','// changed during review\\n'); console.log(${JSON.stringify(JSON.stringify(verdict()))});`);
  const result = await runResponsibilityAudit(root, task, scope, { review: { responsibility: { command: `node "${file}"` } } });
  assert.equal(result.pass, false);
  assert.match(result.summary, /Source changed/);
});

test("malformed reviewer output cannot become PASS", async (t) => {
  const { root, task, scope } = await fixture(t);
  const result = await runResponsibilityAudit(root, task, scope, await reviewer(root, { decision: "PASS", checks: [] }));
  assert.equal(result.pass, false);
  assert.match(result.summary, /cover R1-R5/);
});

test("binary assets are fingerprinted without pretending they are source text", async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, "icon.png"), Buffer.from([137, 80, 78, 71, 0, 1]));
  const source = await collectResponsibilityEvidence(root, changes(), ["router.mjs", "icon.png"]);
  const asset = source.files.find((file) => file.path === "icon.png");
  assert.equal(asset.binary, true);
  assert.equal(asset.content, null);
  assert.equal(asset.hash.length, 64);
});

import { buildAcceptanceProof } from "../src/capabilities/acceptance-proof.mjs";

test("old Review PASS cannot replace the new responsibility audit receipt", async (t) => {
  const { task } = await fixture(t);
  const proof = buildAcceptanceProof(task.planId, task, { reviewResult: { kind: "review_gate", pass: true, lanes: [{ name: "old", status: "pass" }] } });
  assert.equal(proof.checks.find((check) => check.name === "responsibility_audit_bound" || check.id === "responsibility_audit_bound")?.status, "fail");
});

test("independent responsibility PASS is sufficient as the substantive review lane", async (t) => {
  // 外置项目是 Git 仓，交付必须经隔离 worktree 与 delivery commit，因此走真实 linear 运行。
  const { root, task } = await fixture(t, {
    reviewerAnswer: verdict(),
    taskOverrides: {
      worker_command: "node -e \"require('node:fs').writeFileSync('router.mjs', 'export const route = () => \\'versioned\\';\\n')\"",
      verify_commands: ["node -e \"require('node:assert/strict').ok(require('node:fs').existsSync('router.mjs'))\""],
      successCriteria: [{ id: "C001", title: "Router exists", expectedEvidence: "File exists", status: "pending", evidence: [], verifierCommandRefs: [0] }],
    },
  });
  const result = await runNextTask(root);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.reviewResult.responsibilityAudit.pass, true);
  const proof = JSON.parse(await readFile(resolveTaskAcceptancePath(root, task.planId, "T001"), "utf8"));
  assert.equal(proof.pass, true);
});


test("review process recovery evidence stops delivery before checkpoint", async (t) => {
  const { root, task } = await fixture(t);
  task.verify_commands = ['node -e "if(!process.version)process.exit(1)"'];
  const recovery = { exitCode: 1, terminationFailed: true, recoveryRequired: true, pid: 12345 };
  const result = await runDeliveryPipeline(root, task.planId, task, {
    initialEvidence: {
      workerResult: { kind: "worker", exitCode: 0 },
      reviewResult: { kind: "review_gate", pass: false, commandRecovery: recovery },
    },
  });
  assert.equal(result.status, "recovery_required");
  assert.deepEqual(result.evidence.commandRecovery, recovery);
  assert.equal(result.steps.some(step => step.capability === "checkpoint"), false);
  await assert.rejects(readFile(resolveTaskAcceptancePath(root, task.planId, task.id)), /ENOENT/);
});

import { createTeamTask, readyTeamTask } from "../src/orchestration/task-board.mjs";
import { runNextTask, executeTaskNode } from "../src/orchestration/linear-runtime.mjs";
import { runParallelAgents } from "../src/orchestration/parallel-runtime.mjs";

test("new task responsibility declarations reopen approval before any worker starts", async (t) => {
  const { root } = await fixture(t);
  await createTeamTask(root, { id: "T002", subject: "New scoped work", writable_paths: ["router.mjs"], verify_commands: ["node validate.mjs"], worker_command: "node implement.mjs", responsibilityChanges: changes() });
  assert.equal((await loadPlanApproval(root)).status, "pending");
  assert.equal((await runNextTask(root)).status, "awaiting_plan_approval");
  assert.equal((await executeTaskNode(root, { taskId: "T002" })).status, "awaiting_plan_approval");
  const parallel = await runParallelAgents(root, { taskId: "T002" });
  assert.equal(parallel.status, "awaiting_plan_approval");
  assert.equal(parallel.runId, null);
  assert.equal((await loadTaskState(root)).tasks.every(task => task.attempts === 0), true);
  await approvePlan(root);
  const task = (await loadTaskState(root)).tasks.find(task => task.id === "T002");
  assert.equal((await runResponsibilityAudit(root, task, { status: "pass", changedPaths: ["router.mjs"] }, await reviewer(root, verdict()))).pass, true);
});

test("readying a draft with responsibilities reopens approval", async (t) => {
  const { root } = await fixture(t);
  await createTeamTask(root, { id: "T002", subject: "Draft" });
  await readyTeamTask(root, { taskId: "T002", patch: { writable_paths: ["router.mjs"], verify_commands: ["node validate.mjs"], responsibilityChanges: changes() } });
  assert.equal((await runNextTask(root)).status, "awaiting_plan_approval");
});
