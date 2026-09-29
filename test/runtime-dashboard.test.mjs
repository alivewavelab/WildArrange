// =============================================================================
// 文件名称：runtime-dashboard.test.mjs
// 所属模块：test
// 作用说明：
//   Dashboard HTTP：任务/收件箱/摘要操作不绕过门禁，非回环主机需 token。
// =============================================================================

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startDashboardServer } from "../src/interface/dashboard.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { withTempDir, withDashboard, fetchJson, postJson } from "./helpers/runtime-fixtures.mjs";

test("dashboard API drives task, inbox, and summary operations without bypassing gates", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "dashboard-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Dashboard workflow",
      tasks: [
        {
          id: "T001",
          subject: "Claim through dashboard",
          worker_command: "node -e \"if(!process.version)process.exit(1)\"",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
        },
        {
          id: "T002",
          subject: "Blocked dashboard task",
          blockedBy: ["T001"],
          worker_command: "node -e \"if(!process.version)process.exit(1)\"",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
        },
      ],
    }));
    await importPlan(dir, planPath);

    await withDashboard(dir, async (baseUrl) => {
      const authHeaders = { authorization: "Bearer dashboard-token" };
      const state = await fetchJson(`${baseUrl}/api/state`);
      assert.equal(state.response.status, 200);
      assert.equal(state.body.status.pending, 2);
      assert.equal(state.body.taskLedger.total, 2);
      assert.equal(state.body.taskLedger.tasks.length, 2);
      assert.equal(state.body.summary, null);

      const allTasks = await fetchJson(`${baseUrl}/api/tasks?all=true&type=maintenance`);
      assert.equal(allTasks.response.status, 200);
      assert.equal(allTasks.body.result.total, 2);

      const unauthenticatedRun = await postJson(`${baseUrl}/api/run-next`, {});
      assert.equal(unauthenticatedRun.response.status, 401);

      const crossSite = await postJson(`${baseUrl}/api/summary`, {}, {
        headers: { authorization: "Bearer dashboard-token", origin: "https://example.com" },
      });
      assert.equal(crossSite.response.status, 403);

      const blockedClaim = await postJson(`${baseUrl}/api/tasks/claim`, { taskId: "T002", owner: "Jiuwei" }, { headers: authHeaders });
      assert.equal(blockedClaim.response.status, 500);
      assert.match(blockedClaim.body.error, /blocked by T001/);

      const claimed = await postJson(`${baseUrl}/api/tasks/claim`, { taskId: "T001", owner: "Jiuwei" }, { headers: authHeaders });
      assert.equal(claimed.response.status, 200);
      assert.equal(claimed.body.result.task.status, "in_progress");
      assert.equal(claimed.body.result.task.owner, "Jiuwei");

      const task = await fetchJson(`${baseUrl}/api/tasks/T001`);
      assert.equal(task.response.status, 200);
      assert.equal(task.body.result.task.status, "in_progress");

      const badTaskPath = await fetchJson(`${baseUrl}/api/tasks/%E0%A4%A`);
      assert.equal(badTaskPath.response.status, 400);

      const badClaim = await postJson(`${baseUrl}/api/tasks/claim`, { taskId: "../T001", owner: "Jiuwei" }, { headers: authHeaders });
      assert.equal(badClaim.response.status, 400);

      const message = await postJson(`${baseUrl}/api/team/send`, {
        from: "Jiuwei",
        to: "Jiuwei",
        body: "Continue T001 from dashboard.",
      }, { headers: authHeaders });
      assert.equal(message.response.status, 200);
      assert.equal(message.body.result.to, "Jiuwei");

      const inbox = await fetchJson(`${baseUrl}/api/team/inbox?agent=Jiuwei`);
      assert.equal(inbox.response.status, 200);
      assert.equal(inbox.body.result.length, 1);
      assert.equal(inbox.body.result[0].body, "Continue T001 from dashboard.");

      const created = await postJson(`${baseUrl}/api/tasks/create`, {
        id: "T003",
        subject: "Append task from dashboard",
        blockedBy: ["T001"],
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }, { headers: authHeaders });
      assert.equal(created.response.status, 200);
      assert.equal(created.body.result.task.id, "T003");
      assert.equal(created.body.result.task.status, "pending");

      const draft = await postJson(`${baseUrl}/api/tasks/create`, {
        id: "T004",
        subject: "Capture a dashboard bug before triage",
        workType: "bug",
        priority: "P0",
        source: "user",
      }, { headers: authHeaders });
      assert.equal(draft.response.status, 200);
      assert.equal(draft.body.result.task.status, "draft");

      const readied = await postJson(`${baseUrl}/api/tasks/ready`, {
        taskId: "T004",
        patch: {
          writable_paths: ["src/**"],
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
        },
      }, { headers: authHeaders });
      assert.equal(readied.response.status, 200);
      assert.equal(readied.body.result.task.status, "pending");

      const summary = await postJson(`${baseUrl}/api/summary`, {}, { headers: authHeaders });
      assert.equal(summary.response.status, 200);
      assert.equal(summary.body.result.reason, "dashboard");
      assert.equal(summary.body.result.ok, false);

      const badNode = await postJson(`${baseUrl}/api/node/%E0%A4%A`, { taskId: "T001" }, { headers: authHeaders });
      assert.equal(badNode.response.status, 400);

      const refreshed = await fetchJson(`${baseUrl}/api/state`);
      assert.equal(refreshed.response.status, 200);
      assert.equal(refreshed.body.summary.reason, "dashboard");
      assert.equal(refreshed.body.tasks.length, 4);
      assert.equal(refreshed.body.taskLedger.total, 4);
    }, { token: "dashboard-token" });
  });
});

