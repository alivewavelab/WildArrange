// =============================================================================
// 文件名称：archivist-router.mjs
// 所属模块：ai
// 作用说明：
//   档案员（CangJie）路由：构建结论包、LLM 路由/记忆决策、关键词演进建议与持久化。
//   只摄入清洗后的结论文本，不含代码块/raw diff；LLM 不可用时 fallback 到确定性路由。
//
// 【运行原理速读】
//   · 何时触发？ SessionStart/UserPromptSubmit/PostCompact 等 Hook（经 evaluateArchivistTrigger）。
//   · 做了什么？ ① buildArchivistPacket ② LLM 或 fallbackArchivistDecision
//     ③ 写 stage-summaries、memory events、pending 路由建议 ④ 人工 accept/reject 关键词。
//   · 与谁协作？ routing.mjs（fallback）、llm-provider、ledger、runtime-snapshot。
// =============================================================================

import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import {
  createWorkId,
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { readGitHead } from "../infra/git-diff.mjs";
import { callOpenAICompatible, resolveAgentProvider } from "../infra/llm-provider.mjs";
import { routeRequest } from "./routing.mjs";

/** 档案员路由与记忆窗口的默认 stage 键，对应 config 中未显式配置时的回退值。 */
const DEFAULT_STAGE = "default";

// --- 路由包构建与执行 ---

/**
 * 构建档案员 LLM 输入包：结论文本、近期轮次、ledger 尾、阶段摘要与 memory 索引。
 * @param {string} rootDir 项目根目录
 * @param {object} options stage、turns、text、ledgerLimit、maxRecentTurns
 * @returns {Promise<object>} kind=archivist_routing_packet（可能被截断）
 */
export async function buildArchivistPacket(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const { config } = await loadWildArrangeConfig(rootDir);
  const archivistConfig = config.archivistRouter || {};
  const memoryConfig = archivistConfig.memory || {};
  const stage = normalizeStage(options.stage || DEFAULT_STAGE);
  const maxRecentTurns = resolveTurnWindow(memoryConfig, stage, options.maxRecentTurns);
  const turns = normalizeTurns(options.turns || []);
  const selectedTurns = turns.slice(-maxRecentTurns).map(cleanTurn);
  const text = cleanConclusionText(options.text || "");
  const ledgerTail = await readLedgerTail(rootDir, Number(options.ledgerLimit) || 30);
  const stageSummaries = await readStageSummaries(rootDir, stage, 5);
  const memoryIndex = await readJson(resolveWildArrangePath(rootDir, "memory", "index.json"), { keywords: {}, artifacts: [], preferences: [] });
  const packet = {
    kind: "archivist_routing_packet",
    at: nowIso(),
    stage,
    trigger: options.trigger || "manual",
    captureMode: memoryConfig.captureMode || "conclusions-only",
    includeCodeBlocks: memoryConfig.includeCodeBlocks === true,
    input: text,
    turns: selectedTurns,
    ledgerTail: ledgerTail.map(summarizeLedgerEvent),
    stageSummaries,
    memoryIndex,
    requestedOutputs: [
      "routeDecision",
      "multiIntentSegments",
      "memoryUpdates",
      "contextInjection",
      "keywordSuggestions",
    ],
  };
  return truncatePacket(packet, Number(memoryConfig.maxRoutingPacketChars) || 12000);
}

/**
 * 执行完整档案员路由：触发评估 → LLM/fallback → 持久化决策与记忆更新。
 * @param {string} rootDir 项目根目录
 * @param {object} options stage、trigger、text、turns、force、agent
 * @returns {Promise<object>} kind=archivist_router_result 或 skipped 结果
 */
export async function runArchivistRouter(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const { config } = await loadWildArrangeConfig(rootDir);
  const archivistConfig = config.archivistRouter || {};
  // §3.4：未启用且非 force 时跳过，保证无 LLM 配置时 Hook 仍可 fail-open 继续。
  if (archivistConfig.enabled !== true && options.force !== true) {
    const result = {
      kind: "archivist_router",
      at: nowIso(),
      status: "skipped",
      pass: true,
      reason: "archivistRouter.enabled is not true",
    };
    await appendLedger(rootDir, { type: "archivist_router_skipped", reason: result.reason });
    return result;
  }

  const trigger = await evaluateArchivistTrigger(rootDir, archivistConfig, options);
  if (!trigger.shouldRun && options.force !== true) {
    const result = {
      kind: "archivist_router",
      at: nowIso(),
      status: "skipped",
      pass: true,
      reason: trigger.reason,
      trigger,
    };
    await appendLedger(rootDir, { type: "archivist_router_skipped", reason: result.reason, trigger: options.trigger || "manual" });
    return result;
  }

  const packet = await buildArchivistPacket(rootDir, options);
  const agentName = options.agent || archivistConfig.agent || "CangJie";
  const resolved = resolveAgentProvider(config, agentName);
  let decision;
  let llmStatus = "skipped";
  if (resolved.available) {
    try {
      const response = await callOpenAICompatible({
        ...resolved,
        messages: [
          {
            role: "system",
            content: "You are CangJie, an archivist and task router. Return only compact JSON.",
          },
          {
            role: "user",
            content: buildArchivistPrompt(packet),
          },
        ],
        temperature: 0,
        timeoutMs: Number(archivistConfig.timeoutMs) || 45_000,
      });
      decision = parseArchivistJson(response.content);
      decision.usage = response.usage || null;
      llmStatus = "called";
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // §3.4：LLM 调用失败时降级确定性 fallback，不阻断 Hook 主流程。
      decision = await fallbackArchivistDecision(rootDir, packet, reason);
      llmStatus = "fallback";
    }
  } else {
    // §3.4：无可用 provider/key 时直接走 routing.mjs 确定性路由，保持 fail-open。
    decision = await fallbackArchivistDecision(rootDir, packet, resolved.reason);
    llmStatus = "fallback";
  }

  const artifact = await persistArchivistDecision(rootDir, {
    agentName,
    packet,
    decision,
    llmStatus,
    trigger,
  });
  await appendLedger(rootDir, {
    type: "archivist_router_completed",
    agent: agentName,
    status: llmStatus,
    route: decision.routeDecision?.route || null,
    confidence: decision.routeDecision?.confidence ?? null,
    triggerReason: trigger.reason,
  });
  await writeSnapshot(rootDir, "archivist_router_completed", artifact);
  return artifact;
}

// --- 记忆事件与建议管理 ---

/**
 * 追加一条记忆事件到 memory/events.jsonl 并更新 memory/index.json。
 * @param {string} rootDir 项目根目录
 * @param {object} event 事件字段（kind、stage、tags 等）
 * @returns {Promise<object>} 规范化后的事件
 */
export async function recordArchivistEvent(rootDir, event) {
  await ensureWildArrangeDirs(rootDir);
  const normalized = {
    id: event.id || createWorkId("mem"),
    at: event.at || nowIso(),
    kind: event.kind || "memory_event",
    stage: normalizeStage(event.stage || DEFAULT_STAGE),
    ...event,
  };
  await appendFile(resolveWildArrangePath(rootDir, "memory", "events.jsonl"), `${JSON.stringify(normalized)}\n`, "utf8");
  await updateMemoryIndex(rootDir, normalized);
  return normalized;
}

/**
 * 列出 routing/suggestions 下全部档案员关键词演进建议（按时间降序）。
 * @param {string} rootDir 项目根目录
 * @returns {Promise<object[]>} 建议对象数组
 */
export async function listArchivistRouteSuggestions(rootDir) {
  await ensureWildArrangeDirs(rootDir);
  const dirPath = resolveWildArrangePath(rootDir, "routing", "suggestions");
  const entries = [];
  for (const name of await readdir(dirPath).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const suggestion = await readJson(path.join(dirPath, name), null);
    if (suggestion) entries.push(suggestion);
  }
  return entries.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
}

/**
 * 人工 accept/reject 档案员路由关键词建议；accept 时写入 routes-overrides.json。
 * @param {string} rootDir 项目根目录
 * @param {object} options id、decision（accept|reject）、evidence、rationale、reviewer
 * @returns {Promise<object>} 更新后的建议 artifact
 */
export async function resolveArchivistRouteSuggestion(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  if (!options.id) throw new Error("archivist suggestion resolve requires id");
  const decision = String(options.decision || "").toLowerCase();
  if (!["accept", "reject"].includes(decision)) throw new Error("archivist suggestion decision must be accept or reject");

  const suggestionPath = resolveWildArrangePath(rootDir, "routing", "suggestions", `${options.id}.json`);
  const artifact = await readJson(suggestionPath, null);
  if (!artifact) throw new Error(`archivist route suggestion not found: ${options.id}`);
  if (artifact.status !== "pending_review") throw new Error(`archivist route suggestion ${options.id} is ${artifact.status}`);

  artifact.status = decision === "accept" ? "accepted" : "rejected";
  artifact.resolvedAt = nowIso();
  artifact.resolution = {
    decision,
    evidence: asString(options.evidence),
    rationale: asString(options.rationale),
    reviewer: asString(options.reviewer || "Jiuwei"),
  };

  let applied = [];
  if (decision === "accept") {
    applied = await applyKeywordSuggestions(rootDir, artifact.suggestions || [], {
      evidence: artifact.resolution.evidence,
      rationale: artifact.resolution.rationale,
    });
    artifact.applied = applied;
  }

  await writeJsonAtomic(suggestionPath, artifact);
  await appendLedger(rootDir, {
    type: "archivist_route_suggestion_resolved",
    suggestionId: options.id,
    decision,
    appliedCount: applied.length,
  });
  await writeSnapshot(rootDir, "archivist_route_suggestion_resolved", {
    suggestionId: options.id,
    decision,
    appliedCount: applied.length,
  });
  return artifact;
}

// --- 决策持久化与 Fallback ---

/** 将档案员决策写入 stage-summaries、memory events、关键词建议与 last-archivist-result。 */
async function persistArchivistDecision(rootDir, payload) {
  const id = createWorkId("archive");
  const stage = payload.packet.stage;
  const at = nowIso();
  const artifact = {
    kind: "archivist_router_result",
    id,
    at,
    agent: payload.agentName,
    llmStatus: payload.llmStatus,
    trigger: payload.trigger || null,
    packet: payload.packet,
    decision: normalizeDecision(payload.decision),
  };

  await writeJsonAtomic(resolveWildArrangePath(rootDir, "memory", "stage-summaries", `${at.replace(/[:.]/g, "-")}-${stage}.json`), {
    id,
    at,
    stage,
    summary: artifact.decision.summary || "",
    progress: artifact.decision.contextInjection?.progress || [],
    decisions: artifact.decision.contextInjection?.decisions || [],
    artifacts: artifact.decision.contextInjection?.artifacts || [],
    pitfalls: artifact.decision.contextInjection?.pitfalls || [],
    openQuestions: artifact.decision.contextInjection?.openQuestions || [],
  });

  for (const event of artifact.decision.memoryUpdates || []) {
    await recordArchivistEvent(rootDir, {
      ...event,
      source: "archivist_router",
      stage,
    });
  }

  if (artifact.decision.keywordSuggestions?.length > 0) {
    await writeJsonAtomic(resolveWildArrangePath(rootDir, "routing", "suggestions", `${id}.json`), {
      id,
      at,
      status: "pending_review",
      suggestions: normalizeKeywordSuggestions(artifact.decision.keywordSuggestions),
      routeDecision: artifact.decision.routeDecision || null,
    });
  }

  await writeJsonAtomic(resolveWildArrangePath(rootDir, "memory", "last-archivist-result.json"), artifact);
  return artifact;
}

/** 组装 CangJie LLM 用户消息：约束 JSON 输出结构与 keywordSuggestions 字段格式。 */
function buildArchivistPrompt(packet) {
  return JSON.stringify({
    instruction: [
      "Read the routing packet. It contains conclusions only; code blocks and raw diffs should be absent.",
      "Identify route, agent lane, multi-intent segments, memory updates, context injection facts, and keyword suggestions.",
      "Do not suggest changes to protected routes unless evidence is strong.",
      "Return JSON with keys: summary, routeDecision, multiIntentSegments, memoryUpdates, contextInjection, keywordSuggestions.",
      "keywordSuggestions items must use {target:\"intents.plan|domains.visual|complexity.multi_step\", signals:[\"...\"], evidence:\"...\", confidence:0.0-1.0}.",
    ],
    packet,
  }, null, 2);
}

/** LLM 不可用时的确定性降级：走 routeRequest 并写入 fallback 记忆与 ledger 进展摘要。 */
async function fallbackArchivistDecision(rootDir, packet, reason) {
  let routeDecision = null;
  if (packet.input) {
    try {
      const route = await routeRequest(rootDir, { text: packet.input });
      routeDecision = { ...route, confidence: 0.55, source: "deterministic_fallback" };
    } catch {
      routeDecision = null;
    }
  }
  return {
    summary: packet.input ? packet.input.slice(0, 240) : "No input text provided.",
    routeDecision,
    multiIntentSegments: [],
    memoryUpdates: [{
      kind: "archivist_fallback",
      summary: packet.input ? packet.input.slice(0, 500) : reason,
      tags: ["fallback", packet.stage],
    }],
    contextInjection: {
      progress: extractLedgerProgress(packet.ledgerTail),
      decisions: [],
      artifacts: [],
      implementationNotes: [],
      researchNotes: [],
      pitfalls: reason ? [`LLM unavailable: ${reason}`] : [],
      openQuestions: [],
    },
    keywordSuggestions: [],
  };
}

/** 裁剪并规范化 LLM/fallback 决策字段，防止超长数组污染持久化。 */
function normalizeDecision(decision) {
  const contextInjection = decision.contextInjection && typeof decision.contextInjection === "object" ? decision.contextInjection : {};
  return {
    summary: asString(decision.summary),
    routeDecision: decision.routeDecision && typeof decision.routeDecision === "object" ? decision.routeDecision : null,
    multiIntentSegments: Array.isArray(decision.multiIntentSegments) ? decision.multiIntentSegments.slice(0, 20) : [],
    memoryUpdates: Array.isArray(decision.memoryUpdates) ? decision.memoryUpdates.slice(0, 50) : [],
    contextInjection: {
      progress: normalizeStringList(contextInjection.progress),
      decisions: normalizeStringList(contextInjection.decisions),
      artifacts: normalizeStringList(contextInjection.artifacts),
      implementationNotes: normalizeStringList(contextInjection.implementationNotes),
      researchNotes: normalizeStringList(contextInjection.researchNotes),
      pitfalls: normalizeStringList(contextInjection.pitfalls),
      openQuestions: normalizeStringList(contextInjection.openQuestions),
    },
    keywordSuggestions: Array.isArray(decision.keywordSuggestions) ? decision.keywordSuggestions.slice(0, 50) : [],
    usage: decision.usage || null,
  };
}

// --- 触发器与关键词演进 ---

/** 评估本次是否应运行档案员：会话/压缩/工作流/git 头变更/用户 prompt 窗口等触发器。 */
async function evaluateArchivistTrigger(rootDir, archivistConfig, options) {
  const triggerName = options.trigger || "manual";
  const statePath = resolveWildArrangePath(rootDir, "routing", "archivist-trigger-state.json");
  const state = await readJson(statePath, {
    version: 1,
    promptCounts: {},
    totalUserPrompts: 0,
    lastGitHead: null,
    lastRunAt: null,
  });
  const triggers = archivistConfig.triggers || {};
  const stage = normalizeStage(options.stage || DEFAULT_STAGE);
  const gitHeadProbe = triggers.gitHeadChanged ? await readGitHead(rootDir) : null;
  const gitHead = gitHeadProbe?.available ? gitHeadProbe.sha || null : null;
  const gitChanged = Boolean(gitHead && state.lastGitHead && gitHead !== state.lastGitHead);
  const firstRun = !state.lastRunAt;
  let shouldRun = false;
  let reason = "no trigger threshold reached";

  if (options.force === true) {
    shouldRun = true;
    reason = "force";
  } else if (triggerName === "sessionStart" && triggers.sessionStart !== false) {
    shouldRun = true;
    reason = "sessionStart";
  } else if (triggerName === "postCompact") {
    shouldRun = true;
    reason = "postCompact";
  } else if (triggerName === "workflowCheckpoint" && triggers.workflowCheckpoint !== false) {
    shouldRun = true;
    reason = "workflowCheckpoint";
  // git 头变更视为工作区上下文漂移，触发档案员重新路由
  } else if (gitChanged) {
    shouldRun = true;
    reason = "gitHeadChanged";
  } else if (triggerName === "userPromptSubmit") {
    const threshold = promptThresholdForStage(triggers.everyUserPrompts || {}, stage);
    const currentCount = Number(state.promptCounts[stage] || 0) + 1;
    state.promptCounts[stage] = currentCount;
    state.totalUserPrompts = Number(state.totalUserPrompts || 0) + 1;
    if (firstRun || currentCount >= threshold) {
      shouldRun = true;
      reason = firstRun ? "firstUserPrompt" : `promptWindow:${stage}:${currentCount}/${threshold}`;
      // 达到窗口阈值后清零，避免每轮 prompt 都触发档案员
      state.promptCounts[stage] = 0;
    }
  } else if (triggerName === "manual" || triggerName === "cli") {
    shouldRun = true;
    reason = triggerName;
  }

  if (gitHead) state.lastGitHead = gitHead;
  if (shouldRun) state.lastRunAt = nowIso();
  state.updatedAt = nowIso();
  await writeJsonAtomic(statePath, state);
  return {
    shouldRun,
    reason,
    trigger: triggerName,
    stage,
    gitHead,
    gitChanged,
    promptCounts: state.promptCounts,
  };
}

/** 按阶段读取 prompt 计数阈值，并 clamp 到配置的 min/max 区间。 */
function promptThresholdForStage(config, stage) {
  const min = Number(config.min || 5);
  const max = Number(config.max || 20);
  const selected = Number(config[stage] || config.default || 10);
  return Math.max(min, Math.min(selected, max));
}

/** 人工 accept 后将关键词建议合并进 routes-overrides.json，受保护路由需证据与理由。 */
async function applyKeywordSuggestions(rootDir, suggestions, resolution) {
  const { config } = await loadWildArrangeConfig(rootDir);
  const protectedTargets = new Set(config.archivistRouter?.keywordEvolution?.protectedTargets || []);
  const normalized = normalizeKeywordSuggestions(suggestions);
  const accepted = [];
  for (const suggestion of normalized) {
    // 受保护路由不允许无证据自动演进，防止 LLM 建议污染核心意图表
    if (protectedTargets.has(suggestion.target) && (!resolution.evidence || !resolution.rationale)) {
      throw new Error(`protected route suggestion ${suggestion.target} requires evidence and rationale`);
    }
    accepted.push(suggestion);
  }

  const overlayPath = resolveWildArrangePath(rootDir, "routing", "routes-overrides.json");
  const overlay = await readJson(overlayPath, { version: 1, patches: [] });
  const existingKeys = new Set((overlay.patches || []).map((patch) => `${patch.target}:${(patch.signals || []).join("|")}`));
  for (const suggestion of accepted) {
    const key = `${suggestion.target}:${suggestion.signals.join("|")}`;
    // 同一 target+signals 组合不重复写入 overlay
    if (existingKeys.has(key)) continue;
    overlay.patches.push({
      target: suggestion.target,
      signals: suggestion.signals,
      evidence: suggestion.evidence,
      confidence: suggestion.confidence,
      source: "archivist_router",
      appliedAt: nowIso(),
    });
  }
  overlay.updatedAt = nowIso();
  await writeJsonAtomic(overlayPath, overlay);
  return accepted;
}

/** 校验 keywordSuggestions 的 target 命名空间与 signals 非空，丢弃非法项。 */
function normalizeKeywordSuggestions(suggestions) {
  if (!Array.isArray(suggestions)) return [];
  return suggestions
    .map((suggestion) => {
      if (!suggestion || typeof suggestion !== "object") return null;
      const target = asString(suggestion.target).trim();
      const signals = normalizeStringList(suggestion.signals || suggestion.keywords);
      if (!/^(intents|domains|complexity)\.[A-Za-z0-9_-]+$/.test(target) || signals.length === 0) return null;
      return {
        target,
        signals,
        evidence: asString(suggestion.evidence || suggestion.reason),
        confidence: normalizeConfidence(suggestion.confidence),
      };
    })
    .filter(Boolean)
    .slice(0, 50);
}

/** 将置信度解析为 [0,1] 有限数，非法输入返回 null。 */
function normalizeConfidence(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, parsed));
}

