import { existsSync } from "node:fs";
import { appendLedger } from "./ledger.mjs";
import { DEFAULT_PROMPT_PACK_DIR, installPromptPack } from "./prompt-pack.mjs";
import { writeDefaultHelixConfig } from "./runtime-config.mjs";
import { writeSnapshot } from "./runtime-snapshot.mjs";
import {
  STATE_VERSION,
  createWorkId,
  ensureHelixDirs,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "./runtime-store.mjs";

export async function initRuntime(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const configResult = await writeDefaultHelixConfig(rootDir, { force: options.force });

  const workPath = resolveHelixPath(rootDir, "work.json");
  if (!existsSync(workPath) || options.force) {
    await writeJsonAtomic(workPath, {
      version: STATE_VERSION,
      workId: createWorkId(),
      stage: "initialized",
      activePlanId: null,
      status: "idle",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  await installPromptPack(rootDir, options.promptPackDir || DEFAULT_PROMPT_PACK_DIR);
  await appendLedger(rootDir, { type: "runtime_initialized", configPath: configResult.path });
  await writeSnapshot(rootDir, "initialized");
  return readJson(workPath);
}
