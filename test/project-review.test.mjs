import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { importPlan, approvePlan, loadTaskState } from "../src/orchestration/plan-state.mjs";
import { runNextTask } from "../src/orchestration/linear-runtime.mjs";
import { runParallelAgents } from "../src/orchestration/parallel-runtime.mjs";
import { prepareProjectReview, runProjectReview, hasAcceptedProjectReview } from "../src/capabilities/project-review.mjs";
import { checkExecutionReadiness } from "../src/capabilities/execution-readiness.mjs";
import { loadMarkdownAttachment } from "../src/infra/context-attachments.mjs";
import { resolveTaskAcceptancePath } from "../src/infra/runtime-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wa-project-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initRuntime(root);
  await mkdir(path.join(root, ".agents/skills/project-rule"), { recursive: true });
  await writeFile(path.join(root, ".agents/skills/project-rule/SKILL.md"), "# PROJECT_SKILL\nCheck target implementation.\n");
  await writeFile(path.join(root, "rules.md"), "PROJECT_STANDARD\nOnly export one value.\n");
  await writeFile(path.join(root, "target.mjs"), "export const value = 1;\n");
  const adapter = path.join(root, ".wildarrange/adapter.cjs");
  await writeFile(adapter, `const fs=require('node:fs');
const p=JSON.parse(fs.readFileSync(process.env.WILDARRANGE_READINESS_PACKET||process.env.WILDARRANGE_REVIEW_PACKET,'utf8'));
if(p.kind==='execution_readiness_probe') { if(p.requiredSkills.some(s=>!s.content))process.exit(1); console.log(JSON.stringify({ready:true,challenge:p.challenge,loadedSkills:p.requiredSkills.map(s=>s.name)})); }
else if(p.kind==='project_review_step') { if(!p.step.documents[0].content.includes('PROJECT_STANDARD')||!p.step.skills[0].content.includes('PROJECT_SKILL'))process.exit(1); console.log(JSON.stringify({stepId:p.step.id,inputDigest:p.inputDigest,decision:'PASS',summary:'Inspected target against supplied standard',evidence:[{file:'target.mjs',line:1,text:p.source.files.find(f=>f.path==='target.mjs').content.split('\\n')[0]}],findings:[]})); }
else { if(!p.requiredSkills?.some(s=>s.name==='review-work' && s.content))process.exit(1); console.log(JSON.stringify({decision:'PASS',checks:Object.keys(p.rules).map(rule=>({rule,decision:'PASS',reason:'Fixture inspected source'})),findings:[]})); }
`);
  const command = `node "${adapter}"`;
  const config = { executionReadiness: { workerProbe: command }, review: { responsibility: { command }, steps: [{ id: "module-rules", title: "Module rules", appliesTo: ["target.mjs"], requirement: "Export one value", documents: ["rules.md"], skills: ["project-rule"], required: true }] } };
  await writeFile(path.join(root, "wildarrange.config.json"), JSON.stringify(config));
  const raw = { title: "Project governance", tasks: [{ id: "T001", subject: "Implement value", skills: ["project-rule"], writable_paths: ["target.mjs"],
    worker_command: 'node -e "const fs=require(\'fs\');const c=JSON.parse(fs.readFileSync(process.env.WILDARRANGE_EXECUTION_CONTEXT));if(!c.skills.some(s=>s.name===\'project-rule\'))process.exit(1);fs.writeFileSync(\'target.mjs\',\'export const value = 2;\\n\')"',
    verify_commands: ['node -e "const a=require(\'node:assert/strict\');a.equal(require(\'fs\').readFileSync(\'target.mjs\',\'utf8\'),\'export const value = 2;\\n\')"'],
    responsibilityChanges: [{ script: "target.mjs", additions: "Export value", responsibilityBefore: "Export value", responsibilityAfter: "Export value", facts: [] }] }] };
  const planFile = path.join(root, ".wildarrange/plan.json");
  await writeFile(planFile, JSON.stringify(raw));
  await importPlan(root, planFile, { requireResponsibility: true });
  await approvePlan(root);
  return { root, config, task: (await loadTaskState(root)).tasks[0], scope: { status: "pass", changedPaths: ["target.mjs"] } };
}

