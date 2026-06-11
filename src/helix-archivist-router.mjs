import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  appendLedger,
  createWorkId,
  ensureHelixDirs,
  loadHelixConfig,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
  writeSnapshot,
} from "./helix-foundation.mjs";
import { callOpenAICompatible, resolveAgentProvider } from "./helix-llm.mjs";
import { routeRequest } from "./helix-routing.mjs";

const DEFAULT_STAGE = "default";

export async function buildArchivistPacket(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const { config } = await loadHelixConfig(rootDir);
  const archivistConfig = config.archivistRouter || {};
  const memoryConfig = archivistConfig.memory || {};
  const stage = normalizeStage(options.stage || DEFAULT_STAGE);
  const maxRecentTurns = resolveTurnWindow(memoryConfig, stage, options.maxRecentTurns);
  const turns = normalizeTurns(options.turns || []);
  const selectedTurns = turns.slice(-maxRecentTurns).map(cleanTurn);
  const text = cleanConclusionText(options.text || "");
  const ledgerTail = await readLedgerTail(rootDir, Number(options.ledgerLimit) || 30);
  const stageSummaries = await readStageSummaries(rootDir, stage, 5);
  const memoryIndex = await readJson(resolveHelixPath(rootDir, "memory", "index.json"), { keywords: {}, artifacts: [], preferences: [] });
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

export async function runArchivistRouter(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const { config } = await loadHelixConfig(rootDir);
  const archivistConfig = config.archivistRouter || {};
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

  const packet = await buildArchivistPacket(rootDir, options);
  const agentName = options.agent || archivistConfig.agent || "CangJie";
  const resolved = resolveAgentProvider(config, agentName);
  let decision;
  let llmStatus = "skipped";
  if (resolved.available) {
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
  } else {
    decision = await fallbackArchivistDecision(rootDir, packet, resolved.reason);
    llmStatus = "fallback";
  }

  const artifact = await persistArchivistDecision(rootDir, {
    agentName,
    packet,
    decision,
    llmStatus,
  });
  await appendLedger(rootDir, {
    type: "archivist_router_completed",
    agent: agentName,
    status: llmStatus,
    route: decision.routeDecision?.route || null,
    confidence: decision.routeDecision?.confidence ?? null,
  });
  await writeSnapshot(rootDir, "archivist_router_completed", artifact);
  return artifact;
}

export async function recordArchivistEvent(rootDir, event) {
  await ensureHelixDirs(rootDir);
  const normalized = {
    id: event.id || createWorkId("mem"),
    at: event.at || nowIso(),
    kind: event.kind || "memory_event",
    stage: normalizeStage(event.stage || DEFAULT_STAGE),
    ...event,
  };
  await appendFile(resolveHelixPath(rootDir, "memory", "events.jsonl"), `${JSON.stringify(normalized)}\n`, "utf8");
  await updateMemoryIndex(rootDir, normalized);
  return normalized;
}

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
    packet: payload.packet,
    decision: normalizeDecision(payload.decision),
  };

  await writeJsonAtomic(resolveHelixPath(rootDir, "memory", "stage-summaries", `${at.replace(/[:.]/g, "-")}-${stage}.json`), {
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
    await writeJsonAtomic(resolveHelixPath(rootDir, "routing", "suggestions", `${id}.json`), {
      id,
      at,
      status: "pending_review",
      suggestions: artifact.decision.keywordSuggestions,
      routeDecision: artifact.decision.routeDecision || null,
    });
  }

  await writeJsonAtomic(resolveHelixPath(rootDir, "memory", "last-archivist-result.json"), artifact);
  return artifact;
}

function buildArchivistPrompt(packet) {
  return JSON.stringify({
    instruction: [
      "Read the routing packet. It contains conclusions only; code blocks and raw diffs should be absent.",
      "Identify route, agent lane, multi-intent segments, memory updates, context injection facts, and keyword suggestions.",
      "Do not suggest changes to protected routes unless evidence is strong.",
      "Return JSON with keys: summary, routeDecision, multiIntentSegments, memoryUpdates, contextInjection, keywordSuggestions.",
    ],
    packet,
  }, null, 2);
}

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

function parseArchivistJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { summary: content };
    try {
      return JSON.parse(match[0]);
    } catch {
      return { summary: content };
    }
  }
}

async function updateMemoryIndex(rootDir, event) {
  const indexPath = resolveHelixPath(rootDir, "memory", "index.json");
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

async function readLedgerTail(rootDir, limit) {
  try {
    const content = await readFile(resolveHelixPath(rootDir, "ledger.jsonl"), "utf8");
    return content.trim().split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readStageSummaries(rootDir, stage, limit) {
  const dirPath = resolveHelixPath(rootDir, "memory", "stage-summaries");
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

function cleanTurn(turn) {
  return {
    role: asString(turn.role || "unknown"),
    content: cleanConclusionText(turn.content || turn.summary || ""),
  };
}

function cleanConclusionText(value) {
  return asString(value)
    .replace(/```[\s\S]*?```/g, "[code block removed]")
    .split(/\r?\n/)
    .filter((line) => !/^\s*([+\-]{3}|@@|\+|-|diff --git|index [a-f0-9]+\.\.)/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

function resolveTurnWindow(memoryConfig, stage, override) {
  if (Number.isInteger(Number(override))) return Number(override);
  const windows = memoryConfig.recentTurnWindows || {};
  const selected = Number(windows[stage] || windows.default || memoryConfig.maxRecentTurns || 10);
  const max = Number(windows.max || 20);
  return Math.max(1, Math.min(selected, max));
}

function normalizeTurns(turns) {
  return Array.isArray(turns) ? turns.filter((turn) => turn && typeof turn === "object") : [];
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(asString).map((item) => item.trim()).filter(Boolean).slice(0, 50);
}

function extractLedgerProgress(events) {
  return events
    .filter((event) => event.type && (event.taskId || event.status))
    .slice(-8)
    .map((event) => `${event.type}${event.taskId ? ` ${event.taskId}` : ""}${event.status ? ` ${event.status}` : ""}`);
}

function normalizeStage(value) {
  const stage = asString(value).trim();
  return stage || DEFAULT_STAGE;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}
