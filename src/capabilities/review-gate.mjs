// =============================================================================
// 文件名称：review-gate.mjs
// 所属模块：capabilities
// 作用说明：
//   聚合确定性 review lane（职责审计、项目审查、review/standards 命令、
//   注释检查、契约治理、LLM review 等），产出 review_gate evidence。
//   worker/verify/scope/successCriteria 只作为证据收集，其裁决由 acceptance-proof 唯一负责。
//
// 【运行原理速读】
//   · 何时执行？verify 与 scope 通过后，acceptance proof 之前。
//   · 做了什么？review/standards 命令 → 注释检查 → 独立审计 → 构建 lanes
//     → 可选 LLM review → buildReviewFindingBundle。
//   · 缺了它会怎样？任务可绕过多维复核直接声称完成。
// =============================================================================

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { runProjectReview } from "./project-review.mjs";
import { runResponsibilityAudit } from "./responsibility-audit.mjs";
import { runContractGovernanceReview } from "./contract-governance.mjs";
import {
  DEFAULT_REVIEW_AGENTS,
  normalizeAgentKey,
} from "../infra/agent-registry.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { nowIso } from "../infra/runtime-store.mjs";
import { compileCommandSafetyPatterns } from "../infra/command-safety.mjs";
import { runCommand } from "../infra/command-runner.mjs";
import { runLlmReview } from "../infra/llm-provider.mjs";
import { buildReviewFindingBundle } from "../infra/review-findings.mjs";
import { scanProjectRules } from "../infra/rule-scanner.mjs";
import { criteriaStatus } from "../infra/success-criteria.mjs";
import { isTrivialCommand } from "../infra/task-predicates.mjs";
import { uniqueStrings } from "../infra/text-utils.mjs";
import { normalizeRelativePath, pathMatchesPattern } from "../infra/path-match.mjs";
import { extractComments } from "../infra/repository-layout.mjs";

/**
 * 运行完整 review gate，返回 kind=review_gate 的多 lane 结果。
 * @param {string} rootDir 项目根
 * @param {object} task 任务对象
 * @param {object} [evidence] 已有 worker/verify/scope 等 evidence
 * @param {object} [options] executionRoot 覆盖工作目录
 */
