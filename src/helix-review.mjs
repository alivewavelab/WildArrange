import { DEFAULT_REVIEW_AGENTS, loadHelixConfig, normalizeAgentKey, nowIso } from "./helix-foundation.mjs";
import { runCommand, runQualityGates } from "./helix-gates.mjs";
import { runLlmReview } from "./helix-llm.mjs";
import { buildReviewFindingBundle } from "./helix-review-findings.mjs";
import { scanProjectRules } from "./helix-rules.mjs";
import { criteriaStatus } from "./helix-team.mjs";

export async function runWorker(rootDir, task, options = {}) {
  const command = options.workerCommand || task.worker_command;
  if (!command) {
    return {
      kind: "worker",
      at: nowIso(),
      command: null,
      exitCode: 0,
      stdout: "No worker_command configured; treating implementation as externally completed.",
      stderr: "",
    };
  }
  const result = await runCommand(command, rootDir, options.timeoutMs);
  return { kind: "worker", at: nowIso(), command, ...result };
}

export async function runReviewGate(rootDir, task, evidence = {}) {
  const { config } = await loadHelixConfig(rootDir);
  const workerResult = evidence.workerResult || [...task.evidence].reverse().find((entry) => entry.kind === "worker");
  const verifyResult = evidence.verifyResult || task.last_verify_result || [...task.evidence].reverse().find((entry) => entry.kind === "verifier");
  const scopeResult = evidence.scopeResult || task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
  const workerEvidenceOk = workerEvidenceComplete(workerResult);
  const verifierEvidenceOk = verifierEvidenceComplete(task, verifyResult);
  const evidenceIntegrity = reviewEvidenceIntegrity(task, { workerResult, verifyResult });
  const criteria = criteriaStatus(task);
  const rulesContext = await scanProjectRules(rootDir, {
    targetPaths: uniqueStrings([...(task.writable_paths || []), ...((scopeResult?.changedPaths) || [])]),
  });
  const reviewCommandResults = [];
  const standardsCommandResults = [];

  for (const command of task.review_commands || []) {
    const result = await runCommand(command, rootDir);
    reviewCommandResults.push({ command, ...result });
    if (result.exitCode !== 0) break;
  }

  for (const command of task.standards_commands || []) {
    const result = await runCommand(command, rootDir);
    standardsCommandResults.push({ command, ...result });
    if (result.exitCode !== 0) break;
  }

  const qualityResults = await runQualityGates(rootDir, task, scopeResult, config);

  const lanes = [
    reviewLane("evidence_integrity", "BaiZe", evidenceIntegrity.pass, {
      summary: evidenceIntegrity.pass
        ? "worker and verifier evidence objects are present and internally complete"
        : `missing or incomplete evidence: ${evidenceIntegrity.reasons.join("; ")}`,
      fixBy: "重新运行 execute/verify，确保 workerResult 与 verifyResult 都写入 task evidence。",
    }),
    reviewLane("goal_compliance", "BaiZe", workerEvidenceOk && verifierEvidenceOk && workerResult.exitCode === 0 && verifyResult.pass === true, {
      summary: workerEvidenceOk && verifierEvidenceOk && workerResult.exitCode === 0 && verifyResult.pass === true
        ? "worker completed and verifier passed against task acceptance commands"
        : "worker or verifier evidence does not prove the task goal",
      fixBy: "修复实现或验收失败后，重新运行 execute/verify。",
    }),
    reviewLane("scope_fidelity", "QiongQi", scopeResult?.status === "pass", {
      statusOverride: scopeResult?.status === "inconclusive" && (task.writable_paths || []).length === 0 ? "warn" : undefined,
      summary: scopeResult?.status === "fail"
        ? `out-of-scope paths: ${(scopeResult.deniedPaths || []).join(", ") || "unknown"}`
        : scopeResult?.status === "inconclusive"
          ? `scope guard inconclusive: ${scopeResult.reason || "no changed-path evidence"}`
          : "changed paths stay within writable_paths",
      fixBy: "移除范围外改动，或走 ChangeRequest 扩展任务边界。",
    }),
    reviewLane("evidence_quality", "LuanNiao", verifierEvidenceOk, {
      summary: verifierEvidenceOk
        ? "all verifier commands produced passing evidence"
        : "verifier evidence is missing, partial, or failing",
      fixBy: "补齐并运行覆盖真实行为的 verify_commands。",
    }),
    reviewLane("success_criteria", "BaiZe", criteria.pass, {
      summary: criteria.pass
        ? `${criteria.passed}/${criteria.total} success criteria passed`
        : `criteria not satisfied: pass=${criteria.passed}, pending=${criteria.pending}, fail=${criteria.failed}`,
      fixBy: "补齐 criterion evidence，或修复实现后重新运行 verifier；不要删除 successCriteria。",
    }),
    reviewLane("project_rules_context", "QiongQi", rulesContext.matched > 0, {
      statusOverride: rulesContext.matched > 0 ? undefined : "warn",
      summary: rulesContext.matched > 0
        ? `${rulesContext.matched}/${rulesContext.total} project rule(s) injected from ${rulesContext.reportMdPath}`
        : "no project rules matched; review relies on prompt pack and commands",
      fixBy: "补充 CLAUDE.md/AGENTS.md/.cursor/rules/.github/instructions，或确认本任务无需项目规则。",
    }),
    reviewLane("explicit_review_commands", "BaiZe", reviewCommandResults.every((result) => result.exitCode === 0), {
      statusOverride: reviewCommandResults.length === 0 ? "warn" : undefined,
      summary: reviewCommandResults.length === 0
        ? "no review_commands configured; deterministic review lanes only"
        : reviewCommandResults.every((result) => result.exitCode === 0)
          ? `${reviewCommandResults.length} review command(s) passed`
          : commandObservation(reviewCommandResults.find((result) => result.exitCode !== 0) || { exitCode: 1 }),
      fixBy: "按 review_commands 的失败输出修复，不要删除 review_commands 绕过复核。",
    }),
    reviewLane("project_standards", "QiongQi", standardsCommandResults.every((result) => result.exitCode === 0), {
      statusOverride: standardsCommandResults.length === 0 ? "warn" : undefined,
      summary: standardsCommandResults.length === 0
        ? "no standards_commands configured; relying on project instructions and explicit review lanes"
        : standardsCommandResults.every((result) => result.exitCode === 0)
          ? `${standardsCommandResults.length} standards command(s) passed`
          : commandObservation(standardsCommandResults.find((result) => result.exitCode !== 0) || { exitCode: 1 }),
      fixBy: "按 standards_commands 的失败输出修复项目规范问题，不要删除规范门来制造 PASS。",
    }),
    reviewLane("lsp_diagnostics", "LuanNiao", qualityResults.lspResult.pass === true, {
      statusOverride: qualityResults.lspResult.status === "skipped" ? "warn" : undefined,
      summary: qualityResults.lspResult.status === "skipped"
        ? qualityResults.lspResult.reason
        : qualityResults.lspResult.pass
          ? `${qualityResults.lspResult.results.length} LSP/typecheck command(s) passed`
          : commandObservation(qualityResults.lspResult.results.find((result) => result.exitCode !== 0) || { exitCode: 1 }),
      fixBy: "修复 LSP/typecheck 诊断，或在 helix.config.json 中明确关闭该 gate。",
    }),
    reviewLane("comment_checker", "LuanNiao", qualityResults.commentResult.pass === true, {
      statusOverride: qualityResults.commentResult.status === "warn" || qualityResults.commentResult.status === "skipped" ? "warn" : undefined,
      summary: qualityResults.commentResult.findings.length === 0
        ? "no blocked comment/placeholder findings"
        : `${qualityResults.commentResult.findings.length} comment finding(s): ${qualityResults.commentResult.findings.slice(0, 3).map((finding) => `${finding.file}:${finding.line} ${finding.pattern}`).join("; ")}`,
      fixBy: "清理占位注释、AI 署名、TODO/FIXME，或把 commentChecker.blockOnFindings 设为 false 仅告警。",
    }),
  ];

  const deterministicReview = {
    pass: lanes.every((lane) => lane.status !== "fail"),
    lanes,
  };
  const llmAgents = Array.isArray(config.review?.llm?.agents) && config.review.llm.agents.length > 0
    ? config.review.llm.agents
    : ["QiongQi"];
  const llmReviews = [];
  if (config.review?.llm?.enabled === true) {
    for (const rawAgentName of llmAgents) {
      const agentName = normalizeAgentKey(rawAgentName);
      if (!agentName) continue;
      const llmReview = await runLlmReview(rootDir, agentName, task, {
        workerResult,
        verifyResult,
        scopeResult,
        deterministicReview,
        qualityResults,
      }, { config });
      llmReviews.push(llmReview);
      lanes.push(reviewLane(`llm_${agentName}`, agentName, llmReview.pass === true, {
        statusOverride: llmReview.status === "warn" || llmReview.status === "skipped" ? "warn" : undefined,
        summary: llmReview.summary || llmReview.reason || `${agentName} LLM review ${llmReview.status}`,
        fixBy: "按 LLM review findings 修复；如果 provider 不可用，配置 API key/baseUrl/model 或关闭 required。",
      }));
    }
  }
  const findingBundle = buildReviewFindingBundle({ lanes, qualityResults, llmReviews });

  return {
    kind: "review_gate",
    at: nowIso(),
    pass: lanes.every((lane) => lane.status !== "fail"),
    reviewerAgents: DEFAULT_REVIEW_AGENTS,
    lanes,
    qualityResults,
    llmReviews,
    findings: findingBundle.findings,
    testingGaps: findingBundle.testingGaps,
    residualRisks: findingBundle.residualRisks,
    reviewCommandResults,
    standardsCommandResults,
    successCriteria: criteria,
    rulesContextPath: rulesContext.reportMdPath,
  };
}

