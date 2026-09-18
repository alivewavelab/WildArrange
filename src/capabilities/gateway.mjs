// =============================================================================
// 文件名称：gateway.mjs
// 所属模块：capabilities
// 作用说明：
//   能力网关：静态注册表 + 统一结果信封。orchestration 只能通过
//   invokeCapability 调用能力，不得直接 import 各 capability 实现文件。
//
// 【运行原理速读】
//   可以把它想成「所有门禁的统一前台」：
//
//   · 谁调用？src/orchestration/* 在流水线各阶段 invokeCapability(name, ctx)。
//
//   · 它具体做了什么？
//     ① 查 CAPABILITIES 注册表；② adapter 调用具体实现；③ normalizeEnvelope
//     统一 status/evidence/sideEffect/duration_ms/error。
//
//   · 和其他部分的关系？
//     聚合 worker/verify/scope/review/governance 等子模块；新增能力只需
//     注册一条 entry，不必改 orchestration。
//
//   · 缺了它会怎样？
//     编排层与能力实现耦合，gate 结果格式不一致，难以审计与扩展。
// =============================================================================

import { checkExecutionReadiness } from "./execution-readiness.mjs";
import { runCommand } from "../infra/command-runner.mjs";
import { buildErrorProtocol, wildarrangeError } from "../infra/error-protocol.mjs";
import { runVerifier } from "./verify.mjs";
import { scopeGuard } from "./scope-guard.mjs";
import { writeCheckpoint } from "./checkpoint.mjs";
import { runWorker } from "./worker.mjs";
import { runReviewGate } from "./review-gate.mjs";
import { writeAcceptanceProof } from "./acceptance-proof.mjs";
import { runRepositoryGovernanceAudit } from "./repository-governance.mjs";
import {
  applyVerificationCard,
  generateVerificationArtifacts,
  scanVerificationGovernance,
} from "./verification-governance.mjs";
import {
  applyContractGovernanceCard,
  generateContractGovernanceArtifacts,
  scanContractGovernance,
} from "./contract-governance.mjs";
import { evaluateCommandSafety } from "../infra/command-safety.mjs";

/** 将 runVerifier 结果映射为 gateway 统一 status/evidence 形态。 */
async function adaptVerify(ctx) {
  const raw = await runVerifier(ctx.rootDir, ctx.task, ctx.options || {});
  return { status: raw.pass ? "pass" : "fail", evidence: raw, sideEffect: "none" };
}

/** 将 scopeGuard 结果映射为 gateway 信封；始终 sideEffect=state_written。 */
async function adaptScope(ctx) {
  const raw = await scopeGuard(ctx.rootDir, {
    taskId: ctx.task.id,
    changedPaths: ctx.options?.changedPaths,
    unavailableReason: ctx.options?.unavailableReason,
    executionRoot: ctx.options?.executionRoot,
  });
  return { status: raw.status, evidence: raw, sideEffect: "state_written" };
}

/** 将 runReviewGate 的 pass 映射为 gateway pass/fail。 */
async function adaptReview(ctx) {
  const raw = await runReviewGate(ctx.rootDir, ctx.task, ctx.evidence || {}, ctx.options || {});
  return { status: raw.pass ? "pass" : "fail", evidence: raw, sideEffect: "state_written" };
}

/** 契约扫描：任务审查或 write=false 时不写持久化 scan。 */
async function adaptContractScan(ctx) {
  const raw = await scanContractGovernance(ctx.rootDir, ctx.options || {});
  const readOnly = Boolean(ctx.options?.inspectTask) || ctx.options?.write === false;
  return { status: raw.status || "pass", evidence: raw, sideEffect: readOnly ? "none" : "state_written" };
}

/** 契约卡决策成功（approved/rejected）映射为 gateway pass。 */
async function adaptContractApplyCard(ctx) {
  const raw = await applyContractGovernanceCard(ctx.rootDir, ctx.options || {});
  return { status: new Set(["approved", "rejected"]).has(raw.status) ? "pass" : "fail", evidence: raw, sideEffect: "files_changed" };
}