test("project review loads full project documents and Skills and binds its verdict", async t => {
  const { root, config, task, scope } = await fixture(t);
  const result = await runProjectReview(root, task, scope, config);
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.equal(result.steps[0].decision, "PASS");
  assert.equal(hasAcceptedProjectReview(config, task, scope, result), true);
  config.review.steps[0].requirement = "New standard";
  assert.equal(hasAcceptedProjectReview(config, task, scope, result), false);
});

test("missing required review document blocks workers without consuming an attempt", async t => {
  const { root, task } = await fixture(t);
  await rm(path.join(root, "rules.md"));
  const run = await runNextTask(root);
  assert.equal(run.status, "readiness_blocked", JSON.stringify(run));
  assert.match(run.readiness.issues.join(";"), /missing.*document/);
  const parallel = await runParallelAgents(root, { taskId: task.id });
  assert.equal(parallel.status, "readiness_blocked");
  assert.equal(parallel.runId, null);
  assert.equal((await loadTaskState(root)).tasks[0].attempts, 0);
  assert.equal(await readFile(path.join(root, "target.mjs"), "utf8"), "export const value = 1;\n");
});

test("unrelated and optional review requirements do not block the task", async t => {
  const { root, config, task } = await fixture(t);
  config.review.steps.push({ id: "unrelated", title: "Other module", appliesTo: ["other/**"], requirement: "Other rules", documents: ["missing.md"], required: true });
  config.review.steps.push({ id: "optional", title: "Optional", requirement: "Nice to have", documents: ["missing.md"], required: false });
  const result = await prepareProjectReview(root, task, config);
  assert.equal(result.pass, true);
  assert.deepEqual(result.steps.map(step => step.id), ["module-rules", "optional"]);
});

test("missing task Skill and false handshake are blocked before execution", async t => {
  const { root, config, task } = await fixture(t);
  task.skills.push("missing-skill");
  assert.equal((await checkExecutionReadiness(root, task)).pass, false);
  task.skills.pop();
  config.executionReadiness.workerProbe = 'node -e "console.log(JSON.stringify({ready:true,challenge:\'stale\',loadedSkills:[]}))"';
  await writeFile(path.join(root, "wildarrange.config.json"), JSON.stringify(config));
  const result = await checkExecutionReadiness(root, task);
  assert.equal(result.pass, false);
  assert.match(result.issues.join(";"), /handshake/);
});

test("governed worker receives Skill context and project review passes before checkpoint", async t => {
  const { root, task } = await fixture(t);
  const result = await runNextTask(root);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.reviewResult.projectReview.pass, true);
  const proof = JSON.parse(await readFile(resolveTaskAcceptancePath(root, task.planId, task.id), "utf8"));
  assert.equal(proof.pass, true);
});

test("mandatory reviewer INCONCLUSIVE blocks completion with evidence", async t => {
  const { root, config, task, scope } = await fixture(t);
  config.review.steps[0].command = 'node -e "console.log(\'{}\')"';
  const result = await runProjectReview(root, task, scope, config);
  assert.equal(result.pass, false);
  assert.equal(result.steps[0].decision, "INCONCLUSIVE");
});

// A configuration preview is read-only; applying can only touch governance config.
test("setup preview preserves config and rejects unrelated or malformed fields", async t => {
  const { configureProjectReview } = await import("../src/capabilities/project-review.mjs");
  const { root } = await fixture(t);
  const before = await readFile(path.join(root, "wildarrange.config.json"), "utf8");
  const draft = ".wildarrange/plan-drafts/setup.json";
  await mkdir(path.join(root, ".wildarrange/plan-drafts"), { recursive: true });
  await writeFile(path.join(root, draft), JSON.stringify({ review: { steps: [{ id: "new-rule", title: "New rule", requirement: "Check module", documents: ["missing.md"] }] } }));
  const preview = await configureProjectReview(root, draft);
  assert.equal(preview.applied, false);
  assert.equal(preview.checklist.pass, false);
  assert.equal(await readFile(path.join(root, "wildarrange.config.json"), "utf8"), before);
  assert.equal((await configureProjectReview(root, draft, { apply: true })).applied, true);
  for (const patch of [{ agents: {} }, { review: null }, { executionReadiness: { workerProbe: 7 } }, { executionReadiness: { timeoutMs: -1 } }]) {
    await writeFile(path.join(root, draft), JSON.stringify(patch));
    await assert.rejects(() => configureProjectReview(root, draft, { apply: true }));
  }
  await writeFile(path.join(root, "outside.json"), "{}");
  await assert.rejects(() => configureProjectReview(root, "outside.json"), /plan-drafts/);
});

