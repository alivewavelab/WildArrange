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
