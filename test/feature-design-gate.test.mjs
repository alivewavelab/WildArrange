import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildPlanDraftDirective, routeRequest } from "../src/ai/routing.mjs";
import { preToolUseGuard, runInjectionHook } from "../src/ai/hooks.mjs";
import { importPlan, loadPlanApproval } from "../src/orchestration/plan-state.mjs";
import { loadActiveFeatureDesignGate } from "../src/infra/runtime-snapshot.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";

test("feature design confirmation and complete plan cannot be bypassed across turns", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-feature-gate-"));
  const sessionId = "feature-gate-session";
  try {
    await initRuntime(rootDir);
    const oldPlanPath = path.join(rootDir, "old-plan.json");
    await writeFile(oldPlanPath, JSON.stringify({
      title: "Existing maintenance plan",
      tasks: [{
        id: "OLD001",
        subject: "Maintain existing behavior",
        owner: "Jiuwei",
        writable_paths: ["src/old.js"],
        worker_command: "node --version",
        verify_commands: ["node --version"],
      }],
    }), "utf8");
    await importPlan(rootDir, oldPlanPath);

    const first = await routeRequest(rootDir, {
      text: "新增一个从游戏详情页启动游戏的功能，开始做吧",
      sessionId,
    });
    assert.equal(first.featureDesign.status, "awaiting_feature_confirmation");
    assert.equal(buildPlanDraftDirective(first, { sessionId, prompt: "开始做吧" }), null);

    for (const text of ["开始做吧", "不需要计划，直接做", "确认并直接做"]) {
      const blockedRoute = await routeRequest(rootDir, { text, sessionId });
      assert.equal(blockedRoute.route, "plan");
      assert.equal(blockedRoute.featureDesign.status, "awaiting_feature_confirmation");
      assert.ok(blockedRoute.skills.includes("clarify-feature-design"));
      assert.equal(buildPlanDraftDirective(blockedRoute, { sessionId, prompt: text }), null);
    }

    const blockedShell = await preToolUseGuard(rootDir, {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command: "node -e \"console.log('implement')\"" },
    });
    assert.equal(blockedShell.decision, "deny");
    assert.equal(blockedShell.code, "feature_design_confirmation_required");

    const blockedDraft = await preToolUseGuard(rootDir, {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "functions.apply_patch",
      tool_input: { file_path: ".wildarrange/plan-drafts/feature-gate-plan.json" },
    });
    assert.equal(blockedDraft.decision, "deny");
    assert.equal(blockedDraft.code, "feature_design_confirmation_required");

    const confirmed = await routeRequest(rootDir, { text: "确认", sessionId });
    assert.equal(confirmed.featureDesign.status, "awaiting_plan_import");
    const directive = buildPlanDraftDirective(confirmed, { sessionId, prompt: "确认" });
    assert.equal(directive.featureDesignRef, confirmed.featureDesign.id);

    const planPath = path.join(rootDir, ".wildarrange", "plan-drafts", "feature-gate-plan.json");
    const plan = {
      generated_by: "host_semantic",
      feature_design_ref: confirmed.featureDesign.id,
      title: "Launch game from details",
      objective: "Let the user launch the selected game from its details page.",
      tasks: [{
        id: "T001",
        subject: "Implement game launch entry",
        description: "Add the confirmed launch interaction and state update.",
        owner: "ZhuRong",
        writable_paths: ["src/feature.js"],
        worker_command: "node --version",
        verify_commands: ["node --version"],
        review_commands: ["node --version"],
        successCriteria: [{
          title: "The confirmed launch behavior is implemented",
          expectedEvidence: "Verifier and reviewer commands pass for the implementation.",
          verifierCommandRefs: [0],
        }],
      }],
    };
    await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");

    const matchingImport = await preToolUseGuard(rootDir, {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command: "node ./bin/wildarrange.mjs plan --from .wildarrange/plan-drafts/feature-gate-plan.json" },
    });
    assert.equal(matchingImport.decision, "allow");

    await importPlan(rootDir, planPath);
    const gate = await loadActiveFeatureDesignGate(rootDir, sessionId);
    assert.equal(gate.status, "plan_imported");
    assert.ok(gate.planId);
    assert.equal((await loadPlanApproval(rootDir)).status, "pending");

    const blockedBeforeApproval = await preToolUseGuard(rootDir, {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command: "node -e \"console.log('implement')\"" },
    });
    assert.equal(blockedBeforeApproval.decision, "deny");
    assert.equal(blockedBeforeApproval.code, "awaiting_plan_approval_shell");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("UserPromptSubmit keeps later start commands inside the feature design gate", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-feature-hook-"));
  const sessionId = "feature-hook-session";
  try {
    const first = await runInjectionHook(rootDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: rootDir,
      prompt: "新增一个导出按钮",
    });
    assert.match(first.output, /功能设计确认门（禁止绕过）/);
    assert.doesNotMatch(first.output, /生成计划草稿（必须执行）/);

    const start = await runInjectionHook(rootDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: rootDir,
      prompt: "开始做吧",
    });
    assert.match(start.output, /等待功能设计确认/);
    assert.match(start.output, /### clarify-feature-design/);
    assert.doesNotMatch(start.output, /生成计划草稿（必须执行）/);

    const confirmed = await runInjectionHook(rootDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: rootDir,
      prompt: "确认",
    });
    assert.match(confirmed.output, /完整 Plan 门（禁止绕过）/);
    assert.match(confirmed.output, /feature_design_ref/);
    assert.match(confirmed.output, /生成计划草稿（必须执行）/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("ordinary architecture planning does not mount the feature clarification skill", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-architecture-hook-"));
  try {
    const result = await runInjectionHook(rootDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "architecture-plan-session",
      cwd: rootDir,
      prompt: "制定一个仓库架构调整计划",
    });
    assert.doesNotMatch(result.output, /### clarify-feature-design/);
    assert.doesNotMatch(result.output, /功能设计确认门（禁止绕过）/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
