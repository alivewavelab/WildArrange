// =============================================================================
// 文件名称：runtime-bootstrap.mjs
// 所属模块：infra
// 作用说明：
//   运行时 init/doctor 引导：目录、prompt-pack、配置与 ledger 自检。
//
// 【运行原理速读】
//   ensureWildArrangeDirs → installPromptPack → verifyLedger → gate arming 提示。
// =============================================================================
import { existsSync } from "node:fs";
import { appendLedger } from "./ledger.mjs";
import { DEFAULT_PROMPT_PACK_DIR, installPromptPack, isPromptPackCurrent } from "./prompt-pack.mjs";
import { writeDefaultWildArrangeConfig } from "./runtime-config.mjs";
import { writeSnapshot } from "./runtime-snapshot.mjs";
import {
  STATE_VERSION,
  createWorkId,
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "./runtime-store.mjs";

/**
 * initRuntime：本模块对外异步 API。
 */
export async function initRuntime(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const configResult = await writeDefaultWildArrangeConfig(rootDir, { force: options.force });

  const workPath = resolveWildArrangePath(rootDir, "work.json");
  let workCreated = false;
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
    workCreated = true;
  }

  const promptPackDir = options.promptPackDir || DEFAULT_PROMPT_PACK_DIR;
  const promptPackCurrent = options.force ? false : await isPromptPackCurrent(rootDir, promptPackDir);
  if (!promptPackCurrent) await installPromptPack(rootDir, promptPackDir);

  if (options.force || configResult.created || workCreated || !promptPackCurrent) {
    await appendLedger(rootDir, { type: "runtime_initialized", configPath: configResult.path });
    await writeSnapshot(rootDir, "initialized");
  }
  return readJson(workPath);
}
