// =============================================================================
// 文件名称：dashboard-health.test.mjs
// 所属模块：test
// 作用说明：
//   验证 dashboard /health 端点返回真实 config baseline 与 ledger 检查结果。
//   不测：其他 dashboard 面板或 adoption 写入路径。
//
// 【运行原理速读】
//   初始化临时 runtime 并启动 dashboard，请求 health JSON，
//   断言 config/ledger 相关字段非占位且与本地状态一致。
// =============================================================================

import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { writeConfigBaseline } from "../src/infra/security.mjs";
import { dashboardData } from "../src/orchestration/status.mjs";

test("dashboard health reports real config baseline and ledger checks", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-dashboard-health-"));
  try {
    await initRuntime(rootDir);
    const initial = await dashboardData(rootDir);
    assert.equal(initial.health.configBaseline.status, "unchecked");
    assert.match(initial.health.configBaseline.nextAction, /config baseline/);
    assert.equal(initial.health.ledger.status, "pass");

    await writeConfigBaseline(rootDir, { reason: "dashboard health test" });
    const baselined = await dashboardData(rootDir);
    assert.equal(baselined.health.configBaseline.status, "pass");

    await appendFile(resolveWildArrangePath(rootDir, "ledger.jsonl"), `${JSON.stringify({ type: "unverified_tamper" })}\n`, "utf8");
    const tampered = await dashboardData(rootDir);
    assert.equal(tampered.health.ledger.status, "fail");
    assert.match(tampered.health.ledger.nextAction, /ledger verify/);
    assert.ok(tampered.health.ledger.result.failures.length > 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
