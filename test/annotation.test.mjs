/**
 * 标注回写测试：
 * - 拦截与非确定性放行带 annotatable 标记与决策 id，确定性 PASS 不进标注队列；
 * - 标注强制分类、决策 id 必须存在；
 * - 统计以「规则 × 标注」为单位；
 * - 硬约束钉死：标注路径绝不写 config / verify_commands / 任何门开关。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runInjectionHook } from "../src/ai/hooks.mjs";
import { routeRequest } from "../src/ai/routing.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readDecisions } from "../src/infra/decision-log.mjs";
import {
  annotationStats,
  appendAnnotation,
  readAnnotations,
} from "../src/infra/annotation-log.mjs";
import { resolveHelixPath } from "../src/infra/runtime-store.mjs";

const execFileAsync = promisify(execFile);
const HELIX_BIN = path.resolve(import.meta.dirname, "..", "bin", "helix.mjs");

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-annotate-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function importPassingPlan(dir) {
  const planPath = resolveHelixPath(dir, "artifacts", "annotate-plan.json");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify({
    title: "Annotation",
    tasks: [
      {
        id: "T001",
        title: "annotated task",
        owner: "ZhuRong",
        writable_paths: ["src/**"],
        verify_commands: ["node -e \"process.exit(0)\""],
      },
    ],
  }, null, 2));
  await importPlan(dir, planPath);
}

async function denyDecision(dir, target = "docs/out-of-scope.md") {
  await runInjectionHook(dir, {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: target },
    cwd: dir,
    session_id: "annotate-test",
  });
  const { records } = await readDecisions(dir);
  return records
    .filter((record) => record.gate === "pre_tool_use" && record.summary?.includes(target))
    .at(-1);
}

test("deny decisions are annotatable with an id; deterministic pass stays out of the queue", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);

    const deny = await denyDecision(dir);
    assert.ok(deny.id, "decision record carries an id anchor");
    assert.equal(deny.annotatable, true, "拦截必须进标注队列");

    // 纯确定性路由（显式关闭 shadow，防止本机配置了 LLM provider 时
    // shadow 真跑导致 annotatable=true）不进标注队列。
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      routeGovernance: { semanticShadow: { enabled: false } },
    }, null, 2));
    await routeRequest(dir, { text: "继续上一个任务" });
    const { records } = await readDecisions(dir);
    const routing = records.find((record) => record.gate === "routing");
    assert.equal(routing.annotatable, false, "确定性放行只进流水");
  });
});

test("annotations require a forced category and an existing decision id", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    const deny = await denyDecision(dir);

    await assert.rejects(
      appendAnnotation(dir, { decisionId: deny.id, category: "bad_rule" }),
      /rule_wrong\|case_wrong\|mislabeled/,
      "自由文本分类必须被拒绝",
    );
    await assert.rejects(
      appendAnnotation(dir, { decisionId: "dec_nonexistent", category: "rule_wrong" }),
      /unknown decision id/,
      "不存在的决策 id 必须被拒绝",
    );

    const entry = await appendAnnotation(dir, {
      decisionId: deny.id,
      category: "rule_wrong",
      reason: "docs/ 应该允许编辑",
      author: "human",
    });
    assert.ok(entry.id.startsWith("ann_"));

    const { records } = await readAnnotations(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0].decisionId, deny.id);
  });
});

test("stats aggregate by rule x category, never by single annotation", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    const first = await denyDecision(dir, "docs/first.md");
    const second = await denyDecision(dir, "docs/second.md");
    assert.notEqual(first.id, second.id);

    await appendAnnotation(dir, { decisionId: first.id, category: "rule_wrong" });
    await appendAnnotation(dir, { decisionId: first.id, category: "confirmed" });
    await appendAnnotation(dir, { decisionId: second.id, category: "case_wrong" });
    await appendAnnotation(dir, { decisionId: second.id, category: "mislabeled" });

    const stats = await annotationStats(dir);
    assert.equal(stats.total, 4);
    assert.equal(stats.rules.length, 1, "同一规则的两条决策聚合到一行");
    const rule = stats.rules[0];
    assert.equal(rule.rule, "pre_tool_use:out_of_scope");
    assert.equal(rule.total, 4);
    assert.equal(rule.rule_wrong, 1);
    assert.equal(rule.confirmed, 1);
    assert.equal(rule.case_wrong, 1);
    assert.equal(rule.mislabeled, 1);
  });
});

test("hard constraint: annotation paths never write config, tasks, or gate switches", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    const deny = await denyDecision(dir);

    // 配置文件必须真实存在，"未被改动"的断言才有意义。
    const configPath = path.join(dir, "helix.config.json");
    await writeFile(configPath, JSON.stringify({ review: { commands: ["node -e \"process.exit(0)\""] } }, null, 2));
    const tasksPath = resolveHelixPath(dir, "team", "tasks.json");
    const before = new Map();
    for (const filePath of [configPath, tasksPath]) {
      before.set(filePath, await readFile(filePath, "utf8").catch(() => null));
    }
    const helixDirBefore = await readdir(resolveHelixPath(dir));

    await appendAnnotation(dir, { decisionId: deny.id, category: "mislabeled", reason: "看错了" });
    await annotationStats(dir);
    await readAnnotations(dir);

    for (const [filePath, content] of before) {
      assert.equal(
        await readFile(filePath, "utf8").catch(() => null),
        content,
        `标注路径不得改动 ${path.basename(filePath)}`,
      );
    }
    const helixDirAfter = await readdir(resolveHelixPath(dir));
    const newFiles = helixDirAfter.filter((name) => !helixDirBefore.includes(name));
    assert.deepEqual(newFiles, ["annotations.jsonl"], "标注只允许新增 annotations.jsonl");

    // 静态钉死：标注模块不得 import 配置写入能力（剥离注释后检查代码本体）。
    const source = await readFile(path.resolve(import.meta.dirname, "..", "src", "infra", "annotation-log.mjs"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    assert.ok(!imports.some((specifier) => specifier.includes("runtime-config")), "annotation-log 不得触碰配置模块");
    assert.ok(!imports.some((specifier) => specifier.includes("plan-state") || specifier.includes("task-state")), "annotation-log 不得触碰任务状态");
    assert.ok(!code.includes("verify_commands"), "annotation-log 不得触碰门命令");
    assert.ok(!code.includes("writeJsonAtomic"), "annotation-log 只允许 appendFile 追加");
  });
});

test("helix annotate CLI records, lists and aggregates annotations", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    const deny = await denyDecision(dir);

    const annotate = await execFileAsync(process.execPath, [
      HELIX_BIN, "annotate", "--root", dir,
      "--decision", deny.id, "--category", "rule_wrong", "--reason", "太严",
    ], { cwd: dir });
    const recorded = JSON.parse(annotate.stdout);
    assert.equal(recorded.kind, "helix_annotation");
    assert.equal(recorded.recorded.decisionId, deny.id);

    const list = await execFileAsync(process.execPath, [HELIX_BIN, "annotate", "list", "--root", dir], { cwd: dir });
    assert.equal(JSON.parse(list.stdout).records.length, 1);

    const stats = await execFileAsync(process.execPath, [HELIX_BIN, "annotate", "stats", "--root", dir], { cwd: dir });
    const parsed = JSON.parse(stats.stdout);
    assert.equal(parsed.rules[0].rule, "pre_tool_use:out_of_scope");
    assert.equal(parsed.rules[0].rule_wrong, 1);

    await assert.rejects(
      execFileAsync(process.execPath, [
        HELIX_BIN, "annotate", "--root", dir, "--decision", deny.id, "--category", "whatever",
      ], { cwd: dir }),
      /强制分类|rule_wrong/,
      "CLI 必须拒绝非法分类",
    );
  });
});
