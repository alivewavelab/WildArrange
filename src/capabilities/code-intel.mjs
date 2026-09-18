// =============================================================================
// 文件名称：code-intel.mjs
// 所属模块：capabilities
// 作用说明：
//   实现 review gate 内的静态质量门：LSP/AST 命令、hashline 锚点校验、
//   注释策略检查。被 review-gate 与 acceptance-proof 的独立 review 判定引用。
//
// 【运行原理速读】
//   · 何时执行？runReviewGate 在 review/standards 命令之后串行调用。
//   · 做了什么？runQualityGates 编排四门；任一命令需进程恢复则短路返回。
//   · 缺了它会怎样？类型/结构/锚点/注释类回归无法被确定性 gate 捕获。
// =============================================================================

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  hashContent,
  nowIso,
} from "../infra/runtime-store.mjs";
import { runCommand } from "../infra/command-runner.mjs";
import { normalizeRelativePath, pathMatchesPattern } from "../infra/path-match.mjs";
import { extractComments } from "../infra/repository-layout.mjs";

// --- 质量门编排 ---

/**
 * 顺序运行 LSP、AST、hashline、comment 四门，汇总 pass。
 * @param {string} rootDir 项目根
 * @param {object} task 任务（可含 lsp_commands 等覆盖）
 * @param {object|null} [scopeResult] 用于 comment 候选路径
 * @param {object} [config] qualityGates 与 repositoryGovernance 配置
 */
export async function runQualityGates(rootDir, task, scopeResult = null, config = {}) {
  const lspResult = await runLspDiagnosticsGate(rootDir, task, config);
  if (commandGateNeedsRecovery(lspResult)) return interruptedQualityGates(lspResult, "lspResult");
  const astResult = await runAstStructureGate(rootDir, task, config);
  if (commandGateNeedsRecovery(astResult)) return interruptedQualityGates(astResult, "astResult", { lspResult });
  const hashlineResult = await runHashlineAnchorsGate(rootDir, task, config);
  const commentResult = await runCommentCheckerGate(rootDir, task, scopeResult, config);
  return {
    kind: "quality_gates",
    at: nowIso(),
    pass: lspResult.pass && astResult.pass && hashlineResult.pass && commentResult.pass,
    lspResult,
    astResult,
    hashlineResult,
    commentResult,
  };
}

// --- LSP / AST 命令门 ---

/**
 * 运行 LSP/类型检查命令门；未启用且无 task 命令时 skipped。
 * @param {string} rootDir 项目根
 * @param {object} task 可含 lsp_commands 覆盖
 * @param {object} [config] qualityGates.lspDiagnostics
 * @returns {Promise<object>} kind=lsp_diagnostics，含 status 与 results
 */
export async function runLspDiagnosticsGate(rootDir, task, config = {}) {
  const gateConfig = config.qualityGates?.lspDiagnostics || {};
  const commands = [
    ...(Array.isArray(gateConfig.commands) ? gateConfig.commands : []),
    ...(Array.isArray(task.lsp_commands) ? task.lsp_commands : []),
  ].filter((command) => typeof command === "string" && command.trim().length > 0);

  if (gateConfig.enabled !== true && commands.length === 0) {
    return skippedGate("lsp_diagnostics", "qualityGates.lspDiagnostics.enabled is not true and no lsp_commands are configured");
  }
  if (commands.length === 0) {
    return missingCommandsGate("lsp_diagnostics", gateConfig.required === true, "lsp diagnostics gate enabled but no commands are configured");
  }
  return runCommandGate(rootDir, "lsp_diagnostics", commands, gateConfig.timeoutMs || 120_000);
}

/**
 * 运行 AST/结构搜索命令门；未启用且无 task 命令时 skipped。
 * @param {string} rootDir 项目根
 * @param {object} task 可含 ast_commands 覆盖
 * @param {object} [config] qualityGates.astStructure
 * @returns {Promise<object>} kind=ast_structure，含 status 与 results
 */
export async function runAstStructureGate(rootDir, task, config = {}) {
  const gateConfig = config.qualityGates?.astStructure || {};
  const commands = [
    ...(Array.isArray(gateConfig.commands) ? gateConfig.commands : []),
    ...(Array.isArray(task.ast_commands) ? task.ast_commands : []),
  ].filter((command) => typeof command === "string" && command.trim().length > 0);

  if (gateConfig.enabled !== true && commands.length === 0) {
    return skippedGate("ast_structure", "qualityGates.astStructure.enabled is not true and no ast_commands are configured");
  }
  if (commands.length === 0) {
    return missingCommandsGate("ast_structure", gateConfig.required === true, "ast structure gate enabled but no commands are configured");
  }
  return runCommandGate(rootDir, "ast_structure", commands, gateConfig.timeoutMs || 120_000);
}

// --- Hashline 锚点门 ---

/**
 * 校验配置的 hashline 锚点：文件存在、行内容 SHA256 与声明一致。
 * @param {string} rootDir 项目根
 * @param {object} task 可含 hashline_anchors/hashline_refs
 * @param {object} [config] qualityGates.hashlineAnchors
 * @returns {Promise<object>} kind=hashline_anchors，含 anchors 与 findings
 */
