import { nowIso } from "./foundation.mjs";

const FAILING_LANE_SEVERITY = {
  goal_compliance: "P0",
  scope_fidelity: "P0",
  evidence_quality: "P0",
  success_criteria: "P0",
  explicit_review_commands: "P1",
  project_standards: "P1",
  lsp_diagnostics: "P1",
  ast_structure: "P1",
  hashline_anchors: "P1",
  comment_checker: "P1",
  project_rules_context: "P2",
};

export function buildReviewFindingBundle({ lanes = [], qualityResults = {}, llmReviews = [] } = {}) {
  const findings = [];
  const testingGaps = [];
  const residualRisks = [];

  for (const lane of lanes) {
    if (lane.status === "fail") {
      findings.push(validateReviewFinding({
        id: `F-${String(findings.length + 1).padStart(3, "0")}`,
        source: "deterministic_lane",
        lane: lane.name,
        agent: lane.agent,
        severity: FAILING_LANE_SEVERITY[lane.name] || "P1",
        title: lane.summary || `${lane.name} failed`,
        evidence: lane.summary || "lane failed",
        requiredFix: lane.fixBy || "修复该 review lane 指出的阻塞项。",
      }, "deterministic_validator"));
    } else if (lane.status === "warn") {
      const item = {
        lane: lane.name,
        agent: lane.agent,
        summary: lane.summary,
        fixBy: lane.fixBy,
      };
      if (lane.name.includes("test") || lane.name.includes("evidence") || lane.name.includes("lsp") || lane.name.includes("ast") || lane.name.includes("hashline")) {
        testingGaps.push(item);
      } else {
        residualRisks.push(item);
      }
    }
  }

  const commentFindings = qualityResults.commentResult?.findings || [];
  for (const commentFinding of commentFindings) {
    findings.push(validateReviewFinding({
      id: `F-${String(findings.length + 1).padStart(3, "0")}`,
      source: "comment_checker",
      lane: "comment_checker",
      agent: "BaiZe",
      severity: qualityResults.commentResult?.status === "fail" ? "P1" : "P2",
      title: `Blocked comment pattern: ${commentFinding.pattern}`,
      evidence: `${commentFinding.file}:${commentFinding.line} ${commentFinding.text || ""}`.trim(),
      file: commentFinding.file,
      line: commentFinding.line,
      requiredFix: "清理占位注释、AI 署名或无效 TODO；必要时把真实待办改成可追踪任务。",
    }, "comment_schema_validator"));
  }

  for (const llmReview of llmReviews) {
    for (const rawFinding of llmReview.findings || []) {
      findings.push(validateReviewFinding({
        id: `F-${String(findings.length + 1).padStart(3, "0")}`,
        source: "llm_review",
        lane: `llm_${llmReview.agent}`,
        agent: llmReview.agent,
        severity: normalizeSeverity(rawFinding.severity),
        title: rawFinding.title || rawFinding.reason || llmReview.summary || "LLM review finding",
        evidence: rawFinding.evidence || rawFinding.reason || llmReview.summary || "",
        file: rawFinding.file || null,
        line: Number.isInteger(rawFinding.line) ? rawFinding.line : null,
        requiredFix: rawFinding.requiredFix || rawFinding.fix || rawFinding.required_fix || "按 LLM review finding 修复。",
      }, "llm_finding_schema_validator"));
    }
  }

  return {
    kind: "review_finding_bundle",
    at: nowIso(),
    findings,
    testingGaps,
    residualRisks,
  };
}

export function validateReviewFinding(finding, validatorName = "schema_validator") {
  const missing = [];
  if (!finding.title || typeof finding.title !== "string") missing.push("title");
  if (!finding.evidence || typeof finding.evidence !== "string") missing.push("evidence");
  if (!finding.requiredFix || typeof finding.requiredFix !== "string") missing.push("requiredFix");
  const severity = normalizeSeverity(finding.severity);
  if (!severity) missing.push("severity");
  return {
    ...finding,
    severity: severity || "P2",
    validator: {
      name: validatorName,
      status: missing.length === 0 ? "validated" : "rejected",
      reason: missing.length === 0
        ? "finding has severity, evidence, and required fix"
        : `missing required field(s): ${missing.join(", ")}`,
    },
  };
}

function normalizeSeverity(value) {
  const text = String(value || "").toUpperCase();
  if (["P0", "P1", "P2", "P3"].includes(text)) return text;
  if (text === "HIGH" || text === "CRITICAL") return "P0";
  if (text === "MEDIUM") return "P1";
  if (text === "LOW") return "P2";
  return null;
}
