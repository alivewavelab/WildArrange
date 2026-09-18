// =============================================================================
// 文件名称：agent-registry.mjs
// 所属模块：infra
// 作用说明：
//   WildArrange Agent 名称白名单、默认角色与历史别名映射的权威来源。
//   负责规范化 Agent 标识并校验哪些 Agent 可作为命令 worker 执行。
//
// 【运行原理速读】
//   可以把它想成「Agent 身份证登记处」：
//
//   · 何时执行？
//     任务分配、并行 spawn、LLM 路由解析 Agent 名时调用 normalizeAgentKey。
//
//   · 它做了什么？
//     ① 别名映射到当前白名单名 ② 校验 worker 非只读 Agent ③ 暴露默认主/审/执行角色常量。
//
//   · 和其他部分的关系？
//     agent-spawn、prompt-pack、llm-provider 均依赖此处的名称规范。
// =============================================================================

/** 默认主控/编排 Agent 名称。 */
/**
 * DEFAULT_LEAD_AGENT：本模块对外导出常量或符号。
 */
export const DEFAULT_LEAD_AGENT = "Jiuwei";
/** 默认任务执行 Agent 名称。 */
/**
 * DEFAULT_EXECUTOR_AGENT：本模块对外导出常量或符号。
 */
export const DEFAULT_EXECUTOR_AGENT = "Jiuwei";
/** 默认审查 Agent 列表。 */
/**
 * DEFAULT_REVIEW_AGENTS：本模块对外导出常量或符号。
 */
export const DEFAULT_REVIEW_AGENTS = ["BaiZe"];
/** 长期存活、可跨会话复用的 Agent 白名单。 */
/**
 * LONG_LIVED_AGENTS：本模块对外导出常量或符号。
 */
export const LONG_LIVED_AGENTS = Object.freeze(["Jiuwei", "DiJiang", "ZhuRong", "BaiZe", "LuWu"]);
/** 允许进入命令 worker 管道的 Agent 白名单。 */
/**
 * COMMAND_WORKER_AGENTS：本模块对外导出常量或符号。
 */
export const COMMAND_WORKER_AGENTS = Object.freeze(["Jiuwei", "ZhuRong"]);
/** 只读长期 Agent，禁止作为命令 worker。 */
/**
 * READ_ONLY_LONG_LIVED_AGENTS：本模块对外导出常量或符号。
 */
export const READ_ONLY_LONG_LIVED_AGENTS = Object.freeze(["DiJiang", "BaiZe", "LuWu"]);
const READ_ONLY_LONG_LIVED_AGENT_SET = new Set(READ_ONLY_LONG_LIVED_AGENTS);
/** 旧版宿主配置里的历史 Agent 名，映射到当前长期 Agent 白名单。 */
/**
 * AGENT_ALIASES：本模块对外导出常量或符号。
 */
export const AGENT_ALIASES = {
  Sisyphus: "Jiuwei",
  "Sisyphus-junior": "LuWu",
  sisyphus_junior: "LuWu",
  Atlas: "Jiuwei",
  Hephaestus: "ZhuRong",
  Prometheus: "DiJiang",
  Oracle: "BaiZe",
  Librarian: "BaiZe",
  Explore: "BaiZe",
  Metis: "BaiZe",
  Momus: "BaiZe",
  YingLong: "Jiuwei",
  LuanNiao: "BaiZe",
  QiongQi: "BaiZe",
  Kui: "BaiZe",
  Taotie: "BaiZe",
};

/**
 * 规范化 Agent 标识：去空白、消毒字符并应用别名表。
 * @param {unknown} value 原始 Agent 名
 * @returns {string|null} 规范化后的名称，无效输入返回 null
 */
export function normalizeAgentKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const sanitized = trimmed.replace(/[^\w.-]/g, "_");
  return AGENT_ALIASES[sanitized] || AGENT_ALIASES[trimmed] || sanitized;
}

/**
 * 断言给定 Agent 可作为命令 worker；只读 Agent 会抛错。
 * @param {unknown} value 待校验的 Agent 名
 * @returns {string} 规范化后的 worker Agent 名
 */
export function assertCommandWorkerAgent(value) {
  const normalized = normalizeAgentKey(value);
  if (!normalized) throw new Error("command worker agent is required");
  if (READ_ONLY_LONG_LIVED_AGENT_SET.has(normalized)) {
    throw new Error(`agent ${normalized} is read-only and cannot enter a command worker`);
  }
  return normalized;
}