test("dashboard requires a token for non-loopback hosts and enforces API auth", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.throws(
      () => startDashboardServer(dir, { host: "0.0.0.0", port: 0 }),
      /requires --token or WILDARRANGE_DASHBOARD_TOKEN/,
    );

    const server = await startDashboardServer(dir, { host: "127.0.0.1", port: 0, token: "secret-token" });
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      assert.ok(port);
      const baseUrl = `http://127.0.0.1:${port}`;

      const page = await fetch(baseUrl);
      const pageHtml = await page.text();
      assert.equal(page.status, 200);
      assert.doesNotMatch(pageHtml, /secret-token/);
      assert.doesNotMatch(pageHtml, /API Token/);
      assert.match(pageHtml, /sessionStorage\.getItem/);
      const dashboardCookie = page.headers.get("set-cookie");
      assert.match(dashboardCookie, /^wildarrange_dashboard=secret-token; HttpOnly; SameSite=Strict; Path=\/$/);

      const readable = await fetchJson(`${baseUrl}/api/state`);
      assert.equal(readable.response.status, 200);

      const denied = await postJson(`${baseUrl}/api/summary`, {});
      assert.equal(denied.response.status, 401);

      const allowed = await fetchJson(`${baseUrl}/api/state`, {
        headers: { authorization: "Bearer secret-token" },
      });
      assert.equal(allowed.response.status, 200);

      const writeAllowed = await postJson(`${baseUrl}/api/summary`, {}, {
        headers: { authorization: "Bearer secret-token" },
      });
      assert.equal(writeAllowed.response.status, 200);

      const browserWriteAllowed = await postJson(`${baseUrl}/api/summary`, {}, {
        headers: { cookie: dashboardCookie },
      });
      assert.equal(browserWriteAllowed.response.status, 200);

      const oversized = await postJson(`${baseUrl}/api/team/send`, {
        from: "Jiuwei",
        to: "ZhuRong",
        body: "x".repeat(65_000),
      }, {
        headers: { authorization: "Bearer secret-token" },
      });
      assert.equal(oversized.response.status, 413);
      assert.equal(oversized.body.error, "request body too large");
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
