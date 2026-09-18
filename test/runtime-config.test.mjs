import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RUNTIME_NAME,
  DEFAULT_WILDARRANGE_CONFIG,
} from "../src/infra/default-config.mjs";
import { loadWildArrangeConfig } from "../src/infra/runtime-config.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function getPath(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], value);
}

test("repo root config carries every key the example config documents", async () => {
  const example = JSON.parse(await readFile(path.join(REPO_ROOT, "wildarrange.config.example.json"), "utf8"));
  const repoConfig = JSON.parse(await readFile(path.join(REPO_ROOT, "wildarrange.config.json"), "utf8"));
  // 第 2 期整改补齐的键：example 已声明而正式配置曾经缺失，值照抄 example。
  const requiredPaths = [
    "adapters.kimi",
    "agents.Jiuwei.skills",
    "agents.DiJiang.skills",
    "agents.ZhuRong.skills",
    "agents.BaiZe.skills",
    "agents.LuWu.skills",
    "routeGovernance",
    "gitCoordination",
    "parallelAgents.retainUntilUserAcceptance",
    "parallelAgents.defaultAdapter",
    "parallelAgents.spawnAdapters",
    "skillMatcher",
    "contextBudgets",
    "review.responsibility",
    "review.steps",
    "verificationGovernance",
    "qualityGates.astStructure",
    "qualityGates.hashlineAnchors",
    "executionReadiness",
  ];
  for (const dottedPath of requiredPaths) {
    assert.deepEqual(
      getPath(repoConfig, dottedPath),
      getPath(example, dottedPath),
      `wildarrange.config.json must carry ${dottedPath} with the example value`,
    );
  }

  const { config, sourcePath } = await loadWildArrangeConfig(REPO_ROOT);
  assert.equal(sourcePath, "wildarrange.config.json");
  assert.equal(config.gitCoordination.mode, "guarded");
  assert.deepEqual(config.review.steps, []);
});

test("config loading falls back to built-in defaults when no config file exists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-runtime-config-"));
  try {
    const { config, sourcePath } = await loadWildArrangeConfig(dir);
    assert.equal(sourcePath, "default");
    assert.equal(config.runtime, DEFAULT_RUNTIME_NAME);
    assert.deepEqual(config.gitCoordination, DEFAULT_WILDARRANGE_CONFIG.gitCoordination);
    assert.deepEqual(config.skillMatcher, DEFAULT_WILDARRANGE_CONFIG.skillMatcher);
    assert.deepEqual(config.contextBudgets, DEFAULT_WILDARRANGE_CONFIG.contextBudgets);
    assert.deepEqual(config.executionReadiness, DEFAULT_WILDARRANGE_CONFIG.executionReadiness);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy runtime name literal normalizes to the default runtime", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-runtime-config-"));
  try {
    await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({ runtime: "wildarrange-linear" }), "utf8");
    const { config } = await loadWildArrangeConfig(dir);
    assert.equal(config.runtime, DEFAULT_RUNTIME_NAME);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