test("project reviewer returns an actionable finding and cannot create checkpoint", async t => {
  const { root, config } = await fixture(t);
  const reject = path.join(root, ".wildarrange/reject.cjs");
  await writeFile(reject, `const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.env.WILDARRANGE_REVIEW_PACKET));if(p.kind==='execution_readiness_probe'){console.log(JSON.stringify({ready:true,challenge:p.challenge,loadedSkills:p.requiredSkills.map(s=>s.name)}))}else{const citation={file:'target.mjs',line:1,text:p.source.files.find(f=>f.path==='target.mjs').content.split('\\n')[0]};console.log(JSON.stringify({stepId:p.step.id,inputDigest:p.inputDigest,decision:'RETURN',summary:'Value violates module contract',evidence:[citation],findings:[{...citation,reason:'Module requires another value',requiredFix:'Correct the exported value'}]}))}`);
  config.review.steps[0].command = `node "${reject}"`;
  await writeFile(path.join(root, "wildarrange.config.json"), JSON.stringify(config));
  const run = await runNextTask(root);
  assert.equal(run.reviewResult.projectReview.pass, false);
  assert.equal(run.reviewResult.projectReview.steps[0].findings[0].requiredFix, "Correct the exported value");
  assert.notEqual(run.task.status, "completed");
  assert.notEqual(run.checkpointResult?.pass, true);
  assert.notEqual((await loadTaskState(root)).tasks[0].status, "completed");
});