/** 解析档案员 LLM 回复；纯 JSON 失败时尝试从文本中提取首个 JSON 对象。 */
function parseArchivistJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    // 模型偶发包裹说明文字，回退到贪婪 JSON 块提取
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { summary: content };
    try {
      return JSON.parse(match[0]);
    } catch {
      return { summary: content };
    }
  }
}

// --- 记忆索引与包清洗 ---

/** 根据记忆事件累加 keywords 计数并去重 artifacts/preferences。 */
async function updateMemoryIndex(rootDir, event) {
  const indexPath = resolveWildArrangePath(rootDir, "memory", "index.json");
  const index = await readJson(indexPath, { keywords: {}, artifacts: [], preferences: [] });
  for (const tag of normalizeStringList(event.tags)) {
    index.keywords[tag] = (index.keywords[tag] || 0) + 1;
  }
  for (const artifact of normalizeStringList(event.artifacts)) {
    if (!index.artifacts.includes(artifact)) index.artifacts.push(artifact);
  }
  if (event.preference && !index.preferences.includes(event.preference)) {
    index.preferences.push(event.preference);
  }
  index.updatedAt = nowIso();
  await writeJsonAtomic(indexPath, index);
}

/** 读取 ledger.jsonl 尾部若干行；文件不存在时返回空数组。 */
async function readLedgerTail(rootDir, limit) {
  try {
    const content = await readFile(resolveWildArrangePath(rootDir, "ledger.jsonl"), "utf8");
    return content.trim().split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/** 读取同 stage 的近期阶段摘要，不足 limit 时用其他 stage 摘要填充。 */
async function readStageSummaries(rootDir, stage, limit) {
  const dirPath = resolveWildArrangePath(rootDir, "memory", "stage-summaries");
  try {
    const names = (await readdir(dirPath)).filter((name) => name.endsWith(".json")).sort().reverse();
    const summaries = [];
    for (const name of names) {
      const summary = await readJson(path.join(dirPath, name), null);
      if (!summary) continue;
      if (summary.stage === stage || summaries.length < limit) summaries.push(summary);
      if (summaries.length >= limit) break;
    }
    return summaries;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/** 将 ledger 事件压缩为路由包可携带的轻量字段子集。 */
function summarizeLedgerEvent(event) {
  return {
    at: event.at,
    type: event.type,
    planId: event.planId,
    taskId: event.taskId,
    status: event.status || event.nextStatus || null,
    route: event.route || null,
    summary: event.summary || event.reason || null,
  };
}

/** 规范化对话轮次：统一 role 并清洗 content 中的代码块与 diff 行。 */
function cleanTurn(turn) {
  return {
    role: asString(turn.role || "unknown"),
    content: cleanConclusionText(turn.content || turn.summary || ""),
  };
}

/** 档案员只摄入结论文本：剥离 fenced code 与 unified diff 行，避免 raw diff 进入 LLM。 */
function cleanConclusionText(value) {
  return asString(value)
    .replace(/```[\s\S]*?```/g, "[code block removed]")
    .split(/\r?\n/)
    // 过滤 diff 头与 hunk 标记，防止代码变更原文进入记忆
    .filter((line) => !/^\s*([+\-]{3}|@@|\+|-|diff --git|index [a-f0-9]+\.\.)/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 路由包超字符预算时按比例裁剪 turns/ledger/summaries，并标记 truncated。 */
function truncatePacket(packet, maxChars) {
  const raw = JSON.stringify(packet);
  if (raw.length <= maxChars) return packet;
  return {
    ...packet,
    truncated: true,
    turns: packet.turns.slice(-Math.max(1, Math.floor(packet.turns.length / 2))),
    ledgerTail: packet.ledgerTail.slice(-10),
    stageSummaries: packet.stageSummaries.slice(0, 2),
  };
}

/** 解析近期对话窗口大小：显式 override 优先，否则按 stage 配置并 clamp 上限。 */
function resolveTurnWindow(memoryConfig, stage, override) {
  if (Number.isInteger(Number(override))) return Number(override);
  const windows = memoryConfig.recentTurnWindows || {};
  const selected = Number(windows[stage] || windows.default || memoryConfig.maxRecentTurns || 10);
  const max = Number(windows.max || 20);
  return Math.max(1, Math.min(selected, max));
}

/** 过滤非法 turn 对象，保留可用于路由包的对话轮次。 */
function normalizeTurns(turns) {
  return Array.isArray(turns) ? turns.filter((turn) => turn && typeof turn === "object") : [];
}

/** 将任意数组规范为去空白、去空串的字符串列表并截断至 50 条。 */
function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(asString).map((item) => item.trim()).filter(Boolean).slice(0, 50);
}

/** 从 ledger 尾事件提取最近任务进展摘要行，供 fallback contextInjection。 */
function extractLedgerProgress(events) {
  return events
    .filter((event) => event.type && (event.taskId || event.status))
    .slice(-8)
    .map((event) => `${event.type}${event.taskId ? ` ${event.taskId}` : ""}${event.status ? ` ${event.status}` : ""}`);
}

/** 规范化 stage 名称，空值回退到 default。 */
function normalizeStage(value) {
  const stage = asString(value).trim();
  return stage || DEFAULT_STAGE;
}

/** 将值安全转为字符串；非 string 返回空串。 */
function asString(value) {
  return typeof value === "string" ? value : "";
}
