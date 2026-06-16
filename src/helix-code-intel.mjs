import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { hashContent, nowIso } from "./helix-foundation.mjs";
import { runCommand } from "./helix-gates.mjs";

export async function runQualityGates(rootDir, task, scopeResult = null, config = {}) {
  const lspResult = await runLspDiagnosticsGate(rootDir, task, config);
  const astResult = await runAstStructureGate(rootDir, task, config);
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

export async function runCommentCheckerGate(rootDir, task, scopeResult = null, config = {}) {
  const gateConfig = config.qualityGates?.commentChecker || {};
  if (gateConfig.enabled === false) {
    return {
      kind: "comment_checker",
      at: nowIso(),
      status: "skipped",
      pass: true,
      findings: [],
      reason: "qualityGates.commentChecker.enabled is false",
    };
  }

  const candidatePaths = commentCandidatePaths(task, scopeResult);
  const patterns = commentPatterns(gateConfig.patterns);
  const findings = [];
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
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        if (!pattern.regex.test(line)) continue;
        findings.push({
          file: normalizeRelativePath(filePath),
          line: index + 1,
          pattern: pattern.name,
          text: line.trim().slice(0, 240),
        });
      }
    });
  }

  const blockOnFindings = gateConfig.blockOnFindings === true;
  const status = findings.length === 0 ? "pass" : blockOnFindings ? "fail" : "warn";
  return {
    kind: "comment_checker",
    at: nowIso(),
    status,
    pass: status !== "fail",
    findings,
  };
}

export function hashLine(content) {
  return hashContent(String(content ?? "").trimEnd());
}

async function runCommandGate(rootDir, kind, commands, timeoutMs) {
  const results = [];
  for (const command of commands) {
    const result = await runCommand(command, rootDir, timeoutMs);
    results.push({ command, ...result });
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

function skippedGate(kind, reason) {
  return { kind, at: nowIso(), status: "skipped", pass: true, results: [], reason };
}

function missingCommandsGate(kind, required, reason) {
  const status = required ? "fail" : "warn";
  return { kind, at: nowIso(), status, pass: status !== "fail", results: [], reason };
}

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

function commentCandidatePaths(task, scopeResult) {
  const paths = [];
  if (Array.isArray(scopeResult?.changedPaths)) paths.push(...scopeResult.changedPaths);
  if (Array.isArray(task.writable_paths)) paths.push(...task.writable_paths.filter((item) => !item.includes("*")));
  return [...new Set(paths.map(normalizeRelativePath))];
}

function commentPatterns(rawPatterns) {
  const defaults = [
    { name: "ai_attribution", regex: "\\b(as an ai|generated by ai|ai generated|chatgpt|claude generated)\\b" },
    { name: "placeholder_comment", regex: "\\b(todo|fixme|hack|xxx)\\b" },
    { name: "lorem_ipsum", regex: "lorem ipsum" },
  ];
  const source = Array.isArray(rawPatterns) && rawPatterns.length > 0 ? rawPatterns : defaults;
  return source
    .map((item) => {
      if (typeof item === "string") return { name: item, regex: new RegExp(item, normalizeRegexFlags()) };
      if (!item || typeof item.pattern !== "string") return null;
      return { name: item.name || item.pattern, regex: new RegExp(item.pattern, normalizeRegexFlags(item.flags)) };
    })
    .filter(Boolean);
}

function normalizeRegexFlags(rawFlags = "") {
  const allowed = new Set(["d", "i", "m", "s", "u"]);
  const flags = new Set(String(rawFlags).split("").filter((flag) => allowed.has(flag)));
  flags.add("i");
  return [...flags].sort().join("");
}

function isLikelyTextPath(filePath) {
  return /\.(cjs|css|html|js|json|jsx|md|mjs|py|rb|rs|sh|ts|tsx|txt|vue|yaml|yml)$/i.test(filePath);
}

function normalizeRelativePath(filePath) {
  return String(filePath || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function pathInsideRoot(rootDir, absolutePath) {
  const relative = path.relative(rootDir, absolutePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
