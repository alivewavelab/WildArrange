// =============================================================================
// 文件名称：feature-design.mjs
// 所属模块：orchestration
// 作用说明：
//   功能设计门状态机：在用户澄清需求与导入计划之间插入确认关卡；
//   会话级 gate 持久化，计划导入时绑定 feature_design_ref。
//
// 【运行原理速读】
//   可以把它想成「先对齐要做什么，再允许写计划」：
//
//   · 何时执行？
//     路由命中 clarify-feature-design 或用户确认/导入计划时。
//
//   · 做了什么？
//     awaiting_feature_confirmation → awaiting_plan_import → plan_imported。
//
//   · 和谁协作？
//     host-runtime 在 Hook/路由前推进；plan-state 导入时校验绑定。
// =============================================================================
import { STATE_VERSION, createWorkId, ensureWildArrangeDirs, nowIso, readJson, resolveWildArrangePath, writeJsonAtomic } from "../infra/runtime-store.mjs";
import { loadRoutesConfig, resolveRouteDecision } from "../infra/route-table.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";

/**
 * 根据用户输入推进功能设计门（确认或新开 gate）。
 * @param {string} rootDir 项目根目录
 * @param {string|object} input 文本或含 text/sessionId 的对象
 */
export async function advanceFeatureDesign(rootDir, input) {
  const text = typeof input === "string" ? input : input?.text;
  if (!text || typeof text !== "string") return null;
  const sessionId = typeof input === "object" ? input.sessionId || input.session_id || "session" : "session";
  return withTaskStateLock(rootDir, "feature-design", async () => {
    const active = await loadActiveFeatureDesignGate(rootDir, sessionId);
    if (active?.status === "awaiting_feature_confirmation") {
      return /^(?:确认|确认以上功能设计|功能设计确认)[。.!！]?$/.test(text.trim())
        ? confirmFeatureDesignGate(rootDir, active) : active;
    }
    if (active?.status === "awaiting_plan_import") return active;
    const route = resolveRouteDecision(await loadRoutesConfig(rootDir), text);
    return (route.skills || []).includes("clarify-feature-design")
      ? beginFeatureDesignGate(rootDir, sessionId, text) : active;
  });
}

/**
 * 为会话创建新的功能设计 gate，状态 awaiting_feature_confirmation。
 */
export async function beginFeatureDesignGate(rootDir, sessionId, request) {
  await ensureWildArrangeDirs(rootDir);
  const at = nowIso();
  const gate = {
    version: STATE_VERSION,
    kind: "feature_design_gate",
    id: createWorkId("feature_design"),
    sessionId: String(sessionId || "session"),
    status: "awaiting_feature_confirmation",
    request: String(request || "").trim().slice(0, 4000),
    createdAt: at,
    updatedAt: at,
  };
  await writeJsonAtomic(featureDesignGatePath(rootDir, gate.id), gate);
  await writeJsonAtomic(featureDesignSessionPath(rootDir, gate.sessionId), {
    version: STATE_VERSION,
    gateId: gate.id,
    updatedAt: at,
  });
  return gate;
}

/** 读取会话当前活跃的功能设计 gate。 */
export async function loadActiveFeatureDesignGate(rootDir, sessionId) {
  const pointer = await readJson(featureDesignSessionPath(rootDir, sessionId), null);
  if (!pointer?.gateId) return null;
  return readJson(featureDesignGatePath(rootDir, pointer.gateId), null);
}

/** 用户确认功能设计，gate 进入 awaiting_plan_import。 */
export async function confirmFeatureDesignGate(rootDir, gate) {
  if (!gate || gate.status !== "awaiting_feature_confirmation") {
    throw new Error("feature design gate is not awaiting confirmation");
  }
  const at = nowIso();
  const confirmed = {
    ...gate,
    status: "awaiting_plan_import",
    confirmedAt: at,
    updatedAt: at,
  };
  await writeJsonAtomic(featureDesignGatePath(rootDir, gate.id), confirmed);
  return confirmed;
}

/** 计划导入前校验 feature_design_ref 与 gate 状态一致。 */
export async function assertFeatureDesignPlanBinding(rootDir, plan) {
  if (!plan?.feature_design_ref) return null;
  const gate = await readJson(featureDesignGatePath(rootDir, plan.feature_design_ref), null);
  if (!gate) throw new Error(`unknown feature_design_ref: ${plan.feature_design_ref}`);
  if (gate.status !== "awaiting_plan_import" && !(gate.status === "plan_imported" && gate.planId === plan.id)) {
    throw new Error(`feature design ${gate.id} is not confirmed for plan import`);
  }
  return gate;
}

/** 计划导入成功后绑定 planId，gate 标记 plan_imported。 */
export async function bindFeatureDesignPlan(rootDir, gate, planId) {
  if (!gate) return null;
  const at = nowIso();
  const bound = {
    ...gate,
    status: "plan_imported",
    planId,
    planImportedAt: at,
    updatedAt: at,
  };
  await writeJsonAtomic(featureDesignGatePath(rootDir, gate.id), bound);
  return bound;
}

/** 功能设计 gate 文件的绝对路径。 */
function featureDesignGatePath(rootDir, gateId) {
  return resolveWildArrangePath(rootDir, "sessions", "feature-design", `${safeStateSegment(gateId)}.json`);
}

/** 会话 → 当前 gateId 指针文件路径。 */
function featureDesignSessionPath(rootDir, sessionId) {
  return resolveWildArrangePath(rootDir, "sessions", "feature-design", "by-session", `${safeStateSegment(sessionId)}.json`);
}

/** 将 session/gate ID 归一化为安全文件名片段。 */
function safeStateSegment(value) {
  return String(value || "session").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120) || "session";
}
