import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
