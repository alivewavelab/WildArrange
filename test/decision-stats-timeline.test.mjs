/**
 * 确定性统计审查（decisions stats）与统一时间线（timeline）测试：
 * - stats 出计数不出率：门×决策、门×规则、从未触发的门、标注关联；
 * - timeline 合并 ledger/decision/annotation 三源，倒序、可过滤、坏行降级。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runInjectionHook } from "../src/ai/hooks.mjs";
import { projectDecisionStats } from "../src/interface/decisions.mjs";
import { projectTimeline } from "../src/interface/timeline.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { appendAnnotation } from "../src/infra/annotation-log.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { resolveHelixPath } from "../src/infra/runtime-store.mjs";

const execFileAsync = promisify(execFile);
const HELIX_BIN = path.resolve(import.meta.dirname, "..", "bin", "helix.mjs");

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-stats-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function importPassingPlan(dir) {
  const planPath = resolveHelixPath(dir, "artifacts", "stats-plan.json");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify({
    title: "Stats",
    tasks: [
      {
        id: "T001",
        title: "stats task",
        owner: "ZhuRong",
        writable_paths: ["src/**"],
        verify_commands: ["node -e \"process.exit(0)\""],
      },
    ],
  }, null, 2));
  await importPlan(dir, planPath);
}

async function denyOnce(dir, target, taskId) {
  await runInjectionHook(dir, {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: target },
    task_id: taskId,
    cwd: dir,
    session_id: "stats-test",
  });
}

test("decision stats count gates, rules and never-fired gates without any LLM", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    await denyOnce(dir, "docs/a.md");
    await denyOnce(dir, "docs/b.md");

    const stats = await projectDecisionStats(dir);
    assert.equal(stats.kind, "helix_decision_stats");
    const pre = stats.gates.find((gate) => gate.gate === "pre_tool_use");
    assert.equal(pre.total, 2);
    assert.equal(pre.decisions.deny, 2);
    assert.equal(pre.codes.out_of_scope, 2);
    assert.equal(pre.annotatable, 2);
    assert.ok(stats.timeRange.first && stats.timeRange.last);
    // 从未触发的门必须被点名——门形同虚设的直接信号。
    assert.ok(stats.neverFiredGates.includes("admission"));
    assert.ok(stats.neverFiredGates.includes("verify"));
    assert.ok(!stats.neverFiredGates.includes("pre_tool_use"));
  });
});

test("decision stats join annotations by rule x category", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    await denyOnce(dir, "docs/a.md");
    const { readDecisions } = await import("../src/infra/decision-log.mjs");
    const { records } = await readDecisions(dir);
    await appendAnnotation(dir, { decisionId: records[0].id, category: "rule_wrong" });

    const stats = await projectDecisionStats(dir);
    const pre = stats.gates.find((gate) => gate.gate === "pre_tool_use");
    assert.deepEqual(
      pre.annotatedRules.map((rule) => ({ code: rule.code, total: rule.total })),
      [{ code: "out_of_scope", total: 1 }],
    );
    assert.equal(stats.annotations.total, 1);
  });
});

test("timeline merges ledger, decisions and annotations in reverse order with filters", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    await denyOnce(dir, "docs/a.md", "T001");
    const { readDecisions } = await import("../src/infra/decision-log.mjs");
    const { records } = await readDecisions(dir);
    const deny = records.find((record) => record.gate === "pre_tool_use");
    await appendAnnotation(dir, { decisionId: deny.id, category: "case_wrong", reason: "这次是个案" });

    const timeline = await projectTimeline(dir, {});
    const sources = new Set(timeline.records.map((row) => row.source));
    assert.ok(sources.has("ledger"), "ledger 事件必须进时间线");
    assert.ok(sources.has("decision"));
    assert.ok(sources.has("annotation"));
    // 倒序：最新在前。
    for (let index = 1; index < timeline.records.length; index += 1) {
      assert.ok(timeline.records[index - 1].ts >= timeline.records[index].ts, "must be reverse chronological");
    }
    const annotationRow = timeline.records.find((row) => row.source === "annotation");
    assert.match(annotationRow.summary, /case_wrong/);
    assert.equal(annotationRow.ref, deny.id);

    // --task 过滤保留带该 taskId 的行，以及指向这些决策的标注（经 ref 归属）。
    const filtered = await projectTimeline(dir, { taskId: "T001" });
    assert.ok(filtered.records.length > 0);
    const keptDecisionIds = new Set(
      filtered.records.filter((row) => row.source === "decision").map((row) => row.ref),
    );
    for (const row of filtered.records) {
      if (row.source === "annotation") {
        assert.ok(keptDecisionIds.has(row.ref), "标注必须锚定被保留的决策");
      } else {
        assert.equal(row.taskId, "T001");
      }
    }
    assert.ok(
      filtered.records.some((row) => row.source === "annotation"),
      "指向该任务决策的标注不应被 --task 过滤丢掉",
    );

    // --source 过滤。
    const ledgerOnly = await projectTimeline(dir, { source: "ledger" });
    assert.ok(ledgerOnly.records.every((row) => row.source === "ledger"));

    // 文本投影一行一条。
    assert.match(timeline.text, /时间线：共/);
    assert.match(timeline.text, /pre_tool_use DENY/);
  });
});

test("decisions stats and timeline CLI both work", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    await denyOnce(dir, "docs/a.md");

    const stats = await execFileAsync(process.execPath, [HELIX_BIN, "decisions", "stats", "--root", dir], { cwd: dir });
    const parsed = JSON.parse(stats.stdout);
    assert.equal(parsed.kind, "helix_decision_stats");
    assert.ok(parsed.gates.some((gate) => gate.gate === "pre_tool_use"));

    const timeline = await execFileAsync(process.execPath, [HELIX_BIN, "timeline", "--root", dir, "--limit", "10"], { cwd: dir });
    assert.match(timeline.stdout, /时间线：共/);

    const timelineJson = await execFileAsync(process.execPath, [HELIX_BIN, "timeline", "--root", dir, "--format", "json"], { cwd: dir });
    assert.equal(JSON.parse(timelineJson.stdout).kind, "helix_timeline");
  });
});
