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
import { readFile } from "node:fs/promises";
import test from "node:test";

import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { writeRuntimeContextSnapshot } from "../src/infra/runtime-snapshot.mjs";
import { writeContextSnapshot } from "../src/ai/context.mjs";
import { withExternalProject } from "./helpers/external-fixture.mjs";

test("runtime snapshot is the single context renderer and init keeps automatic refresh", async () => {
  // 不用夹具的 init：本用例正是要证明 init 自动刷新快照。
  await withExternalProject(async ({ projectRoot: rootDir }) => {
    await initRuntime(rootDir);
    const automatic = await readJson(resolveWildArrangePath(rootDir, "snapshots", "context.json"));
    assert.equal(automatic.reason, "snapshot:initialized");

    const direct = await writeRuntimeContextSnapshot(rootDir, { reason: "equivalence" });
    const wrapped = await writeContextSnapshot(rootDir, { reason: "equivalence" });
    assert.deepEqual({ ...wrapped, at: null }, { ...direct, at: null });
    assert.match(await readFile(resolveWildArrangePath(rootDir, "snapshots", "context.md"), "utf8"), /WildArrange Resume Context/);
  }, { init: false });
});
