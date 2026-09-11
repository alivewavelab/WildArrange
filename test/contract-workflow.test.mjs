import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveTaskCheckpointPath } from "../src/infra/runtime-store.mjs";
import { importPlan, approvePlan, loadTaskState } from "../src/orchestration/plan-state.mjs";
import { runNextTask } from "../src/orchestration/linear-runtime.mjs";
import { prepareContractReview, proposeContractChange, resolveContractChange } from "../src/orchestration/contract-governance.mjs";
import { recordContractChangeDecision, resolveChangeRequest } from "../src/orchestration/change-governance.mjs";
import { runHostHook } from "../src/orchestration/host-runtime.mjs";
import { runInjectionHook } from "../src/ai/hooks.mjs";
import { runParallelAgents, admitParallelAgentResult } from "../src/orchestration/parallel-runtime.mjs";
import { runCommandFile } from "../src/infra/command-runner.mjs";
import { scanContractGovernanceUniverse, persistContractScan } from "../src/infra/contract-governance.mjs";
import { applyContractCardDecision } from "../src/capabilities/contract-governance.mjs";

const sourcePath = "src-tauri/src/lib.rs";
const rust = '#[tauri::command]\nfn greet(name: String) -> String { name }\nfn main(){ tauri::generate_handler![greet]; }\n';
const declaration = { contractId: "tauri:greet", kind: "tauri_command", action: "add", summary: "问候接口",
  sourcePaths: [sourcePath], expected: { signatures: ["greet(name: String) -> String"] } };

async function fixture(t, items = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wa-contract-flow-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  await initRuntime(root);
  await mkdir(path.join(root, "src-tauri/src"), { recursive: true });
  await writeFile(path.join(root, "worker.cjs"), `const fs=require('fs'); fs.appendFileSync('.wildarrange/worker-count','1'); fs.writeFileSync('${sourcePath}',${JSON.stringify(rust)});`);
  await writeFile(path.join(root, "verify.cjs"), `require('assert').match(require('fs').readFileSync('${sourcePath}','utf8'),/fn greet/);`);
  await writeFile(path.join(root, "review.cjs"), `require('assert').match(require('fs').readFileSync('${sourcePath}','utf8'),/generate_handler/);`);
  const planPath = path.join(root, "plan.json");
  await writeFile(planPath, JSON.stringify({ id: "contract-flow", title: "Contract flow", tasks: [{ id: "T1", subject: "新增问候", owner: "ZhuRong",
    worker_command: "node worker.cjs", verify_commands: ["node verify.cjs"], review_commands: ["node review.cjs"], writable_paths: [sourcePath],
    contractChanges: { items } }] }));
  await importPlan(root, planPath);
  return root;
}

test("planned exact interface passes without a second approval or writing a shared registry", async (t) => {
  const root = await fixture(t, [declaration]);
  await approvePlan(root);
  const result = await runNextTask(root);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal((await loadTaskState(root)).tasks[0].status, "completed");
  assert.equal(await readJson(path.join(root, "tooling/contracts/contract-registry.json"), null), null);
  assert.ok(await readJson(resolveTaskCheckpointPath(root, "contract-flow", "T1"), null));
});

test("unplanned interface waits across sessions, approval resumes gates, changed signature needs a new decision", async (t) => {
  const root = await fixture(t);
  const result = await runNextTask(root);
  assert.equal(result.status, "awaiting_user_decision", JSON.stringify(result));
  const request = result.changeRequest;
  assert.equal((await loadTaskState(root)).tasks[0].status, "needs_user_decision");
  assert.equal(await readJson(resolveTaskCheckpointPath(root, "contract-flow", "T1"), null), null);
  const again = await runNextTask(root);
  assert.equal(again.changeRequest.id, request.id);
  assert.equal(await readFile(path.join(root, ".wildarrange/worker-count"), "utf8"), "1");
  const hook = await runHostHook(root, { event: "SessionStart", sessionId: "new-session" }, runInjectionHook);
  assert.match(hook.output, new RegExp(request.id));
  assert.match(hook.output, /计划外接口\/数据库变更/);
  await assert.rejects(resolveChangeRequest(root, { id: request.id, decision: "accept", evidence: "reviewed", rationale: "confirmed" }), /contracts resolve/);
  const options = { id: request.id, decision: "accept", expectedFingerprint: request.fingerprint, reason: "用户确认新增问候接口" };
  await assert.rejects(resolveContractChange(root, { ...options, expectedFingerprint: "old" }), /changed/);
  // Persisted decision + interrupted task write must be replayable.
  await recordContractChangeDecision(root, options);
  await resolveContractChange(root, options);
  await resolveContractChange(root, options);
  const completed = await runNextTask(root);
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  assert.equal(await readFile(path.join(root, ".wildarrange/worker-count"), "utf8"), "1");
  await writeFile(path.join(root, sourcePath), rust.replace("name: String", "name: u32"));
  const state = await loadTaskState(root);
  const changed = await prepareContractReview(root, state.planId, state.tasks[0], root, {
    verifyResult: { pass: true }, scopeResult: { status: "pass", changedPaths: [sourcePath] },
  });
  assert.equal(changed.status, "fail");
  assert.notEqual(changed.changeRequest.id, request.id);
});

