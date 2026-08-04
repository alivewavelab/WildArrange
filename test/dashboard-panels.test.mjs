/**
 * Dashboard 决策/运维面板测试：两个只读 GET 端点返回 ViewModel，
 * 首页 HTML 包含面板挂载点；面板不引入任何写路径。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { startDashboardServer } from "../src/interface/dashboard.mjs";
import { runInjectionHook } from "../src/ai/hooks.mjs";
import { importPlan, initRuntime, resolveHelixPath } from "../src/helix-core.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-panels-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withDashboard(dir, fn) {
  const server = await startDashboardServer(dir, { host: "127.0.0.1", port: 0 });
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    assert.ok(port);
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function importPassingPlan(dir) {
  const planPath = resolveHelixPath(dir, "artifacts", "panels-plan.json");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify({
    title: "Panels",
    tasks: [
      {
        id: "T001",
        title: "panel task",
        owner: "ZhuRong",
        writable_paths: ["src/**"],
        verify_commands: ["node -e \"process.exit(0)\""],
      },
    ],
  }, null, 2));
  await importPlan(dir, planPath);
}

test("decisions and ops panels serve read-only view models", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    await runInjectionHook(dir, {
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "docs/out-of-scope.md" },
      cwd: dir,
      session_id: "panels-test",
    });

    await withDashboard(dir, async (base) => {
      const decisionsResponse = await fetch(`${base}/api/panels/decisions`, { cache: "no-store" });
      assert.equal(decisionsResponse.status, 200);
      const decisions = await decisionsResponse.json();
      assert.equal(decisions.kind, "helix_dashboard_decisions_panel");
      assert.ok(decisions.recent.some((record) => record.gate === "pre_tool_use"));
      assert.ok(decisions.neverFiredGates.includes("admission"));

      const opsResponse = await fetch(`${base}/api/panels/ops`, { cache: "no-store" });
      assert.equal(opsResponse.status, 200);
      const ops = await opsResponse.json();
      assert.equal(ops.kind, "helix_dashboard_ops_panel");
      assert.ok(ops.gateArming, "运维面板必须带门武装状态");
      assert.equal(ops.locks.length, 2, "tasks.lock 与 ledger.lock 都在巡检");
      assert.ok(ops.files.some((file) => file.path === ".helix/decisions.jsonl"));

      const html = await (await fetch(`${base}/`, { cache: "no-store" })).text();
      assert.match(html, /决策面板/);
      assert.match(html, /运维面板/);
      assert.match(html, /loadPanels/);
    });
  });
});

test("panels tolerate a corrupted decisions.jsonl without 500", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    await writeFile(resolveHelixPath(dir, "decisions.jsonl"), '{"gate":"verify"\nnot-json\n', "utf8");

    await withDashboard(dir, async (base) => {
      const response = await fetch(`${base}/api/panels/decisions`, { cache: "no-store" });
      assert.equal(response.status, 200, "坏行必须降级而不是 500");
      const payload = await response.json();
      assert.ok(payload.skippedLines >= 1);
    });
  });
});
