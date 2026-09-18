// =============================================================================
// 文件名称：run-tests.mjs
// 所属模块：tooling
// 作用说明：
//   顺序执行 test/ 下全部 *.test.mjs 文件，每个文件独立 spawn node --test。
//   供 npm scripts 或 CI 一次性跑完仓库测试；不做用例筛选或并行。
//
// 【运行原理速读】
//   · 何时跑？package.json 的 test 脚本或人工 node tooling/run-tests.mjs。
//   · 做了什么？扫描 test/ → 按文件名排序 → 逐个 spawnSync(node --test) →
//     汇总失败数，任一失败则 exitCode=1。
//   · 缺了它会怎样？CI 仍可单文件 node --test，但缺少统一进度与超时封装。
// =============================================================================
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// §3.2：仓库根目录（本脚本位于 tooling/，向上一级）。
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// §3.2：测试根目录；仅扫描顶层 *.test.mjs，子目录用例由 selectRepoTests 或单文件 node --test 执行。
const testDir = path.join(rootDir, "test");
const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

let failed = 0;
for (const [index, name] of testFiles.entries()) {
  const relativePath = `test/${name}`;
  const startedAt = Date.now();
  process.stdout.write(`\n[WildArrange test ${index + 1}/${testFiles.length}] ${relativePath}\n`);
  const result = spawnSync(process.execPath, ["--test", relativePath], {
    cwd: rootDir,
    stdio: "inherit",
    // §3.2：单文件超时 180s，防止挂死用例拖垮 CI 全量跑。
    timeout: 180_000,
  });
  if (result.error) {
    failed += 1;
    process.stderr.write(`[WildArrange test] ${relativePath} did not finish: ${result.error.message}\n`);
    continue;
  }
  if (result.status !== 0) failed += 1;
  process.stdout.write(`[WildArrange test] ${relativePath} finished in ${Date.now() - startedAt}ms (exit ${result.status}).\n`);
}

if (failed > 0) {
  process.stderr.write(`\n[WildArrange test] ${failed}/${testFiles.length} test files failed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\n[WildArrange test] all ${testFiles.length} test files passed.\n`);
}
