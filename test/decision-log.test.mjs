/**
 * 决策记录（decisions.jsonl）测试：
 * - 四个缝（delivery-pipeline / hooks / admission / routing）都发射决策记录；
 * - 投影（helix decisions）逐条一致且能降级跳过坏行；
 * - 发射是 best-effort，绝不反噬主流程。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runDeliveryPipeline } from "../src/orchestration/delivery-pipeline.mjs";
import { runInjectionHook } from "../src/ai/hooks.mjs";
import { routeRequest } from "../src/ai/routing.mjs";
import { projectDecisions } from "../src/interface/decisions.mjs";
import { readDecisions } from "../src/infra/decision-log.mjs";
import {
  admitParallelAgentResult,
  importPlan,
  initRuntime,
  loadTaskState,
  resolveHelixPath,
  runCommand,
  runParallelAgents,
} from "../src/helix-core.mjs";

const execFileAsync = promisify(execFile);
const HELIX_BIN = path.resolve(import.meta.dirname, "..", "bin", "helix.mjs");

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-decisions-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function nodeEval(source) {
  return `node -e ${JSON.stringify(source.replace(/\s*\n\s*/g, " ").trim())}`;
}

async function importPassingPlan(dir) {
  // 计划文件放在 .helix/artifacts 下：放在仓库根会被 scope 门当作
  // writable_paths 之外的无归属改动而拦截。
  const planPath = resolveHelixPath(dir, "artifacts", "decisions-plan.json");
  await writeFile(planPath, JSON.stringify({
    title: "Decision log",
    tasks: [
      {
        id: "T001",
        subject: "Task whose gates all pass",
        worker_command: nodeEval("process.exit(0)"),
        verify_commands: [nodeEval("if(!process.version)process.exit(1)")],
        review_commands: ["node --version"],
        writable_paths: ["src/**"],
      },
    ],
  }, null, 2));
  return importPlan(dir, planPath);
}

test("delivery pipeline emits one decision record per gate plus a pipeline outcome", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    const plan = await importPassingPlan(dir);
    const taskState = await loadTaskState(dir);
    const task = taskState.tasks.find((candidate) => candidate.id === "T001");

    const result = await runDeliveryPipeline(dir, plan.id, task, {
      initialEvidence: {
        workerResult: { kind: "worker", command: null, exitCode: 0, stdout: "", stderr: "" },
      },
    });
    assert.equal(result.status, "completed");

    const { records, skippedLines } = await readDecisions(dir);
    assert.equal(skippedLines, 0);
    for (const gate of ["verify", "scope", "review", "acceptance-proof", "checkpoint"]) {
      const record = records.find((candidate) => candidate.gate === gate);
      assert.ok(record, `missing decision record for gate ${gate}`);
      assert.equal(record.decision, "pass");
      assert.equal(record.taskId, "T001");
      assert.ok(record.ts, "record carries a timestamp");
    }
    const pipeline = records.find((candidate) => candidate.gate === "pipeline");
    assert.ok(pipeline, "missing pipeline outcome record");
    assert.equal(pipeline.decision, "completed");
    // 验收证明门必须带出证据路径，投影才能指到报告。
    const proof = records.find((candidate) => candidate.gate === "acceptance-proof");
    assert.ok(proof.evidencePath, "acceptance-proof decision carries an evidence path");
  });
});

test("pre-tool-use hook emits a deny decision with the rule it hit", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);

    const result = await runInjectionHook(dir, {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "docs/out-of-scope.md" },
      cwd: dir,
      session_id: "decisions-test",
    });
    assert.equal(result.decision, "deny");

    const { records } = await readDecisions(dir);
    const record = records.find((candidate) => candidate.gate === "pre_tool_use");
    assert.ok(record, "missing pre_tool_use decision record");
    assert.equal(record.decision, "deny");
    assert.equal(record.code, "out_of_scope");
    assert.match(record.reason, /scope violation/);
    assert.match(record.summary, /docs\/out-of-scope\.md/);
    assert.ok(record.evidencePath, "hook decision carries the hook report as evidence");
  });
});

test("routing emits a route decision record", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const result = await routeRequest(dir, { text: "继续上一个任务" });
    const { records } = await readDecisions(dir);
    const record = records.find((candidate) => candidate.gate === "routing");
    assert.ok(record, "missing routing decision record");
    assert.equal(record.decision, result.route);
    assert.match(record.reason, /intent=/);
    assert.match(record.summary, /继续上一个任务/);
  });
});

test("parallel admission emits an admission decision carrying the runId", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);

    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'artifact ready', files:[{path:'src/parallel.txt', content:'ok\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, { taskIds: ["T001"], agent: "ZhuRong", command });
    const admitted = await admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" });
    assert.equal(admitted.status, "completed");

    const { records } = await readDecisions(dir);
    const record = records.find((candidate) => candidate.gate === "admission");
    assert.ok(record, "missing admission decision record");
    assert.equal(record.decision, "completed");
    assert.equal(record.runId, batch.runId);
    assert.equal(record.taskId, "T001");
    // admission 内部的 pipeline 决策必须带同一个 runId，审查时才能对齐。
    const pipeline = records.find((candidate) => candidate.gate === "pipeline");
    assert.equal(pipeline.runId, batch.runId);
  });
});

test("projection renders three lines per record and degrades past corrupt lines", async () => {
  await withTempDir(async (dir) => {
    await mkdir(resolveHelixPath(dir), { recursive: true });
    const good = [
      { ts: "2026-08-04T01:00:00.000Z", gate: "pre_tool_use", decision: "deny", code: "out_of_scope", reason: "planned scope violation for task T001: docs/x.md", summary: "Edit docs/x.md -> deny", evidencePath: ".helix/sessions/hooks/s-PreToolUse.json", taskId: "T001" },
      { ts: "2026-08-04T01:01:00.000Z", gate: "verify", decision: "pass", summary: "验证门 pass", evidencePath: null, taskId: "T001" },
    ];
    const logPath = resolveHelixPath(dir, "decisions.jsonl");
    await writeFile(logPath, good.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    await appendFile(logPath, '{"ts":"2026-08-04T01:02:00.000Z","gate":"verify","deci', "utf8");

    const projection = await projectDecisions(dir, {});
    assert.equal(projection.total, 2);
    assert.equal(projection.shown, 2);
    assert.equal(projection.skippedLines, 1);
    assert.deepEqual(projection.records, good);
    assert.match(projection.text, /跳过 1 行/);
    assert.match(projection.text, /发生了什么: Edit docs\/x\.md -> deny/);
    assert.match(projection.text, /命中规则: out_of_scope — planned scope violation/);
    assert.match(projection.text, /证据: \.helix\/sessions\/hooks\/s-PreToolUse\.json/);

    const onlyTask = await projectDecisions(dir, { taskId: "T001", format: "json" });
    assert.equal(onlyTask.shown, 2);
    const none = await projectDecisions(dir, { taskId: "T999" });
    assert.equal(none.shown, 0);
    assert.match(none.text, /无决策记录/);
  });
});

test("readDecisions streams from the tail and marks truncated instead of loading the whole file", async () => {
  await withTempDir(async (dir) => {
    await mkdir(resolveHelixPath(dir), { recursive: true });
    const logPath = resolveHelixPath(dir, "decisions.jsonl");
    // 2000 条记录约 300KB，远超 64KB 读块，必须触发尾部窗口。
    const lines = [];
    for (let index = 0; index < 2000; index += 1) {
      lines.push(JSON.stringify({ ts: `2026-08-04T00:00:${String(index % 60).padStart(2, "0")}.${index}`, gate: "routing", decision: "recover", summary: `record ${index}` }));
    }
    await writeFile(logPath, lines.join("\n") + "\n", "utf8");

    const { records, total, truncated } = await readDecisions(dir, { limit: 5 });
    assert.equal(records.length, 5);
    assert.equal(truncated, true, "tail window must be marked truncated");
    assert.ok(total < 2000, "must not scan the whole file when limit is reached");
    assert.equal(records[4].summary, "record 1999", "records keep ascending file order");
    assert.equal(records[0].summary, "record 1995");

    const filtered = await readDecisions(dir, { limit: 2, filter: (record) => record.summary === "record 3" });
    assert.equal(filtered.records.length, 1, "filter scans back until matches are found");
    assert.equal(filtered.records[0].summary, "record 3");

    const zero = await readDecisions(dir, { limit: 0 });
    assert.equal(zero.records.length, 0);
  });
});

test("appendDecision heals a mid-line external truncation instead of gluing onto the partial line", async () => {
  await withTempDir(async (dir) => {
    await mkdir(resolveHelixPath(dir), { recursive: true });
    const logPath = resolveHelixPath(dir, "decisions.jsonl");
    await writeFile(logPath, `${JSON.stringify({ gate: "routing", decision: "recover", summary: "complete" })}\n{"gate":"routing","deci`, "utf8");

    const { appendDecision } = await import("../src/infra/decision-log.mjs");
    await appendDecision(dir, { gate: "verify", decision: "pass", summary: "after truncation" });

    const { records, skippedLines } = await readDecisions(dir);
    assert.equal(skippedLines, 1, "the pre-existing half line is skipped");
    assert.equal(records.length, 2, "the new record is NOT glued onto the half line");
    assert.equal(records[1].summary, "after truncation");
  });
});