export async function runReviewGate(rootDir, task, evidence = {}, options = {}) {
  const executionRoot = options.executionRoot || rootDir;
  const { config } = await loadWildArrangeConfig(rootDir);
  const workerResult = evidence.workerResult || [...task.evidence].reverse().find((entry) => entry.kind === "worker");
  const verifyResult = evidence.verifyResult || task.last_verify_result || [...task.evidence].reverse().find((entry) => entry.kind === "verifier");
  const scopeResult = evidence.scopeResult || task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
  const criteria = criteriaStatus(task);
  const rulesContext = await scanProjectRules(executionRoot, {
    targetPaths: uniqueStrings([...(task.writable_paths || []), ...((scopeResult?.changedPaths) || [])]),
    projectRoot: rootDir,
  });
  const extraPatterns = compileCommandSafetyPatterns(config);
  const reviewCommandResults = [];
  const standardsCommandResults = [];
  const contractGovernance = evidence.contractGovernance || await runContractGovernanceReview(options.executionRoot || rootDir, task, evidence, { projectRoot: rootDir });

  for (const command of task.review_commands || []) {
    // §3.4：echo/node --version 等空转命令跳过，不得作为独立 review 证据。
    if (isTrivialCommand(command)) {
      reviewCommandResults.push({ command, exitCode: null, skipped: true, reason: "trivial_review_command" });
      continue;
    }
    const result = await runCommand(command, executionRoot, 120_000, { extraPatterns });
    reviewCommandResults.push({ command, ...result });
    if (result.exitCode !== 0) break;
  }

  const commandRecovery = reviewCommandResults.find(requiresCommandRecovery);
  // §3.4：review 命令需 recovery 时不再跑 standards/注释检查，避免并行残留进程。
  if (commandRecovery) return recoveryRequiredReview(commandRecovery, reviewCommandResults, standardsCommandResults, criteria);

  for (const command of task.standards_commands || []) {
    if (isTrivialCommand(command)) {
      standardsCommandResults.push({ command, exitCode: null, skipped: true, reason: "trivial_standards_command" });
      continue;
    }
    const result = await runCommand(command, executionRoot, 120_000, { extraPatterns });
    standardsCommandResults.push({ command, ...result });
    if (result.exitCode !== 0) break;
  }

  const standardsRecovery = standardsCommandResults.find(requiresCommandRecovery);
  if (standardsRecovery) return recoveryRequiredReview(standardsRecovery, reviewCommandResults, standardsCommandResults, criteria);

  const commentResult = await runCommentCheckerGate(executionRoot, task, scopeResult, config);
  const qualityResults = { kind: "quality_gates", at: nowIso(), pass: commentResult.pass, commentResult };

  const responsibilityAudit = await runResponsibilityAudit(rootDir, task, scopeResult, config, executionRoot);
  if (responsibilityAudit.commandRecovery) return recoveryRequiredReview(responsibilityAudit.commandRecovery, reviewCommandResults, standardsCommandResults, criteria, qualityResults);
  const projectReview = await runProjectReview(rootDir, task, scopeResult, config, executionRoot);
  if (projectReview.commandRecovery) return recoveryRequiredReview(projectReview.commandRecovery, reviewCommandResults, standardsCommandResults, criteria, qualityResults);
  const lanes = [
    ...(projectReview.error ? [reviewLane("project_review", "BaiZe", false, { summary: projectReview.error, fixBy: "修复项目审查配置、依据或执行器后重跑。" })] : []),
    ...projectReview.steps.map(step => reviewLane(`project_review_${step.id}`, "BaiZe", step.decision === "PASS", {
      statusOverride: !step.required && step.decision !== "PASS" ? "warn" : undefined,
      summary: step.summary + (step.findings.length ? "\n" + step.findings.map(f => `${f.file}:${f.line} ${f.reason}; evidence=${f.text}; fix=${f.requiredFix}`).join("\n") : ""),
      fixBy: "按照本项项目规范和证据整改，不得删除必需审查项。",
    })),
    reviewLane("responsibility_audit", "BaiZe", responsibilityAudit.pass, {
      statusOverride: responsibilityAudit.legacy ? "warn" : undefined,
      summary: responsibilityAudit.summary,
      fixBy: "按 R1-R5、代码位置和证据整改后重新审计；职责方案改变须先确认。缺少审计执行器时配置独立审查者。",
    }),
    reviewLane("contract_governance", "LuWu", contractGovernance.status === "pass", {
      statusOverride: contractGovernance.status === "warn" ? "warn" : undefined,
      summary: contractGovernance.summary,
      fixBy: "运行 contracts scan，补齐 task.contractChanges，并由开发者审核差异卡后重试。",
    }),
    reviewLane("project_rules_context", "BaiZe", rulesContext.matched > 0, {
      statusOverride: rulesContext.matched > 0 ? undefined : "warn",
      summary: rulesContext.matched > 0
        ? `${rulesContext.matched}/${rulesContext.total} project rule(s) injected from ${rulesContext.reportMdPath}`
        : "no project rules matched; review relies on prompt pack and commands",
      fixBy: "补充 CLAUDE.md/AGENTS.md/.cursor/rules/.github/instructions，或确认本任务无需项目规则。",
    }),
    reviewLane("explicit_review_commands", "BaiZe", reviewCommandResults.length > 0 && reviewCommandResults.every((result) => result.exitCode === 0 && result.skipped !== true), {
      statusOverride: reviewCommandResults.length === 0 ? "warn" : undefined,
      summary: reviewCommandResults.length === 0
        ? "no review_commands configured; deterministic review lanes only"
        : reviewCommandResults.every((result) => result.exitCode === 0 && result.skipped !== true)
          ? `${reviewCommandResults.length} review command(s) passed`
          : commandObservation(reviewCommandResults.find((result) => result.exitCode !== 0) || { exitCode: 1 }),
      fixBy: "按 review_commands 的失败输出修复，不要删除 review_commands 绕过复核。",
    }),
    reviewLane("project_standards", "BaiZe", standardsCommandResults.length > 0 && standardsCommandResults.every((result) => result.exitCode === 0 && result.skipped !== true), {
      statusOverride: standardsCommandResults.length === 0 ? "warn" : undefined,
      summary: standardsCommandResults.length === 0
        ? "no standards_commands configured; relying on project instructions and explicit review lanes"
        : standardsCommandResults.every((result) => result.exitCode === 0 && result.skipped !== true)
          ? `${standardsCommandResults.length} standards command(s) passed`
          : commandObservation(standardsCommandResults.find((result) => result.exitCode !== 0) || { exitCode: 1 }),
      fixBy: "按 standards_commands 的失败输出修复项目规范问题，不要删除规范门来制造 PASS。",
    }),
    reviewLane("comment_checker", "BaiZe", qualityResults.commentResult.pass === true, {
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
    : ["BaiZe"];
  const llmReviews = [];
  if (config.review?.llm?.enabled === true) {
    for (const rawAgentName of llmAgents) {
      const agentName = normalizeAgentKey(rawAgentName);
      if (!agentName) continue;
      const llmReview = await runLlmReview(executionRoot, agentName, task, {
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
    contractGovernance,
    responsibilityAudit,
    projectReview,
  };
}

/** 命令结果是否标记 recoveryRequired 或 terminationFailed。 */
function requiresCommandRecovery(result) {
  return result?.recoveryRequired === true || result?.terminationFailed === true;
}

/** 构造 pass=false 的 review_gate，仅含 command_termination lane 与 recovery 证据。 */
function recoveryRequiredReview(commandEvidence, reviewCommandResults, standardsCommandResults, criteria, qualityResults = null) {
  return {
    kind: "review_gate",
    at: nowIso(),
    pass: false,
    reviewerAgents: DEFAULT_REVIEW_AGENTS,
    lanes: [reviewLane("command_termination", "BaiZe", false, {
      summary: `command process could not be confirmed stopped${commandEvidence.pid ? ` (pid ${commandEvidence.pid})` : ""}`,
      fixBy: "确认残留进程终止后，用同一 run 恢复复核。",
    })],
    qualityResults,
    llmReviews: [],
    findings: [],
    testingGaps: [],
    residualRisks: [],
    reviewCommandResults,
    standardsCommandResults,
    successCriteria: criteria,
    commandRecovery: commandEvidence,
  };
}

/** 构建单条 review lane；statusOverride 用于 warn/skipped 等非 fail 告警。 */
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

/** 压缩命令 stdout/stderr 供 lane summary 展示。 */
function commandObservation(result) {
  return `exit=${result.exitCode}; stdout=${truncateForSummary(result.stdout || "", 180)}; stderr=${truncateForSummary(result.stderr || "", 180)}`;
}

/** 截断过长字符串并追加 [truncated] 标记。 */
function truncateForSummary(value, limit = 500) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 15)}...[truncated]`;
}

// --- 注释检查门 ---

/**
 * 扫描变更/可写路径中的注释，匹配禁用模式与 repository 策略规则。
 * @param {string} rootDir 项目根
 * @param {object} task writable_paths 等
 * @param {object|null} [scopeResult] changedPaths 候选
 * @param {object} [config] qualityGates.commentChecker 与 repositoryGovernance
 * @returns {Promise<object>} kind=comment_checker，blockOnFindings 时 findings 导致 fail
 */
async function runCommentCheckerGate(rootDir, task, scopeResult = null, config = {}) {
  const gateConfig = config.qualityGates?.commentChecker || {};
  if (gateConfig.enabled === false) {
    return {
      kind: "comment_checker",
      at: nowIso(),
      status: "skipped",
      pass: true,
      checkedPaths: [],
      findings: [],
      reason: "qualityGates.commentChecker.enabled is false",
    };
  }

  const candidatePaths = commentCandidatePaths(task, scopeResult);
  const findings = [];
  const checkedPaths = [];
  for (const filePath of candidatePaths) {
    const absolutePath = path.join(rootDir, filePath);
    if (!pathInsideRoot(rootDir, absolutePath) || !isLikelyTextPath(filePath) || !existsSync(absolutePath)) continue;
    let content = "";
    try {
      const fileStat = await stat(absolutePath);
      if (fileStat.size > (gateConfig.maxFileBytes || 500_000)) continue;
      content = await readFile(absolutePath, "utf8");
    } catch {
      continue;
    }
    checkedPaths.push(normalizeRelativePath(filePath));
    const policyRules = (config.repositoryGovernance?.commentRules || [])
      .filter((rule) => (rule.globs || []).some((glob) => pathMatchesPattern(filePath, glob)));
    const configuredPatterns = Array.isArray(gateConfig.patterns) && gateConfig.patterns.length > 0
      ? gateConfig.patterns
      : defaultCommentPatternDefinitions();
    const patterns = commentPatterns([
      ...configuredPatterns,
      ...policyRules.flatMap((rule) => (rule.blockedPatterns || []).map((pattern) => ({
        name: `repository_policy:${pattern}`,
        pattern,
      }))),
    ]);
    const comments = extractComments(filePath, content);
    comments.forEach((comment) => {
      for (const pattern of patterns) {
        if (!pattern.regex.test(comment.text)) continue;
        findings.push({
          file: normalizeRelativePath(filePath),
          line: comment.line,
          pattern: pattern.name,
          text: comment.text.trim().slice(0, 240),
        });
      }
    });
    for (const rule of policyRules) {
      for (const requiredPattern of rule.requiredPatterns || []) {
        const regex = commentPatterns([{ name: `required:${requiredPattern}`, pattern: requiredPattern }])[0]?.regex;
        if (regex && !comments.some((comment) => regex.test(comment.text))) {
          findings.push({
            file: normalizeRelativePath(filePath),
            line: 1,
            pattern: `required:${requiredPattern}`,
            text: "required comment pattern is missing",
          });
        }
      }
    }
  }

  const blockOnFindings = gateConfig.blockOnFindings === true;
  // §3.4：blockOnFindings=false 时仅 warn，不阻断 review gate 整体 pass。
  const status = findings.length === 0 ? "pass" : blockOnFindings ? "fail" : "warn";
  return {
    kind: "comment_checker",
    at: nowIso(),
    status,
    pass: status !== "fail",
    checkedPaths,
    findings,
  };
}

// --- 注释候选与模式 ---

/** 合并 scope 变更路径与 task.writable_paths（排除 glob）作为注释扫描候选。 */
function commentCandidatePaths(task, scopeResult) {
  const paths = [];
  if (Array.isArray(scopeResult?.changedPaths)) paths.push(...scopeResult.changedPaths);
  if (Array.isArray(task.writable_paths)) paths.push(...task.writable_paths.filter((item) => !item.includes("*")));
  return [...new Set(paths.map(normalizeRelativePath))];
}

/** 将字符串或 { name, pattern, flags? } 转为带 regex 的模式对象。 */
function commentPatterns(rawPatterns) {
  const source = Array.isArray(rawPatterns) && rawPatterns.length > 0 ? rawPatterns : defaultCommentPatternDefinitions();
  return source
    .map((item) => {
      if (typeof item === "string") return { name: item, regex: new RegExp(item, normalizeRegexFlags()) };
      if (!item || typeof item.pattern !== "string") return null;
      return { name: item.name || item.pattern, regex: new RegExp(item.pattern, normalizeRegexFlags(item.flags)) };
    })
    .filter(Boolean);
}

/** 未配置 patterns 时的默认禁用注释模式（AI 署名、占位符、lorem）。 */
function defaultCommentPatternDefinitions() {
  return [
    { name: "ai_attribution", pattern: "\\b(as an ai|generated by ai|ai generated|chatgpt|claude generated)\\b" },
    { name: "placeholder_comment", pattern: "\\b(todo|fixme|hack|xxx)\\b" },
    { name: "lorem_ipsum", pattern: "lorem ipsum" },
  ];
}

/** 过滤非法 regex flags 并强制 case-insensitive。 */
function normalizeRegexFlags(rawFlags = "") {
  const allowed = new Set(["d", "i", "m", "s", "u"]);
  const flags = new Set(String(rawFlags).split("").filter((flag) => allowed.has(flag)));
  flags.add("i");
  return [...flags].sort().join("");
}

// --- 路径工具 ---

/** 按扩展名判断是否像可扫描的文本源文件。 */
function isLikelyTextPath(filePath) {
  return /\.(cjs|css|html|js|json|jsx|md|mjs|py|rb|rs|sh|ts|tsx|txt|vue|yaml|yml)$/i.test(filePath);
}

/** 绝对路径解析后是否仍在项目根内（防 .. 与绝对路径逃逸）。 */
function pathInsideRoot(rootDir, absolutePath) {
  const relative = path.relative(rootDir, absolutePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
