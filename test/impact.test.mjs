import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { computeImpact, computeZoneTests, listRepoTests } from "../src/infra/dependency-graph.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");

test("impact lists the reverse-transitive importers of a changed infra file", async () => {
  const report = await computeImpact(ROOT, ["src/infra/ledger.mjs"]);
  assert.deepEqual(report.unknownChanged, []);
  // ledger 被多区引用；至少这些直接进口方必须出现。
  assert.ok(report.affected.includes("src/interface/adapters.mjs"), "adapters.mjs imports ledger");
  assert.ok(report.affected.includes("src/orchestration/status.mjs"), "status.mjs imports ledger");
  // 反向闭包必须到达间接进口方（status → dashboard 的传递链）。
  assert.ok(report.affected.includes("src/interface/dashboard.mjs"), "dashboard imports status which imports ledger");
  // 应跑测试：命中命名对位 + 直接引用 ledger 的测试 + 边界测试常驻。
  assert.ok(report.testsToRun.includes("test/ledger-tail.test.mjs"));
  assert.ok(report.testsToRun.includes("test/dependency-boundary.test.mjs"));
  assert.match(report.summary, /影响 \d+ 个文件，应跑 \d+ 个测试/);
});

test("impact maps a zoned implementation to its同名 test and stays inside the repo", async () => {
  const report = await computeImpact(ROOT, ["src/interface/doctor.mjs"]);
  assert.ok(report.testsToRun.includes("test/doctor.test.mjs"));
  assert.ok(report.testsToRun.includes("test/dependency-boundary.test.mjs"));
  for (const file of [...report.changed, ...report.affected, ...report.testsToRun]) {
    assert.ok(!file.startsWith(".."), `path escaped repo: ${file}`);
  }
});

test("impact reports unknown paths instead of crashing", async () => {
  const report = await computeImpact(ROOT, ["src/no-such-file.mjs"]);
  assert.deepEqual(report.changed, []);
  assert.deepEqual(report.unknownChanged, ["src/no-such-file.mjs"]);
  assert.deepEqual(report.affected, []);
  assert.deepEqual(report.testsToRun, ["test/dependency-boundary.test.mjs"]);
});

test("wildarrange impact CLI prints the report for a changed file", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["bin/wildarrange.mjs", "impact", "src/infra/ledger.mjs"],
    { cwd: ROOT },
  );
  const report = JSON.parse(stdout);
  assert.equal(report.kind, "impact_report");
  assert.ok(report.affected.length > 0);
  assert.ok(report.testsToRun.includes("test/dependency-boundary.test.mjs"));
});

test("zone tests select the tests that import the zone, plus naming pairs and the boundary test", async () => {
  const report = await computeZoneTests(ROOT, "interface");
  assert.equal(report.kind, "zone_test_report");
  assert.ok(report.zoneFiles > 0);
  // 命名对位：src/interface/doctor.mjs → test/doctor.test.mjs。
  assert.ok(report.testsToRun.includes("test/doctor.test.mjs"));
  // 引用闭包：decision-log 测试直接 import interface/decisions.mjs。
  assert.ok(report.testsToRun.includes("test/decision-log.test.mjs"));
  // 边界测试常驻。
  assert.ok(report.testsToRun.includes("test/dependency-boundary.test.mjs"));

  const all = await listRepoTests(ROOT);
  assert.ok(all.includes("test/impact.test.mjs"));
  for (const zone of ["orchestration", "ai", "capabilities", "infra"]) {
    const zoneReport = await computeZoneTests(ROOT, zone);
    assert.ok(zoneReport.testsToRun.length >= 1, `zone ${zone} should select at least the boundary test`);
    assert.ok(zoneReport.testsToRun.includes("test/dependency-boundary.test.mjs"));
  }
  await assert.rejects(computeZoneTests(ROOT, "no-such-zone"), /unknown zone/);
});

test("wildarrange test CLI runs the impact-selected subset and passes through the exit code", async () => {
  // cli-help.mjs 的真实闭包稳定包含同名测试和依赖边界测试，足够证明
  // CLI 会执行选中集合；不要在这条 CLI 自测里再嵌套一轮近全量测试。
  // 注意：本测试自身运行在 node --test 下，wildarrange test 必须剥掉
  // NODE_TEST_CONTEXT，否则子进程会空跑退出——这里同时断言真实测试输出。
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["bin/wildarrange.mjs", "test", "src/interface/cli-help.mjs"],
    { cwd: ROOT },
  );
  assert.match(stderr, /应跑 \d+ 个测试/);
  assert.match(stderr, /test\/cli-help\.test\.mjs/);
  assert.match(stdout, /ℹ pass [1-9]/, "child test run must actually execute tests");
});

test("wildarrange test CLI rejects an unknown zone with a non-zero exit code", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["bin/wildarrange.mjs", "test", "--zone", "no-such-zone"], { cwd: ROOT }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(String(error.stderr), /unknown zone/);
      return true;
    },
  );
});