function reviewLane(name, agent, condition, options) {
  const status = options.statusOverride || (condition ? "pass" : "fail");
  return {
    name,
    agent,
    status,
    summary: options.summary,
    fixBy: options.fixBy,
  };
}

function reviewEvidenceIntegrity(task, evidence) {
  const reasons = [];
  if (!workerEvidenceComplete(evidence.workerResult)) reasons.push("workerResult missing kind/exitCode");
  if (!verifierEvidenceComplete(task, evidence.verifyResult)) reasons.push("verifyResult missing, failing, or not aligned with verify_commands");
  return { pass: reasons.length === 0, reasons };
}

function workerEvidenceComplete(workerResult) {
  return workerResult?.kind === "worker" && Number.isInteger(workerResult.exitCode);
}

function verifierEvidenceComplete(task, verifyResult) {
  if (!verifyResult || verifyResult.kind !== "verifier") return false;
  if (verifyResult.pass !== true) return false;
  return Array.isArray(verifyResult.results) && verifyResult.results.length > 0 && verifyResult.results.length === task.verify_commands.length;
}

function commandObservation(result) {
  return `exit=${result.exitCode}; stdout=${truncateForSummary(result.stdout || "", 180)}; stderr=${truncateForSummary(result.stderr || "", 180)}`;
}

function truncateForSummary(value, limit = 500) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 15)}...[truncated]`;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}
