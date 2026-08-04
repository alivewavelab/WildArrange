import { existsSync } from "node:fs";
import { appendLedger } from "./ledger.mjs";
import { DEFAULT_PROMPT_PACK_DIR, installPromptPack } from "./prompt-pack.mjs";
import { loadHelixConfig, writeDefaultHelixConfig } from "./runtime-config.mjs";
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
  const { config } = await loadHelixConfig(rootDir);

  const agentsPath = resolveHelixPath(rootDir, "agents.json");
  if (!existsSync(agentsPath) || options.force) {
    await writeJsonAtomic(agentsPath, {
      version: STATE_VERSION,
      agents: config.agents,
    });
  }

  const categoriesPath = resolveHelixPath(rootDir, "categories.json");
  if (!existsSync(categoriesPath) || options.force) {
    await writeJsonAtomic(categoriesPath, {
      version: STATE_VERSION,
      categories: {
        quick: { ...(config.dynamicAgents?.quick || {}), purpose: "small low-risk tasks" },
        deep: { ...(config.dynamicAgents?.deep || {}), purpose: "multi-file implementation" },
        ultrabrain: { ...(config.dynamicAgents?.ultrabrain || {}), purpose: "hard reasoning" },
        "visual-engineering": { ...(config.dynamicAgents?.["visual-engineering"] || {}), purpose: "ui and visual verification" },
      },
    });
  }

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
