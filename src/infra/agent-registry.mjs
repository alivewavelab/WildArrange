export const DEFAULT_LEAD_AGENT = "Jiuwei";
export const DEFAULT_EXECUTOR_AGENT = "Jiuwei";
export const DEFAULT_REVIEW_AGENTS = ["BaiZe"];
export const LONG_LIVED_AGENTS = Object.freeze(["Jiuwei", "DiJiang", "ZhuRong", "BaiZe", "LuWu"]);
export const COMMAND_WORKER_AGENTS = Object.freeze(["Jiuwei", "ZhuRong"]);
export const READ_ONLY_LONG_LIVED_AGENTS = Object.freeze(["DiJiang", "BaiZe", "LuWu"]);
const READ_ONLY_LONG_LIVED_AGENT_SET = new Set(READ_ONLY_LONG_LIVED_AGENTS);
// 旧版宿主配置里的历史 Agent 名，映射到当前长期 Agent 白名单。
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
export function normalizeAgentKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const sanitized = trimmed.replace(/[^\w.-]/g, "_");
  return AGENT_ALIASES[sanitized] || AGENT_ALIASES[trimmed] || sanitized;
}

export function assertCommandWorkerAgent(value) {
  const normalized = normalizeAgentKey(value);
  if (!normalized) throw new Error("command worker agent is required");
  if (READ_ONLY_LONG_LIVED_AGENT_SET.has(normalized)) {
    throw new Error(`agent ${normalized} is read-only and cannot enter a command worker`);
  }
  return normalized;
}
