import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeRelativePath } from "./path-match.mjs";
import { appendLedger } from "./ledger.mjs";
import {
  ensureHelixDirs,
  nowIso,
  resolveHelixPath,
  resolveTaskReportPath,
  writeJsonAtomic,
} from "./runtime-store.mjs";

export async function writeReviewReport(rootDir, planId, task, reviewResult) {
  await ensureHelixDirs(rootDir);
  const jsonPath = resolveTaskReportPath(rootDir, "reviews", planId, task.id, "json");
  const mdPath = resolveTaskReportPath(rootDir, "reviews", planId, task.id, "md");
  reviewResult.reportJsonPath = normalizeRelativePath(path.relative(rootDir, jsonPath));
  reviewResult.reportMdPath = normalizeRelativePath(path.relative(rootDir, mdPath));
  const report = {
    planId,
    taskId: task.id,
    subject: task.subject,
    status: reviewResult.pass ? "pass" : "fail",
    reviewerAgents: reviewResult.reviewerAgents,
    lanes: reviewResult.lanes,
    findings: reviewResult.findings || [],
    testingGaps: reviewResult.testingGaps || [],
    residualRisks: reviewResult.residualRisks || [],
    qualityResults: reviewResult.qualityResults || null,
    llmReviews: reviewResult.llmReviews || [],
    reviewCommandResults: reviewResult.reviewCommandResults,
    standardsCommandResults: reviewResult.standardsCommandResults || [],
    at: reviewResult.at,
  };
  await writeJsonAtomic(jsonPath, report);
  await writeFile(mdPath, renderReviewMarkdown(report), "utf8");
  await appendLedger(rootDir, {
    type: "review_report_written",
    planId,
    taskId: task.id,
    pass: reviewResult.pass,
    reportPath: reviewResult.reportMdPath,
  });
  return report;
}

function renderReviewMarkdown(report) {
  const lanes = report.lanes.map((lane) => `| ${lane.name} | ${lane.agent} | ${lane.status} | ${lane.summary} |`).join("\n");
  const failed = report.lanes
    .filter((lane) => lane.status === "fail")
    .map((lane) => `- ${lane.name}: ${lane.fixBy}`)
    .join("\n");
  const standards = (report.standardsCommandResults || [])
    .map((result) => `| \`${result.command}\` | ${result.exitCode} |`)
    .join("\n");
  const llmReviews = (report.llmReviews || [])
    .map((review) => `- ${review.agent}: ${review.status}${review.summary ? ` - ${review.summary}` : review.reason ? ` - ${review.reason}` : ""}`)
    .join("\n");
  const commentFindings = report.qualityResults?.commentResult?.findings || [];
  const findings = (report.findings || [])
    .map((finding) => [
      `- ${finding.id} [${finding.severity}] ${finding.title}`,
      `  - Source: ${finding.source}${finding.lane ? ` / ${finding.lane}` : ""}`,
      `  - Evidence: ${finding.evidence}`,
      `  - Required fix: ${finding.requiredFix}`,
      `  - Validator: ${finding.validator?.status || "unknown"} (${finding.validator?.name || "unknown"})`,
    ].join("\n"))
    .join("\n");
  const testingGaps = (report.testingGaps || [])
    .map((gap) => `- ${gap.lane}: ${gap.summary}`)
    .join("\n");
  const residualRisks = (report.residualRisks || [])
    .map((risk) => `- ${risk.lane}: ${risk.summary}`)
    .join("\n");
  return `# Review Gate

| Field | Value |
| --- | --- |
| Plan | \`${report.planId}\` |
| Task | \`${report.taskId}\` |
| Subject | ${report.subject} |
| Status | \`${report.status}\` |
| Agents | ${report.reviewerAgents.join(", ")} |

## Lanes

| Lane | Agent | Status | Summary |
| --- | --- | --- | --- |
${lanes}

## Blocking Fixes

${failed || "- None"}

## Structured Findings

${findings || "- None"}

## Testing Gaps

${testingGaps || "- None"}

## Residual Risks

${residualRisks || "- None"}

## Standards Commands

${standards ? `| Command | Exit Code |
| --- | --- |
${standards}` : "- None"}

## LLM Reviews

${llmReviews || "- None"}

## Comment Findings

${commentFindings.length > 0 ? commentFindings.map((finding) => `- ${finding.file}:${finding.line} ${finding.pattern} - ${finding.text}`).join("\n") : "- None"}
`;
}

export async function writeFailureReport(rootDir, planId, task) {
  if (!task.last_failure) return null;
  await ensureHelixDirs(rootDir);
  const jsonPath = resolveTaskReportPath(rootDir, "failures", planId, task.id, "json");
  const mdPath = resolveTaskReportPath(rootDir, "failures", planId, task.id, "md");
  task.last_failure.reportJsonPath = normalizeRelativePath(path.relative(rootDir, jsonPath));
  task.last_failure.reportMdPath = normalizeRelativePath(path.relative(rootDir, mdPath));
  const report = {
    planId,
    taskId: task.id,
    subject: task.subject,
    status: task.status,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    failure: task.last_failure,
  };
  await writeJsonAtomic(jsonPath, report);
  await writeFile(mdPath, renderFailureMarkdown(report), "utf8");
  await appendLedger(rootDir, {
    type: "failure_report_written",
    planId,
    taskId: task.id,
    reason: task.last_failure.reason,
    reportPath: task.last_failure.reportMdPath,
  });
  return report;
}

function renderFailureMarkdown(report) {
  const failure = report.failure;
  return `# Task Failure

| Field | Value |
| --- | --- |
| Plan | \`${report.planId}\` |
| Task | \`${report.taskId}\` |
| Subject | ${report.subject} |
| Status | \`${report.status}\` |
| Attempts | ${report.attempts}/${report.maxAttempts} |
| Reason | \`${failure.reason}\` |

## Retry Hint

\`\`\`text
${failure.retryHint}
\`\`\`

${failure.changeRequest ? `## ChangeRequest

- ID: \`${failure.changeRequest.id}\`
- Report: ${failure.changeRequest.reportMdPath}
- Denied paths: ${(failure.changeRequest.deniedPaths || []).join(", ") || "(none)"}
` : ""}
`;
}

export async function appendWisdom(rootDir, task, verifyResult) {
  const line = `- ${nowIso()} ${task.id}: ${task.subject} verified by ${verifyResult.results.length} command(s).\n`;
  await appendFile(resolveHelixPath(rootDir, "wisdom", "verification.md"), line, "utf8");
}