/** 契约治理只读视图生成，无 sideEffect。 */
async function adaptContractGenerate(ctx) {
  const raw = await generateContractGovernanceArtifacts(ctx.rootDir, ctx.options || {});
  return { status: "pass", evidence: raw, sideEffect: "none" };
}

/** acceptance proof 的 pass 由 buildAcceptanceProof 全项 checks 决定。 */
async function adaptAcceptanceProof(ctx) {
  const raw = await writeAcceptanceProof(ctx.rootDir, ctx.planId, ctx.task, ctx.evidence || {}, ctx.options || {});
  return { status: raw.pass ? "pass" : "fail", evidence: raw, sideEffect: "state_written" };
}

/** 写入 checkpoint 快照；deliveryBaseline 可来自 integrationCommit 别名。 */
async function adaptCheckpoint(ctx) {
  await writeCheckpoint(
    ctx.rootDir,
    ctx.planId,
    ctx.task,
    ctx.evidence?.verifyResult,
    ctx.evidence?.scopeResult,
    ctx.evidence?.reviewResult,
    ctx.evidence?.deliveryBaseline || ctx.evidence?.integrationCommit || null,
  );
  return { status: "pass", evidence: null, sideEffect: "state_written" };
}

/** worker exitCode=0 为 pass；无 command 时 sideEffect=none。 */
async function adaptWorker(ctx) {
  const raw = await runWorker(ctx.rootDir, ctx.task, ctx.options || {});
  return {
    status: raw.exitCode === 0 ? "pass" : "fail",
    evidence: raw,
    sideEffect: raw.command ? "files_changed" : "none",
  };
}

/** 透传 infra runCommand，供 gateway command 能力调用。 */
async function adaptCommand(ctx) {
  const { command, cwd, timeoutMs, ...rest } = ctx.options || {};
  const raw = await runCommand(command, cwd || ctx.rootDir, timeoutMs, rest);
  return { status: raw.exitCode === 0 ? "pass" : "fail", evidence: raw, sideEffect: "none" };
}

/** 纯评估命令安全性，不执行命令。 */
async function adaptCommandSafety(ctx) {
  const { command, ...rest } = ctx.options || {};
  const raw = evaluateCommandSafety(command, rest);
  return { status: raw.allowed ? "pass" : "fail", evidence: raw, sideEffect: "none" };
}

/** 仓库治理审计；status 直接来自 inspect 结果。 */
async function adaptRepositoryGovernance(ctx) {
  const raw = await runRepositoryGovernanceAudit(ctx.rootDir, ctx.options || {});
  return { status: raw.status, evidence: raw, sideEffect: "state_written" };
}

/** 验证宇宙扫描，只读 sideEffect。 */
async function adaptVerificationScan(ctx) {
  const raw = await scanVerificationGovernance(ctx.rootDir, ctx.options || {});
  return { status: "pass", evidence: raw, sideEffect: "none" };
}

/** 验证卡 apply 仅 committed 状态为 gateway pass。 */
async function adaptVerificationApplyCard(ctx) {
  const raw = await applyVerificationCard(ctx.rootDir, ctx.options || {});
  return { status: raw.status === "committed" ? "pass" : "fail", evidence: raw, sideEffect: "files_changed" };
}

/** 生成 verification registry/bootstrap/inventory 制品。 */
async function adaptVerificationGenerate(ctx) {
  const raw = await generateVerificationArtifacts(ctx.rootDir, ctx.options || {});
  return { status: "pass", evidence: raw, sideEffect: "files_changed" };
}

/**
 * 静态能力注册表：键为 invokeCapability 名称，值为 adapter handler 与 owner 模块路径。
 * orchestration 只能经此表调用；新增能力须在此登记并补充 delivery-pipeline 接线。
 *
 * 键含义速查：
 * - execution-readiness / worker / verify / scope / review / acceptance-proof / checkpoint：交付质量门链
 * - command / command-safety：命令执行与安全评估（infra 适配）
 * - repository-governance：仓库布局与命名审计
 * - verification-governance-* / contract-governance-*：验证与契约治理 scan/apply/generate 三件套
 */