test("database proposal carries impact and rejection cannot trigger worker retries", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "proposal.json"), JSON.stringify({ reason: "新功能必须保存语言", impact: "users 表增加 locale，可空，无存量迁移", alternatives: "会话内保存", recommendation: "增加可空字段",
    items: [{ contractId: "db:users.locale", kind: "database", action: "add", summary: "用户语言", sourcePaths: [sourcePath], expected: { table: "users", column: "locale", nullable: true } }] }));
  const proposed = await proposeContractChange(root, { taskId: "T1", from: "proposal.json" });
  assert.match(proposed.request.evidence, /locale/);
  await resolveContractChange(root, { id: proposed.request.id, decision: "reject", expectedFingerprint: proposed.request.fingerprint, reason: "先用会话保存" });
  assert.equal((await runNextTask(root)).status, "awaiting_user_decision");
  assert.equal((await loadTaskState(root)).tasks[0].attempts, 0);
  assert.equal(await readJson(resolveTaskCheckpointPath(root, "contract-flow", "T1"), null), null);
});

test("worker proposes before implementation without a nested task lock", async (t) => {
  const root = await fixture(t);
  const proposal = { reason: "需要问候接口", impact: "新增一个 IPC，无数据库迁移", alternatives: "前端本地生成", recommendation: "批准 IPC", items: [declaration] };
  await writeFile(path.join(root, "worker.cjs"), `console.log('WILDARRANGE_CONTRACT_CHANGE='+JSON.stringify(${JSON.stringify(proposal)}));`);
  const result = await runNextTask(root);
  assert.equal(result.status, "awaiting_user_decision");
  assert.equal(result.changeRequest.content.beforeImplementation, true);
  assert.equal(await readJson(resolveTaskCheckpointPath(root, "contract-flow", "T1"), null), null);
});

test("admission restores shared files while waiting and replays against a fresh preimage after approval", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, sourcePath), "// original\n");
  await writeFile(path.join(root, "parallel.cjs"), `require('fs').writeFileSync(process.argv[2], JSON.stringify({summary:'IPC', files:[{path:${JSON.stringify(sourcePath)},content:${JSON.stringify(rust)}}]}));`);
  const batch = await runParallelAgents(root, { taskIds: ["T1"], agent: "ZhuRong", command: `node "${path.join(root, "parallel.cjs")}" {outputJson}` });
  const options = { runId: batch.runId, taskId: "T1" };
  const waiting = await admitParallelAgentResult(root, options);
  assert.equal(waiting.status, "awaiting_user_decision", JSON.stringify(waiting));
  assert.equal(waiting.rollback.status, "rolled_back");
  assert.equal(await readFile(path.join(root, sourcePath), "utf8"), "// original\n");
  assert.equal((await loadTaskState(root)).tasks[0].admission_claim.workspaceRestored, true);
  const repeated = await admitParallelAgentResult(root, options);
  assert.equal(repeated.changeRequest.id, waiting.changeRequest.id);
  // A later independent change must not be erased by the old preimage.
  await writeFile(path.join(root, sourcePath), "// later independent change\n");
  await resolveContractChange(root, { id: waiting.changeRequest.id, expectedFingerprint: waiting.changeRequest.fingerprint, decision: "accept", reason: "用户批准" });
  await writeFile(path.join(root, "verify.cjs"), "process.exit(1)");
  const failed = await admitParallelAgentResult(root, options);
  assert.notEqual(failed.status, "completed");
  assert.equal(await readFile(path.join(root, sourcePath), "utf8"), "// later independent change\n");
  assert.equal((await loadTaskState(root)).tasks[0].admission_claim, null);
});

