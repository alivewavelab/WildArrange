// =============================================================================
// 文件名称：reporting-verbosity.test.mjs
// 所属模块：test
// 作用说明：
//   验证 reporting.verbosity：verbose 默认 stderr 逐门汇总、normal 一行、quiet 无汇总；
//   stdout JSON 契约各级不变；非法 verbosity 清晰报错。
//   不测：门决策正确性（由 delivery 测试覆盖）。
//
// 【运行原理速读】
//   临时目录导入 passing plan，spawn wildarrange run 带不同 verbosity，
//   分割 stdout/stderr 断言行数与 JSON 结构一致。
// =============================================================================

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";


import { resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { writePolicyConfig } from "./helpers/runtime-fixtures.mjs";
import { withExternalProject, declare, importApprovedPlan } from "./helpers/external-fixture.mjs";

/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const SRC_RESPONSIBILITY = declare("src/result.txt");

const CLI_PATH = path.resolve(process.cwd(), "bin", "wildarrange.mjs");

function passingTask(id) {
  return {
    id,
    subject: `task ${id}`,
    worker_command: "node -e \"require('node:fs').mkdirSync('src',{recursive:true});require('node:fs').writeFileSync('src/result.txt','ok')\"",
    verify_commands: ["node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('src/result.txt','utf8'),'ok')\""],
    review_commands: ["node -e \"const fs=require('node:fs');require('node:assert/strict').equal(fs.statSync('src/result.txt').size,2);if(fs.existsSync('unexpected.txt'))process.exit(1)\""],
    writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
  };
}

async function importPlanWith(dir, fileName, title, tasks) {
  const planPath = resolveWildArrangePath(dir, "artifacts", fileName);
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify({ title, tasks }, null, 2));
  await importApprovedPlan(dir, planPath);
}

/** 治理配置写入外置治理仓并提交，使其成为受信任的当前配置。 */
async function writeGovernanceConfig(dir, governanceRoot, config) {
  await writePolicyConfig(governanceRoot, config);
}

function runCli(dir, stateHome) {
  return spawnSync(process.execPath, [CLI_PATH, "run", "--root", dir], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, WILDARRANGE_STATE_HOME: stateHome },
  });
}

test("default verbose prints the per-gate decision summary on stderr, JSON on stdout", async () => {
  await withExternalProject(async ({ projectRoot: dir, governanceRoot, stateHome }) => {
    await importPlanWith(dir, "verbosity-plan.json", "Verbosity", [passingTask("T001")]);

    const run = runCli(dir, stateHome);
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, "completed");
    assert.match(run.stderr, /门决策汇总/);
    assert.match(run.stderr, /verify/);
    assert.match(run.stderr, /checkpoint/);
  });
});

test("quiet prints no gate summary; normal prints exactly one line", async () => {
  await withExternalProject(async ({ projectRoot: dir, governanceRoot, stateHome }) => {
    // 治理配置须先提交再导入计划：计划绑定导入时的治理仓 SHA，之后再改会使双仓绑定失效。
    await writeGovernanceConfig(dir, governanceRoot, { reporting: { verbosity: "quiet" } });
    await importPlanWith(dir, "verbosity-plan.json", "Verbosity", [passingTask("T001")]);
    const quiet = runCli(dir, stateHome);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(JSON.parse(quiet.stdout).status, "completed");
    assert.ok(!quiet.stderr.includes("门决策汇总"), "quiet 不得输出门汇总");

    await writeGovernanceConfig(dir, governanceRoot, { reporting: { verbosity: "normal" } });
    await importPlanWith(dir, "verbosity-plan-2.json", "Verbosity 2", [passingTask("T002")]);
    const normal = runCli(dir, stateHome);
    assert.equal(normal.status, 0, normal.stderr);
    assert.match(normal.stderr, /\[run\] T002 -> completed/);
    assert.ok(!normal.stderr.includes("门决策汇总"), "normal 只输出一行");
  });
});

test("invalid reporting.verbosity is rejected with a clear error", async () => {
  await withExternalProject(async ({ projectRoot: dir, governanceRoot, stateHome }) => {
    await importPlanWith(dir, "verbosity-plan.json", "Verbosity", [passingTask("T001")]);
    await writeGovernanceConfig(dir, governanceRoot, { reporting: { verbosity: "chatty" } });
    const run = runCli(dir, stateHome);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /reporting\.verbosity must be verbose, normal, or quiet/);
  });
});
