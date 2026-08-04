export const DEFAULT_LEAD_AGENT = "Jiuwei";
export const DEFAULT_EXECUTOR_AGENT = "Jiuwei";
export const DEFAULT_REVIEW_AGENTS = ["BaiZe"];
export const LONG_LIVED_AGENTS = Object.freeze(["Jiuwei", "DiJiang", "ZhuRong", "BaiZe", "LuWu"]);
export const COMMAND_WORKER_AGENTS = Object.freeze(["Jiuwei", "ZhuRong"]);
export const READ_ONLY_LONG_LIVED_AGENTS = Object.freeze(["DiJiang", "BaiZe", "LuWu"]);
const LONG_LIVED_AGENT_SET = new Set(LONG_LIVED_AGENTS);
const READ_ONLY_LONG_LIVED_AGENT_SET = new Set(READ_ONLY_LONG_LIVED_AGENTS);
const legacyAgentName = (...parts) => parts.join("");
export const AGENT_ALIASES = {
  [legacyAgentName("Sisy", "phus")]: "Jiuwei",
  [legacyAgentName("Sisy", "phus", "-junior")]: "LuWu",
  [legacyAgentName("sisy", "phus_junior")]: "LuWu",
  [legacyAgentName("At", "las")]: "Jiuwei",
  [legacyAgentName("Hephae", "stus")]: "ZhuRong",
  [legacyAgentName("Prome", "theus")]: "DiJiang",
  [legacyAgentName("Ora", "cle")]: "BaiZe",
  [legacyAgentName("Libra", "rian")]: "BaiZe",
  [legacyAgentName("Exp", "lore")]: "BaiZe",
  [legacyAgentName("Me", "tis")]: "BaiZe",
  [legacyAgentName("Mo", "mus")]: "BaiZe",
  YingLong: "Jiuwei",
  LuanNiao: "BaiZe",
  QiongQi: "BaiZe",
  Kui: "BaiZe",
  Taotie: "BaiZe",
};
export const AGENT_DISPLAY_NAMES = {
  Jiuwei: "九尾狐 / Nine-Tailed Fox",
  ZhuRong: "祝融 / Zhu Rong",
  DiJiang: "帝江 / Di Jiang",
  BaiZe: "白泽 / Bai Ze",
  LuWu: "陆吾 / Lu Wu",
};

export function normalizeAgentKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const sanitized = trimmed.replace(/[^\w.-]/g, "_");
  return AGENT_ALIASES[sanitized] || AGENT_ALIASES[trimmed] || sanitized;
}

export function isLongLivedAgent(value) {
  const normalized = normalizeAgentKey(value);
  return normalized ? LONG_LIVED_AGENT_SET.has(normalized) : false;
}

export function assertCommandWorkerAgent(value) {
  const normalized = normalizeAgentKey(value);
  if (!normalized) throw new Error("command worker agent is required");
  if (READ_ONLY_LONG_LIVED_AGENT_SET.has(normalized)) {
    throw new Error(`agent ${normalized} is read-only and cannot enter a command worker`);
  }
  return normalized;
}

export function displayAgentName(value) {
  const key = normalizeAgentKey(value);
  if (!key) return "";
  return AGENT_DISPLAY_NAMES[key] || key;
}
