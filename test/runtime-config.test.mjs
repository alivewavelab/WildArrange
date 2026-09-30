// =============================================================================
// 文件名称：runtime-config.test.mjs
// 所属模块：test
// 作用说明：
//   验证配置加载：example 配置只含已知键并可作为治理配置加载、无文件时内置默认、
//   runtime 名称字面量归一化。
//   不测：环境变量覆盖矩阵或热重载。
//
// 【运行原理速读】
//   读写治理仓 policy/wildarrange.config.json fixture，调用 loadWildArrangeConfig，
//   断言合并结果与 DEFAULT 键集合一致。
// =============================================================================

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RUNTIME_NAME,
  DEFAULT_WILDARRANGE_CONFIG,
} from "../src/infra/default-config.mjs";
import { loadWildArrangeConfig } from "../src/infra/runtime-config.mjs";
import { resolveGovernancePaths } from "../src/infra/runtime-store.mjs";
import { withExternalProject } from "./helpers/external-fixture.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the example governance config only uses known keys and loads as policy/wildarrange.config.json", async () => {
  const example = JSON.parse(await readFile(path.join(REPO_ROOT, "wildarrange.config.example.json"), "utf8"));
  const known = new Set(Object.keys(DEFAULT_WILDARRANGE_CONFIG));
  // $comment 是示例里的说明字段；其余键必须是已知配置键，未列出的键取内置默认值
  assert.deepEqual(Object.keys(example).filter((key) => key !== "$comment" && !known.has(key)), []);
  await withExternalProject(async ({ projectRoot }) => {
    await writeFile(governanceConfigFile(projectRoot), JSON.stringify(example), "utf8");
    const { config, sourcePath } = await loadWildArrangeConfig(projectRoot);
    assert.match(sourcePath, /policy[\\/]wildarrange\.config\.json$/);
    assert.equal(config.gitDelivery.requireWorktreeForParallelWrites, true);
    assert.equal("gitCoordination" in config, false);
  }, { init: false });
});

test("config loading falls back to built-in defaults when no config file exists", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const { config, sourcePath } = await loadWildArrangeConfig(projectRoot);
    assert.equal(sourcePath, "default");
    assert.equal(config.runtime, DEFAULT_RUNTIME_NAME);
    assert.deepEqual(config.gitDelivery, DEFAULT_WILDARRANGE_CONFIG.gitDelivery);
    assert.deepEqual(config.skillMatcher, DEFAULT_WILDARRANGE_CONFIG.skillMatcher);
    assert.deepEqual(config.contextBudgets, DEFAULT_WILDARRANGE_CONFIG.contextBudgets);
    assert.deepEqual(config.executionReadiness, DEFAULT_WILDARRANGE_CONFIG.executionReadiness);
  }, { init: false });
});

/** 外置治理配置文件的绝对路径（治理仓内）。 */
function governanceConfigFile(projectRoot) {
  const governance = resolveGovernancePaths(projectRoot);
  return path.join(governance.rootDir, governance.configPath);
}

test("runtime name literal normalizes to the default runtime", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    await writeFile(governanceConfigFile(projectRoot), JSON.stringify({ runtime: "wildarrange-linear" }), "utf8");
    const { config } = await loadWildArrangeConfig(projectRoot);
    assert.equal(config.runtime, DEFAULT_RUNTIME_NAME);
  }, { init: false });
});

test("gitDelivery keeps only single-machine delivery keys", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    await writeFile(governanceConfigFile(projectRoot), JSON.stringify({
      gitDelivery: { remote: " upstream ", taskBranchPrefix: "/wa/task/", requireWorktreeForParallelWrites: false, mode: "strict", requireTakeoverReason: true },
    }), "utf8");
    const { config } = await loadWildArrangeConfig(projectRoot);
    assert.deepEqual(config.gitDelivery, {
      remote: "upstream",
      integrationBranch: "auto",
      taskBranchPrefix: "wa/task",
      requireWorktreeForParallelWrites: false,
    });
  }, { init: false });
});