test("rejecting an admission proposal releases only its already restored workspace claim", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "parallel.cjs"), `require('fs').writeFileSync(process.argv[2], JSON.stringify({summary:'IPC', files:[{path:${JSON.stringify(sourcePath)},content:${JSON.stringify(rust)}}]}));`);
  const batch = await runParallelAgents(root, { taskIds: ["T1"], agent: "ZhuRong", command: `node "${path.join(root, "parallel.cjs")}" {outputJson}` });
  const waiting = await admitParallelAgentResult(root, { runId: batch.runId, taskId: "T1" });
  await resolveContractChange(root, { id: waiting.changeRequest.id, expectedFingerprint: waiting.changeRequest.fingerprint, decision: "reject", reason: "不新增接口" });
  const state = await loadTaskState(root);
  assert.equal(state.tasks[0].admission_claim, null);
  assert.equal(state.tasks[0].status, "needs_user_decision");
  await assert.rejects(readFile(path.join(root, sourcePath)), /ENOENT/);
});

test("CLI proposal and decision expose a durable human-readable request", async (t) => {
  const root = await fixture(t);
  const cli = path.resolve("bin/wildarrange.mjs");
  await writeFile(path.join(root, "proposal.json"), JSON.stringify({ reason: "需要新增问候", impact: "客户端增加一个 IPC", alternatives: "客户端计算", recommendation: "增加 IPC", items: [declaration] }));
  const proposed = await runCommandFile(process.execPath, [cli, "contracts", "propose", "--task", "T1", "--from", "proposal.json"], root);
  assert.equal(proposed.exitCode, 0, proposed.stderr);
  const request = JSON.parse(proposed.stdout).request;
  assert.match(await readFile(path.join(root, request.reportMdPath), "utf8"), /客户端增加一个 IPC/);
  const resolved = await runCommandFile(process.execPath, [cli, "contracts", "resolve", "--id", request.id, "--decision", "accept", "--expected-fingerprint", request.fingerprint, "--reason", "用户确认具体接口"], root);
  assert.equal(resolved.exitCode, 0, resolved.stderr);
  assert.equal((await loadTaskState(root)).tasks[0].status, "pending");
});

test("SQL observations stay explicitly manual", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, sourcePath), `${rust}\nconst SQL: &str = "ALTER TABLE users ADD COLUMN locale TEXT";`);
  const state = await loadTaskState(root);
  const evidence = { scopeResult: { status: "pass", changedPaths: [sourcePath] }, verifyResult: { pass: true } };
  const review = await prepareContractReview(root, state.planId, state.tasks[0], root, evidence);
  assert.equal(review.status, "fail");
  assert.ok(review.scan.coverage.manualRequired.some((item) => item.kind === "database_sql_in_source"));
  assert.ok(review.scan.coverage.unknown.some((item) => item.fields.includes("semantic_input_output")));
});

test("an approved remove declaration cannot hide an interface that still exists", async (t) => {
  const root = await fixture(t, [{ ...declaration, action: "remove", compatibility: "移除调用方", rollback: "恢复旧版本" }]);
  await writeFile(path.join(root, sourcePath), rust);
  const scan = await scanContractGovernanceUniverse(root);
  await persistContractScan(root, scan);
  for (const card of scan.cards) await applyContractCardDecision(root, { cardId: card.id, decision: "approve", reason: "确认既有基线", expectedFingerprint: card.fingerprint });
  await approvePlan(root);
  const state = await loadTaskState(root);
  const evidence = { scopeResult: { status: "pass", changedPaths: [sourcePath] }, verifyResult: { pass: true } };
  const review = await prepareContractReview(root, state.planId, state.tasks[0], root, evidence);
  assert.equal(review.status, "fail");
  assert.ok(review.changeRequest);
  assert.equal(await readJson(resolveTaskCheckpointPath(root, state.planId, "T1"), null), null);
});