const CAPABILITIES = {
  "execution-readiness": { handler: async (ctx) => { const evidence = await checkExecutionReadiness(ctx.rootDir, ctx.task, ctx.options); return { status: evidence.pass ? "pass" : "fail", evidence, sideEffect: "state_written" }; }, owner: "capabilities/execution-readiness.mjs" },
  worker: { handler: adaptWorker, owner: "capabilities/worker.mjs" },
  verify: { handler: adaptVerify, owner: "capabilities/verify.mjs" },
  scope: { handler: adaptScope, owner: "capabilities/scope-guard.mjs" },
  review: { handler: adaptReview, owner: "capabilities/review-gate.mjs" },
  "acceptance-proof": { handler: adaptAcceptanceProof, owner: "capabilities/acceptance-proof.mjs" },
  checkpoint: { handler: adaptCheckpoint, owner: "capabilities/checkpoint.mjs" },
  command: { handler: adaptCommand, owner: "infra/command-runner.mjs" },
  "command-safety": { handler: adaptCommandSafety, owner: "infra/command-safety.mjs" },
  "repository-governance": { handler: adaptRepositoryGovernance, owner: "capabilities/repository-governance.mjs" },
  "verification-governance-scan": { handler: adaptVerificationScan, owner: "capabilities/verification-governance.mjs" },
  "verification-governance-apply-card": { handler: adaptVerificationApplyCard, owner: "capabilities/verification-governance.mjs" },
  "verification-governance-generate-artifacts": { handler: adaptVerificationGenerate, owner: "capabilities/verification-governance.mjs" },
  "contract-governance-scan": { handler: adaptContractScan, owner: "capabilities/contract-governance.mjs" },
  "contract-governance-apply-card": { handler: adaptContractApplyCard, owner: "capabilities/contract-governance.mjs" },
  "contract-governance-generate-artifacts": { handler: adaptContractGenerate, owner: "capabilities/contract-governance.mjs" },
};

/** 返回已注册能力名称列表。 */
export function listRegisteredCapabilities() {
  return Object.keys(CAPABILITIES);
}

/**
 * 按名称调用能力，捕获异常并归一化为统一信封。
 * @param {string} name 注册表中的能力名
 * @param {object} [ctx] rootDir、task、planId、evidence、options
 * @returns {Promise<object>} capability、status、evidence、sideEffect、duration_ms
 */
export async function invokeCapability(name, ctx = {}) {
  const adapter = CAPABILITIES[name]?.handler;
  if (!adapter) {
    throw wildarrangeError({
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
    return capabilityErrorEnvelope(name, error, Date.now() - startedAt);
  }
}

/** Node/系统级错误码模式；匹配时不向外透传，统一映射为 capability_threw。 */
const SYSTEM_ERROR_CODE_RE = /^(ERR_[A-Z0-9_]+|E[A-Z][A-Z0-9]*)$/;

/**
 * 将 thrown error 转为 fail 状态的标准 capability 信封。
 * @param {string} name 能力名
 * @param {Error|object} error 原始错误
 * @param {number} durationMs 耗时毫秒
 */
export function capabilityErrorEnvelope(name, error, durationMs) {
  const rawCode = error?.code;
  // §3.4：系统级 ERR_/E* 码不向外透传，统一为 capability_threw 便于编排层处理。
  const code = typeof rawCode === "string"
    && /^[a-z][a-z0-9_]*$/i.test(rawCode)
    && !SYSTEM_ERROR_CODE_RE.test(rawCode)
    ? rawCode
    : "capability_threw";
  return normalizeEnvelope(
    name,
    {
      status: "fail",
      evidence: error?.evidence ?? error?.manifest ?? null,
      sideEffect: "none",
      error: buildErrorProtocol({
        code,
        module: capabilityModule(name),
        message: error instanceof Error ? error.message : String(error),
        nextAction: error?.nextAction || error?.next_action
          || `运行 node ./bin/wildarrange.mjs doctor 体检；把本错误完整贴给 AI，定位 src/${capabilityModule(name)}`,
      }),
    },
    durationMs,
  );
}

/** 将 adapter outcome 归一化为 invokeCapability 标准返回字段。 */
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

/** 返回能力对应的 owner 模块路径（用于错误协议定位）。 */
export function capabilityModule(name) { return CAPABILITIES[name]?.owner || "capabilities/gateway.mjs"; }
