// =============================================================================
// 文件名称：admission-paths.test.mjs
// 所属模块：test
// 作用说明：
//   验证 collectActualAdmissionPaths 从 git 工作区收集实际准入路径：
//   含未跟踪新文件、无 tracked diff 时的 untracked、非 git 目录回退。
//   不测：并行准入裁决、dashboard 写入或 adoption 事务。
//
// 【运行原理速读】
//   在临时 git 仓库中创建/修改文件，调用 collectActualAdmissionPaths，
//   断言返回路径集合正确排除 .wildarrange 并覆盖各 git 状态分支。
// =============================================================================

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { collectActualAdmissionPaths } from "../src/orchestration/admission.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1_000_000,
  });
  return result.stdout;
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-admission-paths-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("collectActualAdmissionPaths includes untracked new files and excludes .wildarrange", async () => {
  await withTempDir(async (dir) => {
    await git(dir, ["init"]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "tracked.mjs"), "export const before = 1;\n", "utf8");
    await git(dir, ["add", "src/tracked.mjs"]);
    await git(dir, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);

    await writeFile(path.join(dir, "src", "tracked.mjs"), "export const after = 2;\n", "utf8");
    await writeFile(path.join(dir, "src", "agent-created.mjs"), "export const fresh = true;\n", "utf8");
    await mkdir(path.join(dir, ".wildarrange"), { recursive: true });
    await writeFile(path.join(dir, ".wildarrange", "state.json"), "{}\n", "utf8");

    const paths = await collectActualAdmissionPaths(dir, []);
    assert.ok(paths.includes("src/agent-created.mjs"), `untracked file missing from: ${JSON.stringify(paths)}`);
    assert.ok(paths.includes("src/tracked.mjs"), `modified file missing from: ${JSON.stringify(paths)}`);
    assert.ok(!paths.some((filePath) => filePath.startsWith(".wildarrange")), `.wildarrange leaked into: ${JSON.stringify(paths)}`);
  });
});

test("collectActualAdmissionPaths returns untracked files even without any tracked diff", async () => {
  await withTempDir(async (dir) => {
    await git(dir, ["init"]);
    await writeFile(path.join(dir, "brand-new.txt"), "hello\n", "utf8");

    const paths = await collectActualAdmissionPaths(dir, ["fallback.txt"]);
    assert.deepEqual(paths, ["brand-new.txt"]);
  });
});

test("collectActualAdmissionPaths falls back outside a git repository", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "loose.txt"), "hello\n", "utf8");
    const paths = await collectActualAdmissionPaths(dir, ["fallback.txt"]);
    assert.deepEqual(paths, ["fallback.txt"]);
  });
});
