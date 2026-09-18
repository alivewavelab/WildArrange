// =============================================================================
// 文件名称：runtime-snapshot-ownership.test.mjs
// 所属模块：test
// 作用说明：
//   验证 runtime snapshot 为唯一上下文渲染入口；init 保持自动 refresh。
//   不测：snapshot 内容全文 diff 或 dashboard 面板。
//
// 【运行原理速读】
//   initRuntime 后检查 snapshot 文件由 writeRuntimeContextSnapshot 生成，
//   断言 refresh 触发条件与单一 ownership 不变量。
// =============================================================================

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { writeRuntimeContextSnapshot } from "../src/infra/runtime-snapshot.mjs";
import { writeContextSnapshot } from "../src/ai/context.mjs";

test("runtime snapshot is the single context renderer and init keeps automatic refresh", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-foundation-split-"));
  try {
    await initRuntime(rootDir);
    const automatic = await readJson(resolveWildArrangePath(rootDir, "snapshots", "context.json"));
    assert.equal(automatic.reason, "snapshot:initialized");

    const direct = await writeRuntimeContextSnapshot(rootDir, { reason: "equivalence" });
    const wrapped = await writeContextSnapshot(rootDir, { reason: "equivalence" });
    assert.deepEqual({ ...wrapped, at: null }, { ...direct, at: null });
    assert.match(await readFile(resolveWildArrangePath(rootDir, "snapshots", "context.md"), "utf8"), /WildArrange Resume Context/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