test("gate FAIL decisions carry the rule they hit (code/reason), and decision order matches gate execution order", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    const planPath = resolveHelixPath(dir, "artifacts", "fail-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Failing verify",
      tasks: [
        {
          id: "T001",
          subject: "verify fails",
          worker_command: nodeEval("process.exit(0)"),
          verify_commands: [nodeEval("console.error('boom: expected marker missing'); process.exit(1)")],
          review_commands: ["node --version"],
          writable_paths: ["src/**"],
        },
      ],
    }, null, 2));
    const plan = await importPlan(dir, planPath);
    const taskState = await loadTaskState(dir);
    const task = taskState.tasks.find((candidate) => candidate.id === "T001");

    const result = await runDeliveryPipeline(dir, plan.id, task, {
      initialEvidence: {
        workerResult: { kind: "worker", command: null, exitCode: 0, stdout: "", stderr: "" },
      },
    });
    assert.equal(result.status, "blocked");

    const { records } = await readDecisions(dir);
    const verify = records.find((candidate) => candidate.gate === "verify");
    assert.equal(verify.decision, "fail");
    // 「命中哪条规则」对 FAIL 记录不允许为空——这是决策可审判的核心承诺。
    assert.equal(verify.code, "verify_failed");
    assert.match(verify.reason, /exit=1/);
    assert.match(verify.reason, /boom: expected marker missing/);

    // 时间序必须与门的真实执行序一致（verify -> scope -> review -> pipeline）。
    const order = records.map((record) => record.gate);
    const verifyIndex = order.indexOf("verify");
    const scopeIndex = order.indexOf("scope");
    const reviewIndex = order.indexOf("review");
    const pipelineIndex = order.indexOf("pipeline");
    assert.ok(verifyIndex !== -1 && scopeIndex !== -1 && reviewIndex !== -1 && pipelineIndex !== -1);
    assert.ok(verifyIndex < scopeIndex && scopeIndex < reviewIndex && reviewIndex < pipelineIndex,
      `decision order must follow gate execution order, got ${order.join(" -> ")}`);
  });
});

