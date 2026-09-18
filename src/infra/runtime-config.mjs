// =============================================================================
// 文件名称：runtime-config.mjs
// 所属模块：infra
// 作用说明：
//   wildarrange.config.json 加载、默认值合并与环境覆盖。
//
// 【运行原理速读】
//   loadWildArrangeConfig → deepMerge default-config → 返回 sourcePath。
// =============================================================================
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { normalizeAgentKey } from "./agent-registry.mjs";
import { DEFAULT_RUNTIME_NAME, DEFAULT_WILDARRANGE_CONFIG } from "./default-config.mjs";
import { appendLedger } from "./ledger.mjs";
import {
  ensureWildArrangeDirs,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "./runtime-store.mjs";

/**
 * WILDARRANGE_CONFIG_FILE：本模块对外API。
 */
export const WILDARRANGE_CONFIG_FILE = "wildarrange.config.json";
/**
 * 产品显示名称常量。
 */
export const PRODUCT_NAME = "WildArrange";
/**
 * npm 包默认名称。
 */
export const DEFAULT_PACKAGE_NAME = "@alivewavelab/wildarrange";
/**
 * CLI 默认命令名。
 */
export const DEFAULT_CLI_COMMAND = "wildarrange";

/**
 * loadWildArrangeConfig：本模块对外异步 API。
 */
export async function loadWildArrangeConfig(rootDir) {
  const rootConfigPath = path.join(rootDir, WILDARRANGE_CONFIG_FILE);
  const runtimeConfigPath = resolveWildArrangePath(rootDir, "config.json");
  const rootConfig = await readJson(rootConfigPath, null);
  const runtimeConfig = await readJson(runtimeConfigPath, null);
  const sourcePath = rootConfig ? rootConfigPath : runtimeConfig ? runtimeConfigPath : null;
  // A checked-in root config is authoritative. The runtime copy used to be
  // treated as a hidden lower layer, which allowed removed legacy keys to
  // reappear whenever the root stopped overriding them.
  const selectedConfig = rootConfig || runtimeConfig || {};
  return {
    config: normalizeRuntimeConfig(deepMerge(DEFAULT_WILDARRANGE_CONFIG, selectedConfig)),
    sourcePath: sourcePath ? path.relative(rootDir, sourcePath) : "default",
  };
}

/**
 * migrateRuntimeConfigState：本模块对外异步 API。
 */
export async function migrateRuntimeConfigState(rootDir) {
  await ensureWildArrangeDirs(rootDir);
  const rootConfigPath = path.join(rootDir, WILDARRANGE_CONFIG_FILE);
  const runtimeConfigPath = resolveWildArrangePath(rootDir, "config.json");
  const rootConfig = await readJson(rootConfigPath, null);
  const runtimeConfig = await readJson(runtimeConfigPath, null);
  const source = rootConfig || runtimeConfig || {};
  const config = normalizeRuntimeConfig(deepMerge(DEFAULT_WILDARRANGE_CONFIG, source));
  await writeJsonAtomic(runtimeConfigPath, config);
  const removedProjections = [];
  for (const name of ["agents.json", "categories.json"]) {
    try {
      await unlink(resolveWildArrangePath(rootDir, name));
      removedProjections.push(`.wildarrange/${name}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return {
    kind: "runtime_config_migration",
    sourcePath: rootConfig ? WILDARRANGE_CONFIG_FILE : runtimeConfig ? ".wildarrange/config.json" : "default",
    runtimeConfigPath: path.relative(rootDir, runtimeConfigPath),
    removedProjections,
  };
}

/**
 * writeDefaultWildArrangeConfig：本模块对外异步 API。
 */
export async function writeDefaultWildArrangeConfig(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const targetPath = options.root === true ? path.join(rootDir, WILDARRANGE_CONFIG_FILE) : resolveWildArrangePath(rootDir, "config.json");
  if (!options.force && existsSync(targetPath)) {
    return { path: path.relative(rootDir, targetPath), created: false, config: await readJson(targetPath) };
  }
  const config = options.armed === true ? buildArmedConfig() : DEFAULT_WILDARRANGE_CONFIG;
  await writeJsonAtomic(targetPath, config);
  await appendLedger(rootDir, { type: "config_written", configPath: path.relative(rootDir, targetPath), root: options.root === true, armed: options.armed === true });
  return { path: path.relative(rootDir, targetPath), created: true, config };
}

/**
 * `config init --armed`：写出一份「门已武装」的配置——commentChecker 阻断发现
 * （无需任何外部工具即可构成独立复核信号与 required 质量门），lspDiagnostics
 * 留好命令位等用户填项目真实的 typecheck/test 命令。默认配置故意不武装
 * （黄灯提醒），--armed 是给「我知道自己在做什么」的显式入口。
 */
function buildArmedConfig() {
  return {
    ...DEFAULT_WILDARRANGE_CONFIG,
    qualityGates: {
      ...DEFAULT_WILDARRANGE_CONFIG.qualityGates,
      lspDiagnostics: {
        ...DEFAULT_WILDARRANGE_CONFIG.qualityGates?.lspDiagnostics,
        enabled: true,
        required: true,
        commands: ["node --test"],
      },
      commentChecker: {
        ...DEFAULT_WILDARRANGE_CONFIG.qualityGates?.commentChecker,
        enabled: true,
        blockOnFindings: true,
      },
    },
  };
}

/**
 * 归一化 RuntimeConfig 输入为稳定形态。
 */
function normalizeRuntimeConfig(config) {
  if (!isPlainObject(config)) return config;
  const normalized = { ...config };
  const readiness = normalized.executionReadiness;
  if (!isPlainObject(readiness)) throw new Error("executionReadiness must be an object");
  for (const key of ["workerProbe", "researchProbe"]) {
    if (readiness[key] != null && (typeof readiness[key] !== "string" || !readiness[key].trim())) throw new Error("executionReadiness." + key + " must be a nonempty command or null");
  }
  if (!Array.isArray(readiness.researchSkills) || readiness.researchSkills.some(name => typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name))) throw new Error("executionReadiness.researchSkills must contain Skill names");
  if (!Number.isInteger(readiness.timeoutMs) || readiness.timeoutMs < 1 || readiness.timeoutMs > 300000) throw new Error("executionReadiness.timeoutMs must be between 1 and 300000");
  if (!isPlainObject(normalized.review) || !Array.isArray(normalized.review.steps)) throw new Error("review.steps must be an array");
  delete normalized.dynamicAgents;
  delete normalized.promptVariants;
  // 兼容历史写法：旧配置中的 runtime 名字面量即默认 runtime。
  if (normalized.runtime === "wildarrange-linear") normalized.runtime = DEFAULT_RUNTIME_NAME;
  normalized.agents = normalizeAgentMap(normalized.agents);
  normalized.gitCoordination = normalizeGitCoordination(normalized.gitCoordination);
  if (Array.isArray(normalized.review?.llm?.agents)) {
    normalized.review = {
      ...normalized.review,
      llm: {
        ...normalized.review.llm,
        agents: normalized.review.llm.agents.map(normalizeAgentKey).filter(Boolean),
      },
    };
  }
  const verbosity = String(normalized.reporting?.verbosity || "verbose").trim().toLowerCase();
  if (!["verbose", "normal", "quiet"].includes(verbosity)) {
    throw new Error(`reporting.verbosity must be verbose, normal, or quiet; received ${normalized.reporting?.verbosity}`);
  }
  normalized.reporting = { ...normalized.reporting, verbosity };
  return normalized;
}

/**
 * 归一化 GitCoordination 输入为稳定形态。
 */
function normalizeGitCoordination(value) {
  const input = isPlainObject(value) ? value : {};
  const mode = String(input.mode || "guarded").trim().toLowerCase();
  if (!["off", "manual", "guarded", "strict"].includes(mode)) {
    throw new Error(`gitCoordination.mode must be off, manual, guarded, or strict; received ${input.mode}`);
  }
  const normalized = {
    ...input,
    mode,
    remote: nonEmptyConfigString(input.remote, "origin"),
    integrationBranch: nonEmptyConfigString(input.integrationBranch, "auto"),
    taskBranchPrefix: nonEmptyConfigString(input.taskBranchPrefix, "wildarrange/task").replace(/^\/+|\/+$/g, ""),
    requireWorktreeForParallelWrites: input.requireWorktreeForParallelWrites !== false,
    requireVerificationBeforeHandoff: input.requireVerificationBeforeHandoff === true,
    requireCleanHandoff: input.requireCleanHandoff !== false,
    // Takeover evidence is an immutable floor whenever this config exists;
    // keep the explicit field visible, but never normalize it to false.
    requireTakeoverReason: true,
  };
  // strict is a profile, not a collection of individually weakenable flags.
  if (mode === "strict") {
    normalized.requireWorktreeForParallelWrites = true;
    normalized.requireVerificationBeforeHandoff = true;
    normalized.requireCleanHandoff = true;
    normalized.requireTakeoverReason = true;
  }
  return normalized;
}

/**
 * nonEmptyConfigString 内部辅助。
 */
function nonEmptyConfigString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/**
 * 归一化 AgentMap 输入为稳定形态。
 */
function normalizeAgentMap(agents) {
  if (!isPlainObject(agents)) return agents;
  const normalized = {};
  for (const [name, value] of Object.entries(agents)) {
    const key = normalizeAgentKey(name);
    if (!key) continue;
    normalized[key] = isPlainObject(value) && isPlainObject(normalized[key])
      ? deepMerge(normalized[key], value)
      : value;
  }
  for (const [name, value] of Object.entries(normalized)) {
    if (!isPlainObject(value)) continue;
    normalized[name] = {
      ...value,
      skills: normalizeAgentSkills(value.skills, name),
    };
  }
  return normalized;
}

/**
 * 归一化 AgentSkills 输入为稳定形态。
 */
function normalizeAgentSkills(value, agentName) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`agents.${agentName}.skills must be an array`);
  const skills = [];
  for (const item of value) {
    if (typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.trim())) {
      throw new Error(`agents.${agentName}.skills contains an invalid skill name: ${String(item)}`);
    }
    const name = item.trim();
    if (!skills.includes(name)) skills.push(name);
  }
  return skills;
}

/**
 * deepMerge 内部辅助。
 */
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? deepMerge(result[key], value) : value;
  }
  return result;
}

/**
 * 判断 isPlainObject 条件。
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * updateProjectGovernanceConfig：本模块对外异步 API。
 */
export async function updateProjectGovernanceConfig(rootDir, patch, options = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key => !["review", "executionReadiness"].includes(key))) throw new Error("setup may only change review and executionReadiness");
  if (patch.review !== undefined && !isPlainObject(patch.review)) throw new Error("review must be an object");
  if (patch.executionReadiness !== undefined && !isPlainObject(patch.executionReadiness)) throw new Error("executionReadiness must be an object");
  if (patch.review && Object.keys(patch.review).some(key => !["steps", "responsibility"].includes(key))) throw new Error("setup review only accepts steps and responsibility");
  if (patch.executionReadiness && Object.keys(patch.executionReadiness).some(key => !["workerProbe", "researchProbe", "researchSkills", "timeoutMs"].includes(key))) throw new Error("unknown executionReadiness field");
  const current = await loadWildArrangeConfig(rootDir);
  const config = normalizeRuntimeConfig(deepMerge(current.config, patch));
  if (options.apply === true) {
    await writeJsonAtomic(path.join(rootDir, WILDARRANGE_CONFIG_FILE), config);
    await appendLedger(rootDir, { type: "project_governance_configured", configPath: WILDARRANGE_CONFIG_FILE });
  }
  return { config, applied: options.apply === true, configPath: WILDARRANGE_CONFIG_FILE };
}