export async function runHashlineAnchorsGate(rootDir, task, config = {}) {
  const gateConfig = config.qualityGates?.hashlineAnchors || {};
  const anchors = normalizeHashlineAnchors([
    ...(Array.isArray(gateConfig.anchors) ? gateConfig.anchors : []),
    ...(Array.isArray(task.hashline_anchors) ? task.hashline_anchors : []),
    ...(Array.isArray(task.hashline_refs) ? task.hashline_refs : []),
  ]);

  if (gateConfig.enabled !== true && anchors.length === 0) {
    return {
      kind: "hashline_anchors",
      at: nowIso(),
      status: "skipped",
      pass: true,
      anchors: [],
      findings: [],
      reason: "qualityGates.hashlineAnchors.enabled is not true and no task hashline anchors are configured",
    };
  }
  if (anchors.length === 0) {
    const status = gateConfig.required === true ? "fail" : "warn";
    return {
      kind: "hashline_anchors",
      at: nowIso(),
      status,
      pass: status !== "fail",
      anchors: [],
      findings: [],
      reason: "hashline anchors gate enabled but no anchors are configured",
    };
  }

  const findings = [];
  for (const anchor of anchors) {
    const absolutePath = path.join(rootDir, anchor.file);
    if (!pathInsideRoot(rootDir, absolutePath) || !existsSync(absolutePath)) {
      findings.push({ ...anchor, reason: "file missing or outside project root" });
      continue;
    }
    let lines = [];
    try {
      lines = (await readFile(absolutePath, "utf8")).split(/\r?\n/);
    } catch (error) {
      findings.push({ ...anchor, reason: `read failed: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const actualLine = lines[anchor.line - 1] ?? "";
    const actualSha256 = hashLine(actualLine);
    const expectedSha256 = anchor.sha256 || (typeof anchor.content === "string" ? hashLine(anchor.content) : "");
    if (!expectedSha256 || actualSha256 !== expectedSha256) {
      findings.push({
        ...anchor,
        expectedSha256,
        actualSha256,
        actualText: actualLine.trim().slice(0, 240),
        reason: expectedSha256 ? "hashline anchor mismatch" : "anchor missing sha256/content",
      });
    }
  }

  const status = findings.length === 0 ? "pass" : "fail";
  return {
    kind: "hashline_anchors",
    at: nowIso(),
    status,
    pass: status === "pass",
    anchors,
    findings,
  };
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
export async function runCommentCheckerGate(rootDir, task, scopeResult = null, config = {}) {
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

// --- 进程恢复与中断 ---

/** 命令门结果是否含需进程恢复或终止未确认的条目。 */
function commandGateNeedsRecovery(result) {
  return (result?.results || []).some((entry) => entry?.recoveryRequired === true || entry?.terminationFailed === true);
}

/** 前序命令门需 recovery 时，后续质量门统一标为 not_run 并返回 pass=false。 */
function interruptedQualityGates(commandResult, resultName, completed = {}) {
  const interrupted = {
    kind: "quality_gate_not_run",
    at: nowIso(),
    status: "skipped",
    pass: false,
    results: [],
    reason: "an earlier quality command requires process recovery",
  };
  return {
    kind: "quality_gates",
    at: nowIso(),
    pass: false,
    ...completed,
    lspResult: resultName === "lspResult" ? commandResult : completed.lspResult,
    astResult: resultName === "astResult" ? commandResult : interrupted,
    hashlineResult: interrupted,
    commentResult: { ...interrupted, checkedPaths: [], findings: [] },
    commandRecovery: (commandResult.results || []).find((entry) => entry?.recoveryRequired === true || entry?.terminationFailed === true),
  };
}

// --- 命令执行与门状态 ---

/** 对单行文本 trimEnd 后计算 content hash，供 hashline 比对。 */
export function hashLine(content) {
  return hashContent(String(content ?? "").trimEnd());
}

/** 顺序执行命令列表，首条非零 exitCode 即短路。 */
async function runCommandGate(rootDir, kind, commands, timeoutMs) {
  const results = [];
  for (const command of commands) {
    const result = await runCommand(command, rootDir, timeoutMs);
    results.push({ command, ...result });
    // §3.4：与 verifier 一致，首败即停，避免后续命令掩盖根因。
    if (result.exitCode !== 0) break;
  }
  const pass = results.every((result) => result.exitCode === 0);
  return {
    kind,
    at: nowIso(),
    status: pass ? "pass" : "fail",
    pass,
    results,
  };
}

/** 门未启用且无 task 覆盖命令时的 skipped 结果（pass=true）。 */
function skippedGate(kind, reason) {
  return { kind, at: nowIso(), status: "skipped", pass: true, results: [], reason };
}

/** 门已启用但无命令：required 时 fail，否则 warn。 */
function missingCommandsGate(kind, required, reason) {
  const status = required ? "fail" : "warn";
  return { kind, at: nowIso(), status, pass: status !== "fail", results: [], reason };
}

// --- Hashline 规范化 ---

/** 将 task/config 中的 hashline 锚点规范化为 { file, line, sha256, content? }。 */
function normalizeHashlineAnchors(anchors) {
  return anchors
    .map((anchor) => {
      if (!anchor || typeof anchor !== "object") return null;
      const file = normalizeRelativePath(String(anchor.file || anchor.path || ""));
      const line = Number(anchor.line);
      if (!file || !Number.isInteger(line) || line < 1) return null;
      const sha256 = typeof anchor.sha256 === "string" && anchor.sha256.trim() ? anchor.sha256.trim() : "";
      return {
        file,
        line,
        sha256,
        content: typeof anchor.content === "string" ? anchor.content : undefined,
        note: typeof anchor.note === "string" ? anchor.note : undefined,
      };
    })
    .filter(Boolean);
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