test("completed pipeline emits gate decisions in execution order ending with the pipeline outcome", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    const plan = await importPassingPlan(dir);
    const taskState = await loadTaskState(dir);
    const task = taskState.tasks.find((candidate) => candidate.id === "T001");
    const result = await runDeliveryPipeline(dir, plan.id, task, {
      initialEvidence: {
        workerResult: { kind: "worker", command: null, exitCode: 0, stdout: "", stderr: "" },
      },
    });
    assert.equal(result.status, "completed");
    const { records } = await readDecisions(dir);
    const order = records.map((record) => record.gate);
    assert.deepEqual(order, ["verify", "scope", "review", "acceptance-proof", "checkpoint", "pipeline"]);
    // review 决策必须带出约定证据路径（报告在 pipeline 返回后写入该路径）。
    const review = records.find((candidate) => candidate.gate === "review");
    assert.match(review.evidencePath, /^\.helix\/reports\/reviews\/.+-T001\.md$/);
  });
});

test("projection filters by annotatable and since", async () => {
  await withTempDir(async (dir) => {
    await mkdir(resolveHelixPath(dir), { recursive: true });
    const logPath = resolveHelixPath(dir, "decisions.jsonl");
    const entries = [
      { ts: "2026-08-04T01:00:00.000Z", gate: "verify", decision: "pass", summary: "old pass", annotatable: false },
      { ts: "2026-08-04T02:00:00.000Z", gate: "verify", decision: "fail", code: "verify_failed", summary: "new fail", annotatable: true },
      { ts: "2026-08-04T03:00:00.000Z", gate: "review", decision: "pass", summary: "new review pass", annotatable: true },
    ];
    await writeFile(logPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");

    const annotatableOnly = await projectDecisions(dir, { annotatable: true });
    assert.equal(annotatableOnly.shown, 2);
    assert.ok(annotatableOnly.records.every((record) => record.annotatable === true));

    const sinceOnly = await projectDecisions(dir, { since: "2026-08-04T02:30:00.000Z" });
    assert.equal(sinceOnly.shown, 1);
    assert.equal(sinceOnly.records[0].summary, "new review pass");
  });
});

test("helix decisions CLI prints the projection and the json format", async () => {
  await withTempDir(async (dir) => {
    await mkdir(resolveHelixPath(dir), { recursive: true });
    await writeFile(
      resolveHelixPath(dir, "decisions.jsonl"),
      `${JSON.stringify({ ts: "2026-08-04T02:00:00.000Z", gate: "routing", decision: "recover", code: "quick", reason: "intent=resume", summary: "继续" })}\n`,
      "utf8",
    );
    const text = await execFileAsync(process.execPath, [HELIX_BIN, "decisions"], { cwd: dir });
    assert.match(text.stdout, /routing\s+RECOVER/);
    assert.match(text.stdout, /发生了什么: 继续/);

    const json = await execFileAsync(process.execPath, [HELIX_BIN, "decisions", "--format", "json"], { cwd: dir });
    const projection = JSON.parse(json.stdout);
    assert.equal(projection.kind, "helix_decisions_projection");
    assert.equal(projection.records.length, 1);
  });
});
