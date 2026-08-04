import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const FOUNDATION_EXPORTS = [
  "AGENT_ALIASES",
  "AGENT_DISPLAY_NAMES",
  "COMMAND_WORKER_AGENTS",
  "DEFAULT_CLI_COMMAND",
  "DEFAULT_EXECUTOR_AGENT",
  "DEFAULT_HELIX_CONFIG",
  "DEFAULT_LEAD_AGENT",
  "DEFAULT_PACKAGE_NAME",
  "DEFAULT_PROMPT_PACK_DIR",
  "DEFAULT_REVIEW_AGENTS",
  "DEFAULT_RUNTIME_NAME",
  "HELIX_CONFIG_FILE",
  "HELIX_DIR",
  "LONG_LIVED_AGENTS",
  "PRODUCT_NAME",
  "PROJECT_DIR",
  "READ_ONLY_LONG_LIVED_AGENTS",
  "STATE_VERSION",
  "TASK_STATUSES",
  "appendLedger",
  "assertCommandWorkerAgent",
  "createWorkId",
  "displayAgentName",
  "ensureHelixDirs",
  "hashContent",
  "initRuntime",
  "installPromptPack",
  "isLongLivedAgent",
  "listPromptPack",
  "loadHelixConfig",
  "loadPromptPackEntries",
  "normalizeAgentKey",
  "nowIso",
  "readJson",
  "renderPromptPackEntry",
  "resolveHelixPath",
  "verifyLedger",
  "withTaskStateLock",
  "writeDefaultHelixConfig",
  "writeJsonAtomic",
  "writeSnapshot",
];

const CORE_FOUNDATION_EXPORTS = [
  "DEFAULT_CLI_COMMAND",
  "DEFAULT_EXECUTOR_AGENT",
  "DEFAULT_HELIX_CONFIG",
  "DEFAULT_LEAD_AGENT",
  "DEFAULT_PACKAGE_NAME",
  "DEFAULT_PROMPT_PACK_DIR",
  "DEFAULT_REVIEW_AGENTS",
  "DEFAULT_RUNTIME_NAME",
  "HELIX_CONFIG_FILE",
  "HELIX_DIR",
  "PRODUCT_NAME",
  "STATE_VERSION",
  "TASK_STATUSES",
  "appendLedger",
  "createWorkId",
  "ensureHelixDirs",
  "hashContent",
  "initRuntime",
  "installPromptPack",
  "listPromptPack",
  "loadHelixConfig",
  "loadPromptPackEntries",
  "nowIso",
  "readJson",
  "renderPromptPackEntry",
  "resolveHelixPath",
  "verifyLedger",
  "withTaskStateLock",
  "writeDefaultHelixConfig",
  "writeJsonAtomic",
  "writeSnapshot",
];

test("foundation split preserves the exact 41-symbol compatibility surface", async () => {
  const foundation = await import("../src/infra/foundation.mjs");
  const legacyFoundation = await import("../src/helix-foundation.mjs");
  assert.deepEqual(Object.keys(foundation).sort(), FOUNDATION_EXPORTS);
  assert.deepEqual(Object.keys(legacyFoundation).sort(), FOUNDATION_EXPORTS);
});

test("helix-core preserves every existing Foundation export", async () => {
  const core = await import("../src/helix-core.mjs");
  assert.deepEqual(
    CORE_FOUNDATION_EXPORTS.filter((symbol) => !(symbol in core)),
    [],
  );
});

test("runtime snapshot is the single context renderer and init keeps automatic refresh", async () => {
  const { initRuntime, readJson, resolveHelixPath } = await import("../src/infra/foundation.mjs");
  const { writeRuntimeContextSnapshot } = await import("../src/infra/runtime-snapshot.mjs");
  const { writeContextSnapshot } = await import("../src/ai/context.mjs");
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-foundation-split-"));
  try {
    await initRuntime(rootDir);
    const automatic = await readJson(resolveHelixPath(rootDir, "snapshots", "context.json"));
    assert.equal(automatic.reason, "snapshot:initialized");

    const direct = await writeRuntimeContextSnapshot(rootDir, { reason: "equivalence" });
    const wrapped = await writeContextSnapshot(rootDir, { reason: "equivalence" });
    assert.deepEqual({ ...wrapped, at: null }, { ...direct, at: null });
    assert.match(await readFile(resolveHelixPath(rootDir, "snapshots", "context.md"), "utf8"), /WildArrange Resume Context/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
