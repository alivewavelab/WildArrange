import { STATE_VERSION, createWorkId, ensureWildArrangeDirs, nowIso, readJson, resolveWildArrangePath, writeJsonAtomic } from "../infra/runtime-store.mjs";
import { loadRoutesConfig, resolveRouteDecision } from "../infra/route-table.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";

// Business transitions are owned here. Snapshot/AI consumers only read state.
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

export async function loadActiveFeatureDesignGate(rootDir, sessionId) {
  const pointer = await readJson(featureDesignSessionPath(rootDir, sessionId), null);
  if (!pointer?.gateId) return null;
  return readJson(featureDesignGatePath(rootDir, pointer.gateId), null);
}

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

export async function assertFeatureDesignPlanBinding(rootDir, plan) {
  if (!plan?.feature_design_ref) return null;
  const gate = await readJson(featureDesignGatePath(rootDir, plan.feature_design_ref), null);
  if (!gate) throw new Error(`unknown feature_design_ref: ${plan.feature_design_ref}`);
  if (gate.status !== "awaiting_plan_import" && !(gate.status === "plan_imported" && gate.planId === plan.id)) {
    throw new Error(`feature design ${gate.id} is not confirmed for plan import`);
  }
  return gate;
}

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

function featureDesignGatePath(rootDir, gateId) {
  return resolveWildArrangePath(rootDir, "sessions", "feature-design", `${safeStateSegment(gateId)}.json`);
}

function featureDesignSessionPath(rootDir, sessionId) {
  return resolveWildArrangePath(rootDir, "sessions", "feature-design", "by-session", `${safeStateSegment(sessionId)}.json`);
}

function safeStateSegment(value) {
  return String(value || "session").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120) || "session";
}

