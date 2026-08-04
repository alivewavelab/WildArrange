/**
 * Capability gateway: static registry + unified result envelope.
 *
 * Orchestration (src/orchestration/*) must call capabilities only through
 * `invokeCapability(name, ctx)`. It must never import a capability
 * implementation file directly. This is the single seam that lets a new
 * check get added (register one more entry below) without touching any
 * orchestration code, and lets every gate outcome be reported the same way
 * (status / evidence / sideEffect / duration_ms / cost / error).
 *
 * First version is intentionally a static object literal, not a dynamic
 * plugin loader: every capability is a real import at the top of this file.
 */
import { runCommand } from "../infra/command-runner.mjs";
import { buildErrorProtocol, capabilityModule, helixError } from "../infra/error-protocol.mjs";
import { runVerifier } from "./verify.mjs";
import { scopeGuard } from "./scope-guard.mjs";
import { writeCheckpoint } from "./checkpoint.mjs";
import { runWorker } from "./worker.mjs";
import { runReviewGate } from "./review-gate.mjs";
import { writeAcceptanceProof } from "./acceptance-proof.mjs";
import { runRepositoryGovernanceAudit } from "./repository-governance.mjs";
import { evaluateCommandSafety } from "../infra/command-safety.mjs";

async function adaptVerify(ctx) {
  const raw = await runVerifier(ctx.rootDir, ctx.task);
  return { status: raw.pass ? "pass" : "fail", evidence: raw, sideEffect: "none" };
}

async function adaptScope(ctx) {
  const raw = await scopeGuard(ctx.rootDir, {
    taskId: ctx.task.id,
    changedPaths: ctx.options?.changedPaths,
    unavailableReason: ctx.options?.unavailableReason,
  });
  return { status: raw.status, evidence: raw, sideEffect: "state_written" };
}

async function adaptReview(ctx) {
  const raw = await runReviewGate(ctx.rootDir, ctx.task, ctx.evidence || {});
  return { status: raw.pass ? "pass" : "fail", evidence: raw, sideEffect: "state_written" };
}

async function adaptAcceptanceProof(ctx) {
  const raw = await writeAcceptanceProof(ctx.rootDir, ctx.planId, ctx.task, ctx.evidence || {});
  return { status: raw.pass ? "pass" : "fail", evidence: raw, sideEffect: "state_written" };
}

async function adaptCheckpoint(ctx) {
  await writeCheckpoint(
    ctx.rootDir,
    ctx.planId,
    ctx.task,
    ctx.evidence?.verifyResult,
    ctx.evidence?.scopeResult,
    ctx.evidence?.reviewResult,
  );
  return { status: "pass", evidence: null, sideEffect: "state_written" };
}

async function adaptWorker(ctx) {
  const raw = await runWorker(ctx.rootDir, ctx.task, ctx.options || {});
  return {
    status: raw.exitCode === 0 ? "pass" : "fail",
    evidence: raw,
    sideEffect: raw.command ? "files_changed" : "none",
  };
}

async function adaptCommand(ctx) {
  const { command, cwd, timeoutMs, ...rest } = ctx.options || {};
  const raw = await runCommand(command, cwd || ctx.rootDir, timeoutMs, rest);
  return { status: raw.exitCode === 0 ? "pass" : "fail", evidence: raw, sideEffect: "none" };
}

async function adaptCommandSafety(ctx) {
  const { command, ...rest } = ctx.options || {};
  const raw = evaluateCommandSafety(command, rest);
  return { status: raw.allowed ? "pass" : "fail", evidence: raw, sideEffect: "none" };
}

async function adaptRepositoryGovernance(ctx) {
  const raw = await runRepositoryGovernanceAudit(ctx.rootDir, ctx.options || {});
  return { status: raw.status, evidence: raw, sideEffect: "state_written" };
}

const CAPABILITIES = {
  worker: adaptWorker,
  verify: adaptVerify,
  scope: adaptScope,
  review: adaptReview,
  "acceptance-proof": adaptAcceptanceProof,
  checkpoint: adaptCheckpoint,
  command: adaptCommand,
  "command-safety": adaptCommandSafety,
  "repository-governance": adaptRepositoryGovernance,
};

export function listRegisteredCapabilities() {
  return Object.keys(CAPABILITIES);
}

export async function invokeCapability(name, ctx = {}) {
  const adapter = CAPABILITIES[name];
  if (!adapter) {
    throw helixError({
      code: "unknown_capability",
      module: "capabilities/gateway.mjs",
      message: `Unknown capability: ${name}. Registered: ${listRegisteredCapabilities().join(", ")}`,
      nextAction: "检查能力名拼写；注册表见 src/capabilities/gateway.mjs 的 CAPABILITIES",
    });
  }
  const startedAt = Date.now();
  try {
    const outcome = await adapter(ctx);
    return normalizeEnvelope(name, outcome, Date.now() - startedAt);
  } catch (error) {
    return normalizeEnvelope(
      name,
      {
        status: "fail",
        evidence: null,
        sideEffect: "none",
        error: buildErrorProtocol({
          code: "capability_threw",
          module: capabilityModule(name),
          message: error instanceof Error ? error.message : String(error),
          nextAction: `运行 node ./bin/helix.mjs doctor 体检；把本错误完整贴给 AI，定位 src/${capabilityModule(name)}`,
        }),
      },
      Date.now() - startedAt,
    );
  }
}

function normalizeEnvelope(name, outcome, durationMs) {
  return {
    capability: name,
    status: outcome.status,
    evidence: outcome.evidence ?? null,
    sideEffect: outcome.sideEffect ?? "none",
    duration_ms: durationMs,
    cost: outcome.cost ?? null,
    error: outcome.error ?? null,
  };
}
