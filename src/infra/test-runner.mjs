// =============================================================================
// 文件名称：test-runner.mjs
// 所属模块：infra
// 作用说明：
//   依赖图驱动测试选择与 node --test 执行，CI/本地一致。
//
// 【运行原理速读】
//   selectRepoTests zone/impact → runRepoTests 剥离 NODE_TEST_* 后 spawnSync。
// =============================================================================
/**
 * Repo test selection and execution: maps "what changed" (or a zone) to the
 * minimal test set via dependency-graph, then spawns `node --test` and
 * propagates its exit code so CI and local runs behave identically.
 */
import { spawnSync } from "node:child_process";
import { computeImpact, computeZoneTests, listRepoTests } from "./dependency-graph.mjs";

/**
 * selectRepoTests：本模块对外异步 API。
 */
export async function selectRepoTests(rootDir, { zone, changedPaths = [] } = {}) {
  if (zone) {
    const report = await computeZoneTests(rootDir, zone);
    return { tests: report.testsToRun, selectionNote: report.summary };
  }
  if (changedPaths.length > 0) {
    const report = await computeImpact(rootDir, changedPaths);
    return { tests: report.testsToRun, selectionNote: report.summary };
  }
  const tests = await listRepoTests(rootDir);
  return { tests, selectionNote: `全量测试 ${tests.length} 个` };
}

/**
 * runRepoTests：本模块对外API。
 */
export function runRepoTests(rootDir, tests) {
  // 继承 NODE_TEST_CONTEXT 时，子进程 node --test 会误以为自己是由
  // 外层 runner 启动的 IPC 子进程而空跑退出（exit 0、零测试）——从
  // 测试进程或 npm script 里调 wildarrange test 必须剥掉这些 runner 私有变量。
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("NODE_TEST_")) delete childEnv[key];
  }
  const run = spawnSync(process.execPath, ["--test", ...tests], { cwd: rootDir, stdio: "inherit", env: childEnv });
  return typeof run.status === "number" ? run.status : 1;
}
