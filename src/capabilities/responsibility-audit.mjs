import path from "node:path";
import { RESPONSIBILITY_RULES, RESPONSIBILITY_REVIEW_INSTRUCTIONS, responsibilityDigest, normalizeResponsibilityChanges } from "../infra/responsibility-contract.mjs";
import { collectResponsibilityEvidence } from "../infra/responsibility-evidence.mjs";
import { readVerifiedLedgerEntries } from "../infra/ledger.mjs";
import { runCommand } from "../infra/command-runner.mjs";
import { compileCommandSafetyPatterns } from "../infra/command-safety.mjs";
import { runResponsibilityLlmReview } from "../infra/llm-provider.mjs";
import { nowIso, readJson, resolveWildArrangePath, resolveTaskReportPath, writeJsonAtomic } from "../infra/runtime-store.mjs";

export async function runResponsibilityAudit(controlRoot, task, scopeResult, config, executionRoot = controlRoot) {
  const base = { kind: "responsibility_audit", at: nowIso(), reviewer: "BaiZe" };
  const blocked = (reason) => ({ ...base, pass: false, decision: "RETURN", summary: reason, findings: [] });
  try {
    const entries = await readVerifiedLedgerEntries(controlRoot);
    const imported = [...entries].reverse().find((e) => e.type === "plan_imported" && e.planId === task.planId);
    const changes = normalizeResponsibilityChanges(task.responsibilityChanges, task.writable_paths);
    if (!changes) {
      if (imported?.responsibilityAuditRequired) return blocked("R1: task is missing approved responsibilityChanges");
      return { ...base, pass: false, decision: "NOT_AUDITED", legacy: true, summary: "Legacy task has no responsibility declaration; no responsibility audit was performed", findings: [] };
    }
    const work = await readJson(resolveWildArrangePath(controlRoot, "work.json"), null);
    if (work?.activePlanId !== task.planId || work?.planApproval?.status !== "approved") return blocked("R1: current plan still awaits human approval");
    const approved = [...entries].reverse().find((e) => e.type === "plan_approved" && e.planId === task.planId);
    const digest = responsibilityDigest(changes);
    if (approved?.responsibilityScopes?.[task.id] !== digest) return blocked("R1: responsibility changes are unapproved or changed after approval; return for plan confirmation");
    if (scopeResult?.status !== "pass") return blocked("Responsibility audit requires passing scope evidence");
    const uncovered = (scopeResult.changedPaths || []).filter((name) => !changes.some((item) => item.script === name));
    if (uncovered.length) return blocked(`R1: changed files missing from approved responsibilityChanges: ${uncovered.join(", ")}`);
    const settings = config.review?.responsibility || {};
    const budget = Number.isInteger(settings.maxEvidenceChars) && settings.maxEvidenceChars > 0 ? settings.maxEvidenceChars : 500000;
    const source = await collectResponsibilityEvidence(executionRoot, changes, scopeResult.changedPaths, budget);
    const packet = {
      taskId: task.id, planId: task.planId, responsibilityChanges: changes, rules: RESPONSIBILITY_RULES, source,
      instruction: RESPONSIBILITY_REVIEW_INSTRUCTIONS,
    };
    const packetPath = resolveTaskReportPath(controlRoot, "reviews", task.planId, task.id, "json") + ".responsibility-input.json";
    await writeJsonAtomic(packetPath, packet);
    let content;
    if (typeof settings.command === "string" && settings.command.trim()) {
      const result = await runCommand(settings.command, executionRoot, settings.timeoutMs || 120000, {
        extraPatterns: compileCommandSafetyPatterns(config),
        env: { WILDARRANGE_REVIEW_PACKET: path.resolve(packetPath) },
      });
      if (result.terminationFailed || result.recoveryRequired) return { ...blocked("Reviewer termination requires recovery"), commandRecovery: result };
      if (result.exitCode !== 0 || result.outputTruncated?.stdout) return blocked("Independent reviewer failed or output was truncated");
      content = result.stdout;
    } else {
      content = await runResponsibilityLlmReview(config, packet, settings);
    }
    const after = await collectResponsibilityEvidence(executionRoot, changes, scopeResult.changedPaths, budget);
    if (after.digest !== source.digest) return blocked("Source changed during independent audit; rerun verification and review");
    const result = validateResponsibilityVerdict(JSON.parse(content), source);
    return { ...base, ...result, packetPath, sourceDigest: source.digest, responsibilityDigest: digest };
  } catch (error) { return blocked(`Responsibility audit incomplete: ${error.message}`); }
}

export function validateResponsibilityVerdict(result, source) {
  if (!["PASS", "RETURN"].includes(result?.decision)) throw new Error("invalid audit decision");
  if (!Array.isArray(result.checks) || result.checks.length !== 5 || new Set(result.checks.map((c) => c.rule)).size !== 5) throw new Error("audit must cover R1-R5 exactly once");
  for (const check of result.checks) {
    if (!RESPONSIBILITY_RULES[check.rule] || !["PASS", "RETURN"].includes(check.decision) || !check.reason?.trim()) throw new Error("invalid audit check");
  }
  if (!Array.isArray(result.findings)) throw new Error("audit findings must be an array");
  for (const finding of result.findings) {
    if (!RESPONSIBILITY_RULES[finding.rule] || !finding.reason?.trim() || !finding.requiredFix?.trim()) throw new Error("finding requires rule, reason and requiredFix");
    const file = source.files.find((f) => f.path === finding.file);
    const line = Number.isInteger(finding.line) && finding.line > 0 ? file?.content?.split(/\r?\n/)[finding.line - 1] : null;
    if (!finding.evidence?.trim() || line !== finding.evidence) throw new Error("finding must cite an exact reviewed source line");
    if (!result.checks.some((c) => c.rule === finding.rule && c.decision === "RETURN")) throw new Error("finding conflicts with rule check");
  }
  for (const check of result.checks.filter((c) => c.decision === "RETURN")) {
    if (!result.findings.some((f) => f.rule === check.rule)) throw new Error("RETURN rule needs evidence");
  }
  const pass = result.checks.every((c) => c.decision === "PASS") && result.findings.length === 0;
  if ((result.decision === "PASS") !== pass) throw new Error("audit decision contradicts checks");
  return { pass, decision: result.decision, checks: result.checks, findings: result.findings,
    summary: pass ? "R1-R5 passed independent responsibility audit" : result.findings.map((f) => `${f.rule} ${f.file}:${f.line}: ${f.reason}; evidence=${f.evidence}; fix=${f.requiredFix}`).join("\n") };
}
