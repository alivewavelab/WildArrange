// =============================================================================
// 文件名称：runtime-hooks.test.mjs
// 所属模块：test
// 作用说明：
//   宿主 Hook 注入与工具门：UserPromptSubmit/SessionStart/PostToolUse/PreToolUse 的注入内容与拒绝决策。
// =============================================================================

import assert from "node:assert/strict";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { approvePlan } from "../src/orchestration/plan-state.mjs";
import { runInjectionHook as renderHook } from "../src/ai/hooks.mjs";
import { TRUSTED_CLI_COMMAND_PREFIX, preToolUseGuard } from "../src/ai/pre-tool-guard.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { runCommandFile } from "../src/infra/command-runner.mjs";
import { withExternalProject, declare, importApprovedPlan } from "./helpers/external-fixture.mjs";
import { runInjectionHook, writePolicyConfig, createSmokePlan } from "./helpers/runtime-fixtures.mjs";

test("hook adapter emits WildArrange runtime injection for user prompt", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    await writeFile(path.join(projectRoot, "AGENTS.md"), "# Project Rules\n\nAlways verify behavior.\n");

    const result = await runInjectionHook(projectRoot, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      cwd: projectRoot,
      prompt: "做一个网页版 TODO 工具，支持删除任务",
    });

    assert.equal(result.event, "UserPromptSubmit");
    assert.equal(result.pointName, "user_prompt_submit");
    assert.match(result.output, /<wildarrange-injection event="UserPromptSubmit" point="user_prompt_submit">/);
    assert.match(result.output, /## 路由决策/);
    assert.match(result.output, /类别：visual-engineering/);
    assert.match(result.output, /计划 Skill 组合/);
    assert.match(result.output, /review-ux-interaction/);
    assert.match(result.output, /## 功能设计确认门（禁止绕过）/);
    assert.match(result.output, /等待功能设计确认/);
    assert.doesNotMatch(result.output, /\.wildarrange\/plan-drafts\/session-1-plan\.json/);
    assert.match(result.output, /项目规则/);
    assert.match(result.output, /Always verify behavior/);

    const hookRecord = await readJson(resolveWildArrangePath(projectRoot, "sessions", "hooks", "session-1-UserPromptSubmit.json"));
    assert.equal(hookRecord.event, "UserPromptSubmit");
    assert.ok(hookRecord.output.length > 0);
  });
});

test("hook sessions in task worktrees keep governance facts in the control root", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    // 真实任务 worktree：项目 Git 仓的 linked worktree，位于项目与运行态根之外。
    const executionRoot = path.join(root, "task-worktree");
    const added = await runCommandFile("git", ["worktree", "add", "-q", "-b", "wildarrange/task/hook-plan/T001", executionRoot], projectRoot);
    assert.equal(added.exitCode, 0, added.stderr);
    await writeFile(path.join(executionRoot, "AGENTS.md"), "# Task Worktree Rules\n\nWORKTREE_RULE_PROBE\n");
    const samplePath = await createSmokePlan(root);
    await importApprovedPlan(projectRoot, samplePath);
    await approvePlan(projectRoot);

    const session = await runInjectionHook(projectRoot, {
      hook_event_name: "SessionStart",
      session_id: "task-worktree-session",
      cwd: executionRoot,
    });

    assert.match(session.output, /WORKTREE_RULE_PROBE/);
    assert.equal(
      (await readJson(resolveWildArrangePath(projectRoot, "sessions", "hooks", "task-worktree-session-SessionStart.json"))).event,
      "SessionStart",
    );
    await assert.rejects(() => stat(path.join(executionRoot, ".wildarrange")), { code: "ENOENT" });

    const preTool = await runInjectionHook(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "task-worktree-session",
      cwd: executionRoot,
      task_id: "T001",
      tool_name: "functions.apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Add File: artifacts/linear-smoke.txt\n+ok\n*** End Patch",
      },
    });

    assert.equal(preTool.decision, "allow");
    assert.deepEqual(preTool.targetPaths, ["artifacts/linear-smoke.txt"]);
    await assert.rejects(() => stat(path.join(executionRoot, ".wildarrange")), { code: "ENOENT" });
  });
});

