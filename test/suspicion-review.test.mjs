/**
 * LLM 可疑判断（异步审查）与 doctor 周期健康摘要测试：
 * - 无 provider 时确定性 fallback，不阻断、报告照出；
 * - LLM 返回的 decisionId 必须在输入包内，否则丢弃并计数；
 * - 报告只进 .wildarrange/reports/suspicion.*，不改配置/不动门（读侧断言）；
 * - doctor 新增 decisionHealth 分项：计数、坏行与孤儿标注预警。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runInjectionHook } from "../src/ai/hooks.mjs";
import { runSuspicionReview } from "../src/ai/suspicion-review.mjs";
import { runDoctor } from "../src/interface/doctor.mjs";
import { runNextTask } from "../src/orchestration/linear-runtime.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { resolveWildArrangePath } from "../src/infra/runtime-store.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-suspicion-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function importPassingPlan(dir) {
  const planPath = resolveWildArrangePath(dir, "artifacts", "suspicion-plan.json");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify({
    title: "Suspicion",
    tasks: [
      {
        id: "T001",
        title: "suspicion task",
        owner: "ZhuRong",
        writable_paths: ["src/**"],
        verify_commands: ["node -e \"process.exit(0)\""],
      },
    ],
  }, null, 2));
  await importPlan(dir, planPath);
}

async function denyOnce(dir, target) {
  await runInjectionHook(dir, {
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path: target },
    cwd: dir,
    session_id: "suspicion-test",
  });
}

async function withLlmServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

test("suspicion review falls back deterministically without an LLM provider", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    // 显式指向一个不存在的 key env，避免本机真实 provider 配置让测试变成"ok"。
    await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({
      archivistRouter: { enabled: true, agent: "CangJie", provider: "missing", model: "m" },
      modelProviders: { missing: { type: "openai-compatible", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "WILDARRANGE_TEST_DEFINITELY_MISSING_KEY" } },
    }, null, 2));
    await denyOnce(dir, "docs/a.md");

    const report = await runSuspicionReview(dir);
    assert.equal(report.kind, "wildarrange_suspicion_review");
    assert.equal(report.advisory, true);
    assert.equal(report.llm.status, "skipped");
    assert.equal(report.deterministic.denyTotal, 1);
    assert.ok(report.deterministic.topDenyRules.some((rule) => rule.rule.startsWith("pre_tool_use:")));
    // 报告落盘，且只是报告。
    const written = JSON.parse(await readFile(resolveWildArrangePath(dir, "reports", "suspicion.json"), "utf8"));
    assert.equal(written.kind, "wildarrange_suspicion_review");
    const markdown = await readFile(resolveWildArrangePath(dir, "reports", "suspicion.md"), "utf8");
    assert.match(markdown, /仅为建议/);
  });
});

test("suspicion review anchors LLM output to packet decisionIds and drops hallucinations", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    await denyOnce(dir, "docs/a.md");
    const { readDecisions } = await import("../src/infra/decision-log.mjs");
    const { records } = await readDecisions(dir);
    const realId = records.find((record) => record.gate === "pre_tool_use").id;

    await withLlmServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  suspicious: [
                    { decisionId: realId, reason: "rule looks miscalibrated" },
                    { decisionId: "dec_hallucinated", reason: "not in packet" },
                  ],
                  notes: "one real, one hallucinated",
                }),
              },
            },
          ],
          usage: { total_tokens: 10 },
        }));
      });
    }, async (baseUrl) => {
      await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({
        archivistRouter: {
          enabled: true,
          agent: "CangJie",
          provider: "fake",
          model: "fake-model",
        },
        modelProviders: {
          fake: { type: "openai-compatible", baseUrl, apiKey: "test-key" },
        },
      }, null, 2));

      const report = await runSuspicionReview(dir);
      assert.equal(report.llm.status, "ok");
      assert.deepEqual(report.suspicious, [{ decisionId: realId, reason: "rule looks miscalibrated" }]);
      assert.equal(report.droppedLlmIds, 1, "幻觉 decisionId 必须被丢弃并计数");
      assert.equal(report.llm.notes, "one real, one hallucinated");
    });
  });
});

test("doctor decisionHealth section reports counts and warns on orphans", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    await runNextTask(dir);
    await denyOnce(dir, "docs/a.md");
    // 孤儿标注：指向一个不存在（或已被截断）的 decisionId。
    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      resolveWildArrangePath(dir, "annotations.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), id: "ann_orphan", decisionId: "dec_gone", category: "rule_wrong", reason: null, author: null })}\n`,
      "utf8",
    );
    // decisions.jsonl 坏行：读侧跳过且 doctor 必须预警。
    await appendFile(resolveWildArrangePath(dir, "decisions.jsonl"), "not-json-at-all\n", "utf8");

    const report = await runDoctor(dir);
    const section = report.sections.decisionHealth;
    assert.ok(section, "doctor 必须有 decisionHealth 分项");
    assert.equal(section.status, "ok");
    assert.ok(section.totalDecisions > 0);
    assert.ok(section.gates.some((gate) => gate.gate === "pre_tool_use"));
    assert.equal(section.annotations.unmatchedCount, 1);
    const healthWarns = report.findings.filter((finding) => finding.section === "decision_health" && finding.severity === "warn");
    assert.ok(healthWarns.some((finding) => finding.message.includes("annotation")), "孤儿标注必须预警");
    assert.ok(healthWarns.some((finding) => finding.message.includes("corrupt")), "坏行必须预警");
  });
});
