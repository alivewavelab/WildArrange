import { loadHelixConfig, nowIso } from "./helix-foundation.mjs";

const DEFAULT_CHAT_PATH = "/chat/completions";
const REVIEW_AGENT_PROFILES = {
  BaiZe: {
    lane: "goal_verifier",
    focus: "Judge whether the task objective, success criteria, verifier evidence, and checkpoint evidence prove delivery.",
    failBias: "Fail when the evidence chain is missing, verifier output does not match the task, or the goal is not actually satisfied.",
  },
  LuanNiao: {
    lane: "risk_reviewer",
    focus: "Find concrete bugs, regression risks, missing tests, LSP/typecheck problems, and maintainability risks that affect this task.",
    failBias: "Fail only for reproducible defects, missing required tests, or risks that can break the delivered behavior.",
  },
  QiongQi: {
    lane: "skeptical_acceptance",
    focus: "Act as an adversarial reviewer. Try to disprove the completion claim using scope, verifier, project rules, and user intent.",
    failBias: "Fail when a reasonable skeptical acceptance review would reject the worker's completion claim.",
  },
};

export async function runLlmReview(rootDir, agentName, task, evidence = {}, options = {}) {
  const { config } = options.config ? { config: options.config } : await loadHelixConfig(rootDir);
  const llmConfig = config.review?.llm || {};
  if (llmConfig.enabled !== true) {
    return {
      kind: "llm_review",
      at: nowIso(),
      agent: agentName,
      status: "skipped",
      pass: true,
      reason: "review.llm.enabled is not true",
    };
  }

  const resolved = resolveAgentProvider(config, agentName);
  if (!resolved.available) {
    const status = llmConfig.required === true ? "fail" : "warn";
    return {
      kind: "llm_review",
      at: nowIso(),
      agent: agentName,
      status,
      pass: status !== "fail",
      reason: resolved.reason,
    };
  }

  const prompt = buildReviewPrompt(agentName, task, evidence, llmConfig);
  try {
    const response = await callOpenAICompatible({
      ...resolved,
      messages: [
        {
          role: "system",
          content: buildReviewSystemPrompt(agentName),
        },
        { role: "user", content: prompt },
      ],
      temperature: Number.isFinite(llmConfig.temperature) ? llmConfig.temperature : 0,
      timeoutMs: Number.isInteger(llmConfig.timeoutMs) ? llmConfig.timeoutMs : 45_000,
    });
    const parsed = parseReviewJson(response.content);
    const decision = String(parsed.decision || parsed.status || "").toUpperCase();
    const status = decision === "FAIL" ? "fail" : decision === "WARN" ? "warn" : "pass";
    return {
      kind: "llm_review",
      at: nowIso(),
      agent: agentName,
      provider: resolved.providerName,
      model: resolved.model,
      status,
      pass: status !== "fail",
      decision: decision || "PASS",
      summary: asString(parsed.summary) || response.content.slice(0, 500),
      findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 20) : [],
      usage: response.usage || null,
    };
  } catch (error) {
    const status = llmConfig.required === true ? "fail" : "warn";
    return {
      kind: "llm_review",
      at: nowIso(),
      agent: agentName,
      provider: resolved.providerName,
      model: resolved.model,
      status,
      pass: status !== "fail",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveAgentProvider(config, agentName) {
  const agent = config.agents?.[agentName];
  if (!agent) return { available: false, reason: `agent ${agentName} is not configured` };
  const providerName = agent.provider;
  const provider = config.modelProviders?.[providerName];
  if (!provider) return { available: false, reason: `provider ${providerName || "(missing)"} is not configured` };
  if (provider.type === "host") {
    return {
      available: false,
      reason: `provider ${providerName} is managed by the host adapter; direct CLI LLM review needs an openai-compatible provider`,
      hostManaged: true,
      providerName,
      model: agent.model || provider.defaultModel || "host-default",
    };
  }
  const apiKey = provider.apiKey || (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
  if (!apiKey) return { available: false, reason: `missing API key env ${provider.apiKeyEnv || "(provider.apiKeyEnv)"}` };
  const baseUrl = normalizeBaseUrl(provider.baseUrl || (provider.baseUrlEnv ? process.env[provider.baseUrlEnv] : undefined) || provider.defaultBaseUrl);
  if (!baseUrl) return { available: false, reason: `missing baseUrl or ${provider.baseUrlEnv || "provider.baseUrlEnv"}` };
  const model = agent.model || provider.defaultModel;
  if (!model) return { available: false, reason: `agent ${agentName} has no model` };
  return {
    available: true,
    providerName,
    baseUrl,
    apiKey,
    model,
    reasoning: agent.reasoning,
  };
}

export async function callOpenAICompatible(options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 45_000);
  try {
    const response = await fetch(`${options.baseUrl}${DEFAULT_CHAT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? 0,
      }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`LLM provider returned HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
    }
    const body = JSON.parse(bodyText);
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("LLM provider returned no message content");
    }
    return { content: content.trim(), usage: body.usage || null, raw: body };
  } finally {
    clearTimeout(timer);
  }
}

function buildReviewPrompt(agentName, task, evidence, llmConfig) {
  const maxChars = Number.isInteger(llmConfig.maxEvidenceChars) ? llmConfig.maxEvidenceChars : 12000;
  const profile = REVIEW_AGENT_PROFILES[agentName] || {
    lane: "general_review",
    focus: "Review whether the task can pass delivery.",
    failBias: "Fail only for blocking issues tied to the task goal, verifier, scope, or project rules.",
  };
  const payload = {
    reviewer: agentName,
    lane: profile.lane,
    focus: profile.focus,
    failBias: profile.failBias,
    instruction: [
      "Decide whether this task can pass delivery review.",
      "Return JSON: {\"decision\":\"PASS|WARN|FAIL\",\"summary\":\"...\",\"findings\":[{\"severity\":\"P0|P1|P2\",\"file\":\"optional\",\"reason\":\"...\",\"requiredFix\":\"...\"}]}",
      "FAIL only for issues that should block checkpoint.",
      "Do not fail because a preferred improvement is absent unless it violates the stated goal, verifier, scope, or project rules.",
      "Every FAIL finding must name the violated evidence, scope, verifier, success criterion, or project rule.",
    ],
    task: {
      id: task.id,
      subject: task.subject,
      description: task.description,
      writable_paths: task.writable_paths,
      verify_commands: task.verify_commands,
      review_commands: task.review_commands,
      standards_commands: task.standards_commands,
      successCriteria: task.successCriteria,
    },
    evidence: summarizeEvidence(evidence),
  };
  return truncate(JSON.stringify(payload, null, 2), maxChars);
}

function buildReviewSystemPrompt(agentName) {
  const profile = REVIEW_AGENT_PROFILES[agentName] || REVIEW_AGENT_PROFILES.QiongQi;
  return [
    "You are a strict software delivery reviewer. Return only compact JSON.",
    `Reviewer lane: ${profile.lane}.`,
    `Focus: ${profile.focus}`,
    `Blocking rule: ${profile.failBias}`,
  ].join("\n");
}

function summarizeEvidence(evidence) {
  return {
    workerResult: summarizeCommandResult(evidence.workerResult),
    verifyResult: evidence.verifyResult ? {
      pass: evidence.verifyResult.pass,
      results: (evidence.verifyResult.results || []).map(summarizeCommandResult),
    } : null,
    scopeResult: evidence.scopeResult || null,
    deterministicReview: evidence.deterministicReview ? {
      pass: evidence.deterministicReview.pass,
      lanes: evidence.deterministicReview.lanes,
    } : null,
    qualityResults: evidence.qualityResults || null,
  };
}

function summarizeCommandResult(result) {
  if (!result) return null;
  return {
    command: result.command || null,
    exitCode: result.exitCode,
    pass: result.pass,
    stdout: truncate(result.stdout || "", 1200),
    stderr: truncate(result.stderr || "", 1200),
  };
}

function parseReviewJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { decision: "WARN", summary: content };
    try {
      return JSON.parse(match[0]);
    } catch {
      return { decision: "WARN", summary: content };
    }
  }
}

function normalizeBaseUrl(value) {
  if (!value || typeof value !== "string") return null;
  return value.replace(/\/+$/, "");
}

function truncate(value, limit) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 20)}\n...[truncated]`;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}