test("hook rendering rewrites canonical plan, resume, and prompt commands to the adapter CLI prefix", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    const skillDir = path.join(projectRoot, ".agents", "skills", "command-probe");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), [
      "# Command probe",
      "",
      "Run `node ./bin/wildarrange.mjs plan --from draft.json`.",
      "Run `node ./bin/wildarrange.mjs resume`.",
      "Run `node ./bin/wildarrange.mjs prompts show --skill command-probe`.",
      "",
    ].join("\n"));
    await writePolicyConfig(governanceRoot, JSON.stringify({
      skillMatcher: { dynamicInjection: { enabled: false } },
      injectionPoints: {
        user_prompt_submit: { enabled: true, tools: [], markdown: [], skills: ["command-probe"], rules: {} },
      },
    }, null, 2));
    await initRuntime(projectRoot);

    const result = await renderHook(projectRoot, {
      hook_event_name: "UserPromptSubmit",
      session_id: "adapter-prefix",
      cwd: projectRoot,
      prompt: "修复 broken login bug",
      cli_command_prefix: "npx -y wildarrange",
      [TRUSTED_CLI_COMMAND_PREFIX]: "npx -y wildarrange",
    });

    assert.ok(result.output.includes(`npx -y wildarrange plan --from ${resolveWildArrangePath(projectRoot, "plan-drafts", "adapter-prefix-plan.json")}`));
    assert.match(result.output, /npx -y wildarrange resume/);
    assert.match(result.output, /npx -y wildarrange prompts show --skill command-probe/);
    assert.doesNotMatch(result.output, /node \.\/bin\/wildarrange\.mjs/);
    assert.match(result.output, /`verify_commands` 必须是非空的命令字符串数组/);
  }, { init: false });
});

test("Codex session hooks inject and rehydrate the full Jiuwei prompt without repeating it per user prompt", async () => {
  await withExternalProject(async ({ projectRoot }) => {

    const sessionStart = await runInjectionHook(projectRoot, {
      hook_event_name: "SessionStart",
      session_id: "session-jiuwei",
      cwd: projectRoot,
    });
    assert.match(sessionStart.output, /### Jiuwei 身份 Prompt/);
    assert.match(sessionStart.output, /你是 Jiuwei，WildArrange 的主编排器/);

    const userPrompt = await runInjectionHook(projectRoot, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-jiuwei",
      cwd: projectRoot,
      prompt: "继续当前任务",
    });
    assert.doesNotMatch(userPrompt.output, /### Jiuwei 身份 Prompt/);
    assert.doesNotMatch(userPrompt.output, /你是 Jiuwei，WildArrange 的主编排器/);

    const postCompact = await runInjectionHook(projectRoot, {
      hook_event_name: "PostCompact",
      session_id: "session-jiuwei",
      cwd: projectRoot,
    });
    assert.match(postCompact.output, /### Jiuwei 身份 Prompt/);
    assert.match(postCompact.output, /你是 Jiuwei，WildArrange 的主编排器/);
  });
});

test("hook adapter injects dynamic rules after tool use target paths", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    await mkdir(path.join(projectRoot, ".cursor", "rules"), { recursive: true });
    await writeFile(path.join(projectRoot, ".cursor", "rules", "ui.md"), [
      "---",
      "description: UI files need browser verification",
      "globs: [src/**]",
      "---",
      "Run browser verification after UI changes.",
      "",
    ].join("\n"));

    const result = await runInjectionHook(projectRoot, {
      hook_event_name: "PostToolUse",
      session_id: "session-2",
      cwd: projectRoot,
      tool_name: "apply_patch",
      tool_input: { file_path: "src/app.js" },
      tool_response: { ok: true },
    });

    assert.equal(result.pointName, "post_tool_use");
    assert.deepEqual(result.targetPaths, ["src/app.js"]);
    assert.match(result.output, /动态目标/);
    assert.match(result.output, /src\/app\.js/);
    assert.match(result.output, /工具结果门/);
    assert.match(result.output, /决策：pass/);
    assert.match(result.output, /UI files need browser verification/);
    assert.match(result.output, /Run browser verification after UI changes/);
  });
});

