// =============================================================================
// 文件名称：external-fixture.test.mjs
// 所属模块：test
// 作用说明：
//   证明共享外置三根夹具得到真实的外置上下文：运行态在项目外、项目内零 WildArrange 文件。
// =============================================================================

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { resolveWorkspaceContext } from "../src/infra/workspace-context.mjs";
import { withExternalProject } from "./helpers/external-fixture.mjs";

test("external fixture attaches three separate roots and keeps the project free of runtime files", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot, stateHome }) => {
    const context = await resolveWorkspaceContext(projectRoot);
    assert.equal(context.mode, "external");
    assert.equal(context.governanceRoot, governanceRoot);
    assert.ok(context.runtimeRoot.startsWith(stateHome), "runtime root lives under the isolated state home");
    assert.ok(resolveWildArrangePath(projectRoot, "team", "tasks.json").startsWith(context.runtimeRoot));
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);
  });
});