test("setup Hook permits only the exact governance command before a task exists", async t => {
  const { preToolUseGuard } = await import("../src/ai/pre-tool-guard.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "wa-setup-hook-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initRuntime(root);
  for (const [command, denied] of [
    ["node ./bin/wildarrange.mjs review configure --from .wildarrange/plan-drafts/setup.json", false],
    ["node ./bin/wildarrange.mjs review configure --from .wildarrange/plan-drafts/setup.json --apply", false],
    ["node ./bin/wildarrange.mjs review configure --from outside.json --apply", true],
    ["node ./bin/wildarrange.mjs review configure --from .wildarrange/plan-drafts/setup.json; node evil.js", true],
  ]) {
    const result = await preToolUseGuard(root, { hook_event_name: "PreToolUse", cwd: root, session_id: "setup", tool_name: "exec_command", tool_input: { command } });
    assert.equal(result.decision === "deny", denied, JSON.stringify(result));
  }
});

test("installed adapters expose setup and onboarding Skills", async t => {
  const { root } = await fixture(t);
  const { installAdapter } = await import("../src/interface/adapters.mjs");
  await installAdapter(root, "codex");
  const setup = await readFile(path.join(root, ".agents/skills/wildarrange-setup/SKILL.md"), "utf8");
  const onboard = await readFile(path.join(root, ".agents/skills/wildarrange-onboard/SKILL.md"), "utf8");
  assert.match(setup, /prompts show --skill configure-project-review/);
  assert.match(onboard, /prompts show --skill project-onboarding/);
});

test("changed review documents invalidate an earlier acceptance receipt", async t => {
  const { writeAcceptanceProof } = await import("../src/capabilities/acceptance-proof.mjs");
  const { root, config, task, scope } = await fixture(t);
  const review = await runProjectReview(root, task, scope, config);
  await writeFile(path.join(root, "rules.md"), "REVISED_STANDARD\nChanged requirement.\n");
  const proof = await writeAcceptanceProof(root, task.planId, task, { scopeResult: scope, reviewResult: { kind: "review_gate", pass: true, projectReview: review } }, { recordLedger: false });
  assert.equal(proof.checks.find(c => c.code === "project_review_bound" || c.name === "project_review_bound" || c.id === "project_review_bound")?.status, "fail");
});

// CODE-006 回归：scope 结果只存在于 task.evidence（kind 为 "scope_guard"）时，
// writeAcceptanceProof 也必须用它复核 review 上下文，不能让旧 receipt 在文档变更后蒙混过关。
test("scope evidence recorded only as scope_guard still binds the acceptance proof to fresh review context", async t => {
  const { writeAcceptanceProof } = await import("../src/capabilities/acceptance-proof.mjs");
  const { root, config, task } = await fixture(t);
  delete task.responsibilityChanges;
  task.writable_paths = [];
  delete task.last_scope_result;
  const scope = { status: "pass", changedPaths: ["target.mjs"] };
  const review = await runProjectReview(root, task, scope, config);
  assert.equal(review.pass, true);
  task.evidence = [{ kind: "scope_guard", at: new Date().toISOString(), ...scope }];

  const findBoundCheck = proof => proof.checks.find(c => c.name === "project_review_bound");
  const fresh = await writeAcceptanceProof(root, task.planId, task, { reviewResult: { kind: "review_gate", pass: true, projectReview: review } }, { recordLedger: false });
  assert.equal(findBoundCheck(fresh)?.status, "pass", JSON.stringify(findBoundCheck(fresh)));

  await writeFile(path.join(root, "rules.md"), "REVISED_STANDARD\nChanged requirement.\n");
  const stale = await writeAcceptanceProof(root, task.planId, task, { reviewResult: { kind: "review_gate", pass: true, projectReview: review } }, { recordLedger: false });
  assert.equal(findBoundCheck(stale)?.status, "fail");
});

test("a rule for another module does not require an unrelated legacy worker probe", async t => {
  const { root, config, task } = await fixture(t);
  delete task.responsibilityChanges;
  task.writable_paths = ["other.mjs"];
  config.executionReadiness.workerProbe = null;
  await writeFile(path.join(root, "wildarrange.config.json"), JSON.stringify(config));
  assert.equal((await checkExecutionReadiness(root, task)).required, false);
});

test("parallel readiness checks its actual adapter instead of a linear worker command", async t => {
  const { root, config, task } = await fixture(t);
  config.parallelAgents = { defaultAdapter: "test-adapter", spawnAdapters: { "test-adapter": { command: task.worker_command } } };
  await writeFile(path.join(root, "wildarrange.config.json"), JSON.stringify(config));
  const run = await runParallelAgents(root, { taskId: task.id });
  assert.equal(run.results?.[0]?.exitCode, 0, JSON.stringify(run));
  assert.equal(await readFile(path.resolve(root, run.results[0].workDir, "target.mjs"), "utf8"), "export const value = 2;\n");
  const context = JSON.parse(await readFile(path.join(root, ".wildarrange/reports/readiness", task.planId, task.id + ".json.context.json"), "utf8"));
  assert.equal(context.skills.some(s => s.name === "project-rule"), true);
});

test("a linear worker command cannot stand in for a missing parallel adapter", async t => {
  const { root, task } = await fixture(t);
  const run = await runParallelAgents(root, { taskId: task.id });
  assert.equal(run.status, "readiness_blocked");
  assert.equal(run.runId, null);
  assert.match(run.readiness.issues.join(";"), /real worker_command/);
});

test("approved task creates one historical packet and keeps it unchanged across retries", async t => {
  const { root, task } = await fixture(t);
  const { ensureTaskPacket } = await import("../src/infra/runtime-snapshot.mjs");
  const { resolveTaskPacketPath } = await import("../src/infra/runtime-store.mjs");
  const packet = await ensureTaskPacket(root, task.planId, task);
  const baseline = await readFile(packet.baselinePath, "utf8");
  assert.match(baseline, /task_start_baseline/);
  assert.equal(JSON.parse(baseline).task.subject, "Implement value");
  assert.match(await readFile(packet.indexPath, "utf8"), /reports\/acceptance/);
  assert.match(await readFile(packet.researchPath, "utf8"), /not a claim that research has been completed/);
  task.subject = "Changed after first attempt";
  await ensureTaskPacket(root, task.planId, task);
  assert.equal(await readFile(packet.baselinePath, "utf8"), baseline);
  assert.throws(() => resolveTaskPacketPath(root, "../escape", task.id), /safe evidence/);
  assert.throws(() => resolveTaskPacketPath(root, task.planId, task.id, "other.md"), /unsupported/);
});

test("document review returns line-backed finding and blocks checkpoint", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wa-doc-truth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initRuntime(root);
  await writeFile(path.join(root, "README.md"), "Old instructions");
  const adapter = path.join(root, ".wildarrange/doc-review.cjs");
  await writeFile(adapter, `const fs=require('fs');
const p=JSON.parse(fs.readFileSync(process.env.WILDARRANGE_READINESS_PACKET||process.env.WILDARRANGE_REVIEW_PACKET,'utf8'));
if(p.kind==='execution_readiness_probe') console.log(JSON.stringify({ready:true,challenge:p.challenge,loadedSkills:p.requiredSkills.map(s=>s.name)}));
else if(p.kind==='project_review_step') {
  const doc=p.source.files.find(f=>f.path==='README.md');const citation={file:'README.md',line:1,text:doc.content.split('\\n')[0]};
  console.log(JSON.stringify({stepId:p.step.id,inputDigest:p.inputDigest,decision:'RETURN',summary:'D1: process log in long-term documentation',evidence:[citation],findings:[{...citation,reason:'D1: task progress belongs in task evidence',requiredFix:'Move progress to the task packet and keep only current usage in README'}]}));
} else console.log(JSON.stringify({decision:'PASS',checks:Object.keys(p.rules).map(rule=>({rule,decision:'PASS',reason:'Checked README source'})),findings:[]}));`);
  const command = `node "${adapter}"`;
  await writeFile(path.join(root, "wildarrange.config.json"), JSON.stringify({ executionReadiness:{workerProbe:command}, review:{responsibility:{command}} }));
  const plan = { title:"Document task", tasks:[{id:"T001",subject:"Update documentation",owner:"ZhuRong",writable_paths:["README.md"],
    worker_command:"node -e \"require('fs').writeFileSync('README.md','Attempt 1: updated docs.')\"",
    verify_commands:["node -e \"if(require('fs').readFileSync('README.md','utf8')!=='Attempt 1: updated docs.')process.exit(1)\""],
    responsibilityChanges:[{script:"README.md",additions:"Current usage",responsibilityBefore:"Current usage",responsibilityAfter:"Current usage",facts:[]}] }] };
  const planFile = path.join(root, ".wildarrange/plan.json");
  await writeFile(planFile, JSON.stringify(plan));
  await importPlan(root, planFile, { requireResponsibility:true });
  const { resolveTaskPacketPath } = await import("../src/infra/runtime-store.mjs");
  const initial = (await loadTaskState(root)).tasks[0];
  await assert.rejects(() => readFile(resolveTaskPacketPath(root, initial.planId, initial.id, "baseline.json")), /ENOENT/);
  await approvePlan(root);
  const result = await runNextTask(root);
  assert.equal(result.reviewResult.projectReview.pass, false, JSON.stringify(result.reviewResult.projectReview));
  assert.equal(result.reviewResult.projectReview.steps.find(step=>step.id==='document-current-truth')?.decision, "RETURN");
  assert.match(result.reviewResult.projectReview.steps.find(step=>step.id==='document-current-truth').findings[0].requiredFix, /task packet/);
  assert.notEqual((await loadTaskState(root)).tasks[0].status, "completed");
  await assert.rejects(() => readFile(resolveTaskAcceptancePath(root, initial.planId, initial.id)), /ENOENT/);
  assert.equal(JSON.parse(await readFile(resolveTaskPacketPath(root, initial.planId, initial.id, "baseline.json"))).task.subject, "Update documentation");
});

test("task packet refuses a symlinked control directory without writing outside root", async t => {
  const { root, task } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "wa-packet-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, ".wildarrange", "task-packets"), "junction");
  const { ensureTaskPacket } = await import("../src/infra/runtime-snapshot.mjs");
  await assert.rejects(() => ensureTaskPacket(root, task.planId, task), /symlink/);
  assert.deepEqual(await import("node:fs/promises").then(fs => fs.readdir(outside)), []);
});
