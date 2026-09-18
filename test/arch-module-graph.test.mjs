// =============================================================================
// 文件名称：arch-module-graph.test.mjs
// 所属模块：test
// 作用说明：
//   验证架构模块图脚本：文件映射校验、流程网格校验、
//   从 JS import 生成模块图、未知模块名可重载。
//   不测：运行时交付流水线或真实架构文档内容正确性。
//
// 【运行原理速读】
//   调用 doc/ 下 arch-module-graph 脚本对仓库快照执行 validate/generate，
//   断言退出码与输出结构符合门禁约定。
// =============================================================================

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.cwd();
const VALIDATE_SCRIPT = path.join(REPO_ROOT, "tooling", "arch-module-graph", "validate-module-file-map.mjs");
const FLOW_GRID_SCRIPT = path.join(REPO_ROOT, "tooling", "arch-module-graph", "validate-flow-grid.mjs");
const GENERATE_SCRIPT = path.join(REPO_ROOT, "tooling", "arch-module-graph", "generate-module-graph.mjs");

async function withTempDir(fn) {
  const baseDir = path.join(REPO_ROOT, ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "arch-module-graph-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runScript(script, args, cwd) {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    };
  }
}

test("arch-module-graph: validate-module-file-map 对本仓库门禁通过", async () => {
  const result = await runScript(VALIDATE_SCRIPT, [], REPO_ROOT);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Validated module file map: 6 modules/);
  assert.match(result.stdout, /0 orphans/);
});

test("arch-module-graph: validate-flow-grid 对本仓库总图布局门禁通过", async () => {
  const result = await runScript(FLOW_GRID_SCRIPT, [], REPO_ROOT);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Validated flow grids: \d+ grids checked, 0 layout mismatches\./);
});

test("arch-module-graph: generate-module-graph 从真实 JS import 生成图谱", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "tooling", "arch-module-graph"), { recursive: true });
    await mkdir(path.join(dir, "src", "demo"), { recursive: true });
    await mkdir(path.join(dir, "docs", "product"), { recursive: true });
    await writeFile(
      path.join(dir, "tooling", "arch-module-graph", "module-file-map.json"),
      JSON.stringify({ modules: { demo: { include: ["src/demo/"] } }, unowned: [] }),
    );
    await writeFile(
      path.join(dir, "src", "demo", "main.mjs"),
      'import { helper } from "./helper.mjs";\nexport function main() { return helper(); }\n',
    );
    await writeFile(
      path.join(dir, "src", "demo", "helper.mjs"),
      "export function helper() { return 1; }\n",
    );
    const overviewPath = path.join(dir, "docs", "product", "architecture-overview.html");
    await writeFile(
      overviewPath,
      '<html><body>\n<script>\nconst D = {\n  "demo": { name: "Demo", files: [] }\n};\n</script>\n</body></html>\n',
    );

    const result = await runScript(GENERATE_SCRIPT, [dir, "--depth=all"], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Generated graph: 1 modules, 2 files/);

    const overview = await readFile(overviewPath, "utf8");
    const block = overview.match(/<script type="application\/json" id="generated-graph">([\s\S]*?)<\/script>/);
    assert.ok(block, "generated-graph block missing");
    const generated = JSON.parse(block[1]);
    const files = generated.modules.demo.files;
    assert.deepEqual(files.map((f) => f.p).sort(), ["src/demo/helper.mjs", "src/demo/main.mjs"]);
    const main = files.find((f) => f.p === "src/demo/main.mjs");
    assert.deepEqual(main.to.map((t) => t.p), ["src/demo/helper.mjs"]);
  });
});

test("arch-module-graph: 多语言模板残留分支不回潮", async () => {
  const validateSrc = await readFile(VALIDATE_SCRIPT, "utf8");
  assert.ok(!validateSrc.includes("normalizeStyle"), "validate 不应再含 normalizeStyle");
  assert.ok(!validateSrc.includes("snake"), "validate 不应再含 snake 风格分支");
  assert.ok(!validateSrc.includes("kebab-strict"), "validate 不应再含 kebab-strict 分支");

  const generateSrc = await readFile(GENERATE_SCRIPT, "utf8");
  for (const residue of ["resolvePyAbs", "resolvePyRel", "resolveRust", "rustRoots", "importedNames", "src-tauri"]) {
    assert.ok(!generateSrc.includes(residue), `generate 不应再含 ${residue}`);
  }
});
