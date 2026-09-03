/**
 * Unified error protocol (narrow scope): every structured error that crosses
 * the gateway envelope, the delivery pipeline result, or the CLI non-zero
 * exit carries { code, module, message, next_action } and renders inline as
 * one line, so a human can paste the error to an AI and the AI lands in the
 * right zone/file without reading unrelated modules.
 */

const CAPABILITY_MODULES = {
  worker: "capabilities/worker.mjs",
  verify: "capabilities/verify.mjs",
  scope: "capabilities/scope-guard.mjs",
  review: "capabilities/review-gate.mjs",
  "acceptance-proof": "capabilities/acceptance-proof.mjs",
  checkpoint: "capabilities/checkpoint.mjs",
  command: "infra/command-runner.mjs",
  "command-safety": "infra/command-safety.mjs",
  "repository-governance": "capabilities/repository-governance.mjs",
  "verification-governance-scan": "capabilities/verification-governance.mjs",
  "verification-governance-apply-card": "capabilities/verification-governance.mjs",
  "verification-governance-generate-artifacts": "capabilities/verification-governance.mjs",
};

export function capabilityModule(name) {
  return CAPABILITY_MODULES[name] || `capabilities/gateway.mjs`;
}

export function buildErrorProtocol({ code, module, message, nextAction }) {
  return {
    code: String(code || "unknown_error"),
    module: String(module || "unknown"),
    message: String(message || ""),
    next_action: String(nextAction || "运行 node ./bin/wildarrange.mjs doctor；把本错误完整贴给 AI"),
  };
}

export function formatErrorInline(protocol) {
  const parts = [`[WILDARRANGE-${protocol.code}]`, `(${protocol.module})`, protocol.message];
  if (protocol.next_action) parts.push(`| next: ${protocol.next_action}`);
  return parts.filter(Boolean).join(" ");
}

export function wildarrangeError({ code, module, message, nextAction }) {
  const protocol = buildErrorProtocol({ code, module, message, nextAction });
  const error = new Error(formatErrorInline(protocol));
  error.protocol = protocol;
  return error;
}

export function errorProtocolOf(error, fallback = {}) {
  if (error && typeof error === "object" && error.protocol) return error.protocol;
  return buildErrorProtocol({
    ...fallback,
    message: error instanceof Error ? error.message : String(error || fallback.message || ""),
  });
}