test("post-tool-use result gate only reads structured failure fields and writes no ledger", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const patchInput = { command: "*** Begin Patch\n*** Add File: src/error-handler.js\n*** End Patch" };

    // 输出文本里出现 error/timeout 等词不算失败；只有结构化字段才算。
    for (const toolResponse of [
      { exit_code: 0, output: "Success. Updated the following files:\nA src/error-handler.js" },
      { exit_code: "0", output: "Success. Updated the following files:\nA src/timeout-helper.js" },
      "Success. Updated the following files:\nA src/no such file or directory-helper.js",
      { exit_code: 0, stderr: "EPERM: operation not permitted, open 'src/app.js'" },
    ]) {
      const noisy = await renderHook(projectRoot, {
        hook_event_name: "PostToolUse",
        session_id: "session-noisy-patch-success",
        cwd: projectRoot,
        tool_name: "functions.apply_patch",
        tool_input: patchInput,
        tool_response: toolResponse,
      });
      assert.equal(noisy.decision, "pass");
      assert.match(noisy.output, /决策：pass/);
    }

    for (const toolResponse of [
      { exit_code: 1, output: "Failed to apply patch" },
      { exitCode: "7", output: "" },
    ]) {
      const failed = await renderHook(projectRoot, {
        hook_event_name: "PostToolUse",
        session_id: "session-failed-patch",
        cwd: projectRoot,
        tool_name: "functions.apply_patch",
        tool_input: patchInput,
        tool_response: toolResponse,
      });
      assert.equal(failed.decision, "block");
      assert.match(failed.output, /nonzero_exit_code/);
    }

    const explicit = await renderHook(projectRoot, {
      hook_event_name: "PostToolUse",
      session_id: "session-explicit-failure",
      cwd: projectRoot,
      tool_name: "exec_command",
      tool_response: { ok: false },
    });
    assert.equal(explicit.decision, "block");
    assert.match(explicit.output, /explicit_unsuccessful_result/);

    const ledger = await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /hook_result_gate/);
  });
});

test("post-tool-use result gate blocks failed tool evidence", async () => {
  await withExternalProject(async ({ projectRoot }) => {

    const result = await runInjectionHook(projectRoot, {
      hook_event_name: "PostToolUse",
      session_id: "session-failed-tool",
      cwd: projectRoot,
      tool_name: "exec_command",
      tool_response: {
        exitCode: 127,
        stderr: "zsh: command not found: pnpmx",
      },
    });

    assert.equal(result.decision, "block");
    assert.match(result.output, /工具结果门/);
    assert.match(result.output, /决策：block/);
    assert.match(result.output, /nonzero_exit_code/);
  });
});

test("pre-tool-use guard denies out-of-scope file writes before they land", async () => {
  await withExternalProject(async ({ projectRoot, root, governanceRoot }) => {
    const planPath = path.join(root, "plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Scoped edit",
      objective: "Only src/app.js can change.",
      tasks: [{
        id: "T001",
        subject: "Edit app",
        writable_paths: ["src/app.js"],
        responsibilityChanges: declare("src/app.js"),
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }, null, 2));
    await importApprovedPlan(projectRoot, planPath);

    const guard = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-scope",
      cwd: projectRoot,
      taskId: "T001",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: src/other.js\n+export const other = true;\n*** End Patch" },
    });

    assert.equal(guard.decision, "deny");
    assert.deepEqual(guard.deniedPaths, ["src/other.js"]);

    const mixedPatch = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-scope",
      cwd: projectRoot,
      taskId: "T001",
      tool_name: "functions.apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Update File: src/app.js",
          "@@",
          "+export const ok = true;",
          "*** Add File: src/other.js",
          "+export const bypass = true;",
          "*** End Patch",
        ].join("\n"),
      },
    });
    assert.equal(mixedPatch.decision, "deny");
    assert.deepEqual(mixedPatch.targetPaths, ["src/app.js", "src/other.js"]);
    assert.deepEqual(mixedPatch.deniedPaths, ["src/other.js"]);

    const hook = await runInjectionHook(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-scope",
      cwd: projectRoot,
      taskId: "T001",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: src/other.js\n+export const other = true;\n*** End Patch" },
    });
    const output = JSON.parse(hook.output);
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /planned scope violation/);

    await writePolicyConfig(governanceRoot, JSON.stringify({
      injectionPoints: {
        pre_tool_use: { enabled: false },
      },
    }, null, 2));
    const disabledInjectionHook = await runInjectionHook(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-scope-disabled-injection",
      cwd: projectRoot,
      taskId: "T001",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: src/other.js\n+export const other = true;\n*** End Patch" },
    });
    const disabledOutput = JSON.parse(disabledInjectionHook.output);
    assert.equal(disabledInjectionHook.enabled, false);
    assert.equal(disabledOutput.hookSpecificOutput.additionalContext, "");
    assert.equal(disabledOutput.hookSpecificOutput.permissionDecision, "deny");
    assert.match(disabledOutput.hookSpecificOutput.permissionDecisionReason, /planned scope violation/);
  });
});

