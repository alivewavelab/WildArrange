import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  STATE_VERSION,
  ensureWildArrangeDirs,
  nowIso,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { collectGitChangedPaths } from "../infra/git-diff.mjs";
import { inspectRepositoryGovernance } from "../infra/repository-layout.mjs";

export async function runRepositoryGovernanceAudit(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const { config, sourcePath } = await loadWildArrangeConfig(rootDir);
  const changed = options.changedOnly === true ? await collectGitChangedPaths(rootDir) : null;
  const effectiveChangedOnly = options.changedOnly === true && changed?.available === true;
  const result = await inspectRepositoryGovernance(rootDir, config.repositoryGovernance || {}, {
    force: options.force === true,
    changedOnly: effectiveChangedOnly,
    changedPaths: changed?.available ? changed.paths : [],
  });
  const report = {
    ...result,
    version: STATE_VERSION,
    at: nowIso(),
    configPath: sourcePath,
    changedPathStatus: changed ? (changed.available ? "available" : "unavailable") : null,
    changedPathReason: changed && !changed.available ? changed.reason : null,
    changedOnlyRequested: options.changedOnly === true,
    changedOnlyFallback: options.changedOnly === true && !effectiveChangedOnly,
  };
  const jsonPath = resolveWildArrangePath(rootDir, "reports", "governance", "latest.json");
  const mdPath = resolveWildArrangePath(rootDir, "reports", "governance", "latest.md");
  report.reportJsonPath = path.relative(rootDir, jsonPath);
  report.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, report);
  await writeFile(mdPath, renderGovernanceMarkdown(report), "utf8");
  await appendLedger(rootDir, {
    type: "repository_governance_audited",
    status: report.status,
    findingCount: report.findings.length,
    mode: report.mode || "skipped",
  });
  return report;
}

function renderGovernanceMarkdown(report) {
  const lines = [
    "# WildArrange Repository Governance",
    "",
    `Generated: ${report.at}`,
    `Status: ${report.status}`,
    `Mode: ${report.mode || "skipped"}`,
    `Findings: ${report.findings.length}`,
    "",
  ];
  if (report.reason) lines.push(`Reason: ${report.reason}`, "");
  for (const finding of report.findings) {
    lines.push(`## ${finding.id} · ${finding.severity} · ${finding.ruleId}`);
    lines.push("");
    lines.push(`- Path: ${finding.path}${finding.line ? `:${finding.line}` : ""}`);
    lines.push(`- Evidence: ${finding.evidence}`);
    lines.push(`- Required fix: ${finding.requiredFix}`);
    lines.push("");
  }
  if (report.findings.length === 0) lines.push("- No findings.", "");
  return `${lines.join("\n")}\n`;
}
