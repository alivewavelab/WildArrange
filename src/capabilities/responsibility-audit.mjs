// =============================================================================
// 文件名称：responsibility-audit.mjs
// 所属模块：capabilities
// 作用说明：
//   对声明了 responsibilityChanges 的任务执行 BaiZe 独立职责审计（R1-R5），
//   校验计划批准、scope 覆盖与源码引用，产出 responsibility_audit receipt。
//
// 【运行原理速读】
//   · 何时执行？review gate 的 responsibility_audit lane。
//   · 做了什么？ledger 批准链 → collectResponsibilityEvidence → 独立审查 packet
//     → validateResponsibilityVerdict。
//   · 缺了它会怎样？职责边界变更可未经独立审计即被当作完成。
// =============================================================================

import { loadSkillAttachment } from "../infra/context-attachments.mjs";
import { executeReviewPacket } from "./project-review.mjs";
import { RESPONSIBILITY_RULES, RESPONSIBILITY_REVIEW_INSTRUCTIONS, responsibilityDigest, normalizeResponsibilityChanges } from "../infra/responsibility-contract.mjs";
import { collectResponsibilityEvidence } from "../infra/responsibility-evidence.mjs";
import { readVerifiedLedgerEntries } from "../infra/ledger.mjs";
import { nowIso, readJson, resolveWildArrangePath, resolveTaskReportPath } from "../infra/runtime-store.mjs";

/**
 * 运行完整职责审计流程；legacy 无 declaration 时返回 NOT_AUDITED。
 * @param {string} controlRoot ledger 与配置根
 * @param {string} executionRoot 源码 evidence 收集根
 */
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
    const reviewSkill = await loadSkillAttachment(controlRoot, "review-work", budget);
    if (!reviewSkill || reviewSkill.truncated) return blocked("Required review-work Skill is missing or truncated");
    const packet = {
      requiredSkills: [reviewSkill],
      taskId: task.id, planId: task.planId, responsibilityChanges: changes, rules: RESPONSIBILITY_RULES, source,
      instruction: RESPONSIBILITY_REVIEW_INSTRUCTIONS,
    };
    if (JSON.stringify(packet).length > budget) return blocked("Responsibility review packet exceeds evidence budget");
    const packetPath = resolveTaskReportPath(controlRoot, "reviews", task.planId, task.id, "json") + ".responsibility-input.json";
    const response = await executeReviewPacket(executionRoot, packetPath, packet, config, settings);
    if (response.commandRecovery) return { ...blocked("Reviewer termination requires recovery"), commandRecovery: response.commandRecovery };
    const content = response.content;
    const after = await collectResponsibilityEvidence(executionRoot, changes, scopeResult.changedPaths, budget);
    if (after.digest !== source.digest) return blocked("Source changed during independent audit; rerun verification and review");
    const result = validateResponsibilityVerdict(JSON.parse(content), source);
    return { ...base, ...result, packetPath, sourceDigest: source.digest, responsibilityDigest: digest };
  } catch (error) { return blocked(`Responsibility audit incomplete: ${error.message}`); }
}

/**
 * 校验审计 JSON：R1-R5 各一条 check、finding 与源码行引用一致。
 * @returns {object} pass、decision、checks、findings、summary
 */
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