test("pre-tool-use guard denies file writes when no task exists", async () => {
  await withExternalProject(async ({ projectRoot }) => {

    const hook = await runInjectionHook(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-no-task",
      cwd: projectRoot,
      tool_name: "functions.apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: index.html\n+<main></main>\n*** End Patch" },
    });
    const output = JSON.parse(hook.output);
    assert.equal(hook.decision, "deny");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /no active WildArrange task/);
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8"), /no_active_task/);
  });
});

test("pre-tool-use guard only allows a JSON plan draft before the first task exists", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const draftDir = resolveWildArrangePath(projectRoot, "plan-drafts");

    const decoyOnly = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-plan-draft",
      cwd: projectRoot,
      tool_name: "functions.apply_patch",
      tool_input: {
        file_path: draftDir + "/session-plan.json",
        command: "*** Begin Patch\n*** End Patch",
      },
    });
    assert.equal(decoyOnly.decision, "deny");
    assert.equal(decoyOnly.code, "unresolved_apply_patch_targets");
    assert.deepEqual(decoyOnly.targetPaths, []);

    const realisticPlanPatch = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-plan-draft",
      cwd: projectRoot,
      tool_name: "functions.apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: " + draftDir + "/real-plan.json\n+{}\n*** End Patch" },
    });
    assert.equal(realisticPlanPatch.decision, "allow");
    assert.equal(realisticPlanPatch.code, "plan_draft_write");
    assert.deepEqual(realisticPlanPatch.targetPaths, [path.join(await realpath(resolveWildArrangePath(projectRoot)), "plan-drafts", "real-plan.json")]);

    const nativePatchWithUnifiedLookingContent = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-plan-draft",
      cwd: projectRoot,
      tool_name: "functions.apply_patch",
      tool_input: {
        command: "*** Begin Patch\n*** Add File: " + draftDir + "/content-plan.json\n+{}\n+++ wa-hook-probe.txt\n*** End Patch",
      },
    });
    assert.equal(nativePatchWithUnifiedLookingContent.decision, "allow");
    assert.deepEqual(nativePatchWithUnifiedLookingContent.targetPaths, [path.join(await realpath(resolveWildArrangePath(projectRoot)), "plan-drafts", "content-plan.json")]);

    const unifiedPlanPatch = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-plan-draft",
      cwd: projectRoot,
      tool_name: "functions.apply_patch",
      tool_input: {
        diff: "--- /dev/null\n+++ b/.wildarrange/plan-drafts/unified-plan.json\n@@ -0,0 +1 @@\n+{}",
      },
    });
    // 项目内同名目录不是运行态：写进客户项目必须被拒绝
    assert.equal(unifiedPlanPatch.decision, "deny");
    assert.deepEqual(unifiedPlanPatch.targetPaths, [".wildarrange/plan-drafts/unified-plan.json"]);

    const projectDraftWrite = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-plan-draft",
      cwd: projectRoot,
      tool_name: "Write",
      tool_input: { file_path: path.join(projectRoot, ".wildarrange", "plan-drafts", "s1-plan.json"), content: "{}" },
    });
    assert.equal(projectDraftWrite.decision, "deny");

    const realisticBypassPatch = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-plan-draft",
      cwd: projectRoot,
      tool_name: "functions.apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: wa-hook-probe.txt\n+WA_BYPASS_TEST\n*** End Patch" },
    });
    assert.equal(realisticBypassPatch.decision, "deny");
    assert.equal(realisticBypassPatch.code, "no_active_task");
    assert.deepEqual(realisticBypassPatch.deniedPaths, ["wa-hook-probe.txt"]);

    const unparseablePatch = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-plan-draft",
      cwd: projectRoot,
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** End Patch" },
    });
    assert.equal(unparseablePatch.decision, "deny");
    assert.equal(unparseablePatch.code, "unresolved_apply_patch_targets");

    const denied = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-plan-draft",
      cwd: projectRoot,
      tool_name: "functions.apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: plan.json\n+{}\n*** End Patch" },
    });
    assert.equal(denied.decision, "deny");
    assert.equal(denied.code, "no_active_task");

    const shellDenied = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-plan-draft",
      cwd: projectRoot,
      tool_name: "Bash",
      tool_input: { command: "node -e \"require('fs').writeFileSync('src/unplanned.js','x')\"" },
    });
    assert.equal(shellDenied.decision, "deny");
    assert.equal(shellDenied.code, "no_active_task_shell");

    for (const command of [
      "git status --short --branch",
      "git --no-pager diff --stat",
      "git diff --cached --name-status --no-ext-diff --no-textconv",
      "git rev-parse HEAD",
      "git branch --show-current",
      "git worktree list --porcelain",
      "git ls-files --modified --deleted --others --exclude-standard",
    ]) {
      const readOnlyGit = await preToolUseGuard(projectRoot, {
        hook_event_name: "PreToolUse",
        session_id: "session-plan-draft",
        cwd: projectRoot,
        tool_name: "Bash",
        tool_input: { command },
      });
      assert.equal(readOnlyGit.decision, "allow", command);
      assert.ok(["read_only_operation", "no_file_target"].includes(readOnlyGit.code), command);
    }

    for (const [command, expectedCode] of [
      ["git add src/unplanned.js", "no_active_task_shell"],
      ["git checkout -- src/unplanned.js", "no_active_task_shell"],
      ["git reset --hard", "high_risk_command"],
      ["git clean -fd", "high_risk_command"],
      ["git status --short && node -e \"process.exit(1)\"", "no_active_task_shell"],
      ["git diff --output=diff.txt", "no_active_task_shell"],
      ["git diff --ext-diff", "no_active_task_shell"],
      ["git diff --textconv", "no_active_task_shell"],
      ["git log --oneline", "no_active_task_shell"],
      ["git show HEAD", "no_active_task_shell"],
      ["git -c core.pager=evil status", "no_active_task_shell"],
    ]) {
      const unsafeGit = await preToolUseGuard(projectRoot, {
        hook_event_name: "PreToolUse",
        session_id: "session-plan-draft",
        cwd: projectRoot,
        tool_name: "Bash",
        tool_input: { command },
      });
      assert.equal(unsafeGit.decision, "deny", command);
      assert.equal(unsafeGit.code, expectedCode, command);
    }

    const planImportAllowed = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-plan-draft",
      cwd: projectRoot,
      tool_name: "Bash",
      tool_input: { command: "node ./bin/wildarrange.mjs plan --from " + draftDir + "/session-plan.json" },
    });
    assert.equal(planImportAllowed.decision, "allow");
    assert.equal(planImportAllowed.code, "no_file_target");

    const chainedCommandDenied = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-plan-draft",
      cwd: projectRoot,
      tool_name: "Bash",
      tool_input: { command: "node ./bin/wildarrange.mjs status && node -e \"require('fs').writeFileSync('src/bypass.js','x')\"" },
    });
    assert.equal(chainedCommandDenied.decision, "deny");
    assert.equal(chainedCommandDenied.code, "no_active_task_shell");

    for (const command of [
      "node ./bin/wildarrange.mjs resume",
      "node ./bin/wildarrange.mjs resume --session recovery-1",
      "node ./bin/wildarrange.mjs continuation check",
      "node ./bin/wildarrange.mjs changes list",
      "node ./bin/wildarrange.mjs config show",
      "node ./bin/wildarrange.mjs prompts show --skill debugging",
    ]) {
      const controlCommand = await preToolUseGuard(projectRoot, {
        hook_event_name: "PreToolUse",
        session_id: "session-plan-draft",
        cwd: projectRoot,
        tool_name: "Bash",
        tool_input: { command },
      });
      assert.equal(controlCommand.decision, "allow", command);
      assert.equal(controlCommand.code, "no_file_target", command);
    }

    const chainedPromptCommand = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-plan-draft",
      cwd: projectRoot,
      tool_name: "Bash",
      tool_input: { command: "node ./bin/wildarrange.mjs prompts show --skill debugging && node -e \"process.exit(1)\"" },
    });
    assert.equal(chainedPromptCommand.decision, "deny");
    assert.equal(chainedPromptCommand.code, "no_active_task_shell");

    const untrustedPrefixDenied = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "session-plan-draft",
      cwd: projectRoot,
      tool_name: "Bash",
      cli_command_prefix: "node attacker.js",
      tool_input: { command: "node attacker.js status" },
    });
    assert.equal(untrustedPrefixDenied.decision, "deny");
    assert.equal(untrustedPrefixDenied.code, "no_active_task_shell");
  });
});

test("hook injection demotes unmatched skills to on-demand references", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const result = await runInjectionHook(projectRoot, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-ondemand",
      cwd: projectRoot,
      prompt: "zzqq xylophone quux",
    });
    assert.match(result.output, /wildarrange-injection-runtime/);
    assert.match(result.output, /按需可加载 Skill/);
    assert.match(result.output, /prompts show --skill/);
    // 与请求无关的技能必须降级为引用，不注入全文
    assert.doesNotMatch(result.output, /### review-work\n/);
    assert.match(result.output, /- review-work（与本次请求未匹配）/);
  });
});
