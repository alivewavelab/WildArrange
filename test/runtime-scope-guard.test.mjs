// =============================================================================
// 文件名称：runtime-scope-guard.test.mjs
// 所属模块：test
// 作用说明：
//   范围守卫：git/manifest/symlink 越界检测、ChangeRequest、路径匹配纯函数。
// =============================================================================

import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { runNextTask, runWorkflowNode } from "../src/orchestration/linear-runtime.mjs";
import { listChangeRequests, resolveChangeRequest, reviewChangeRequest } from "../src/orchestration/change-governance.mjs";
import { statusReport } from "../src/orchestration/status.mjs";
import { scopeGuard } from "../src/capabilities/scope-guard.mjs";
import { classifyManifestPathChanges } from "../src/infra/git-diff.mjs";
import { pathAllowed } from "../src/infra/path-match.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withTempDir, installDocumentReviewerFixture, initializeGitFixture, nodeEval } from "./helpers/runtime-fixtures.mjs";

test("runNextTask fails when automatic scope guard finds out-of-scope worker changes", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await initializeGitFixture(dir);

    const planPath = resolveWildArrangePath(dir, "artifacts", "out-of-scope-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Out of scope work",
      tasks: [{
        id: "T001",
        subject: "Only src allowed",
        writable_paths: ["src/**"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('docs',{recursive:true}); fs.writeFileSync('docs/leak.md','bad')\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.equal(result.scopeResult.status, "fail");
    assert.deepEqual(result.scopeResult.deniedPaths, ["docs/leak.md"]);

    const state = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "failed");
    assert.equal(state.tasks[0].last_failure.reason, "scope_guard_failed");
    assert.match(state.tasks[0].last_failure.retryHint, /ChangeRequest/);
    assert.ok(state.tasks[0].last_change_request.id.startsWith("CR-"));
    assert.deepEqual(state.tasks[0].last_change_request.deniedPaths, ["docs/leak.md"]);

    const changes = await listChangeRequests(dir);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].id, state.tasks[0].last_change_request.id);
    assert.equal(changes[0].status, "open");
    assert.equal(changes[0].invariants.autoApply, false);
    assert.match(await readFile(resolveWildArrangePath(dir, "changes", "open.md"), "utf8"), /docs\/leak\.md/);

    const retry = await runWorkflowNode(dir, "retry", { taskId: "T001" });
    assert.equal(retry.status, "change_request_required");
    assert.equal(retry.changeRequest.id, state.tasks[0].last_change_request.id);
    const afterRetry = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
    assert.equal(afterRetry.tasks[0].status, "failed");
    assert.match(await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8"), /scope_guard_failed/);
    assert.match(await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8"), /node_retry_blocked/);
    assert.match(await readFile(resolveWildArrangePath(dir, "reports", "failures", state.planId, "T001.md"), "utf8"), /ChangeRequest/);
  });
});

test("non-git projects use file manifest scope fallback before checkpoint", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);

    const planPath = resolveWildArrangePath(dir, "artifacts", "non-git-scope-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Non git scope",
      tasks: [{
        id: "T001",
        subject: "Only src allowed without git",
        writable_paths: ["src/**"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('docs',{recursive:true}); fs.writeFileSync('docs/leak.md','bad')\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.equal(result.scopeResult.status, "fail");
    assert.deepEqual(result.scopeResult.deniedPaths, ["docs/leak.md"]);
    assert.equal(result.task.last_failure.reason, "scope_guard_failed");
  });
});

test("accepted change request can explicitly apply scope and reopen retry", async () => {
  await withTempDir(async (dir) => {
    await installDocumentReviewerFixture(dir);
    await initRuntime(dir);
    await initializeGitFixture(dir);

    const planPath = resolveWildArrangePath(dir, "artifacts", "accepted-change-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Accepted scope change",
      tasks: [{
        id: "T001",
        subject: "Allow docs only after review",
        writable_paths: ["src/**"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('docs',{recursive:true}); fs.writeFileSync('docs/leak.md','accepted')\"",
        verify_commands: ["node -e \"const fs=require('fs'); if(fs.readFileSync('docs/leak.md','utf8')!=='accepted') process.exit(1)\""],
        review_commands: [nodeEval("const fs=require('fs');const stat=fs.statSync('docs/leak.md');if(!stat.isFile()||stat.size!==8)process.exit(1)")],
      }],
    }));
    await importPlan(dir, planPath);

    const failed = await runNextTask(dir);
    assert.equal(failed.status, "failed");
    const changeRequestId = failed.task.last_change_request.id;

    const review = await reviewChangeRequest(dir, changeRequestId);
    assert.equal(review.status, "reviewable");
    assert.deepEqual(review.allowedDecisions, ["accept", "reject"]);

    const resolved = await resolveChangeRequest(dir, {
      id: changeRequestId,
      decision: "accept",
      evidence: "docs/leak.md is part of the accepted task output after Jiuwei review",
      rationale: "The task objective needs this artifact and verification remains unchanged",
      applyScope: true,
    });
    assert.equal(resolved.status, "accepted");
    assert.equal(resolved.changeRequest.appliedScope, true);
    assert.ok(resolved.task.writable_paths.includes("docs/leak.md"));

    const retry = await runWorkflowNode(dir, "retry", { taskId: "T001" });
    assert.equal(retry.status, "pending");

    const completed = await runNextTask(dir);
    assert.equal(completed.status, "completed");
    assert.equal(completed.scopeResult.status, "pass");

    const changes = await listChangeRequests(dir);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].status, "accepted");
    assert.equal((await statusReport(dir)).openChanges, 0);
    assert.match(await readFile(resolveWildArrangePath(dir, "changes", `${changeRequestId}.md`), "utf8"), /Decision/);
    assert.match(await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8"), /change_request_resolved/);
  });
});

test("scope guard checks git changed paths against task writable paths", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = resolveWildArrangePath(dir, "artifacts", "scope-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Scoped work",
      tasks: [{
        id: "T001",
        subject: "Only touch src",
        writable_paths: ["src/**"],
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importPlan(dir, planPath);

    await initializeGitFixture(dir);

    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "ok.js"), "export const ok = true;\n");

    const pass = await scopeGuard(dir, { taskId: "T001" });
    assert.equal(pass.status, "pass");
    assert.deepEqual(pass.deniedPaths, []);

    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "docs", "plan.md"), "# out of scope\n");

    const fail = await scopeGuard(dir, { taskId: "T001" });
    assert.equal(fail.status, "fail");
    assert.deepEqual(fail.deniedPaths, ["docs/plan.md"]);

    const ledger = await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8");
    assert.match(ledger, /scope_guard_passed/);
    assert.match(ledger, /scope_guard_failed/);
  });
});

test("scope guard rejects symlink realpaths that escape the project", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const outsidePath = path.join(path.dirname(dir), "outside-scope.txt");
    await writeFile(outsidePath, "secret\n");
    await symlink(outsidePath, path.join(dir, "allowed-link.txt"));
    const planPath = path.join(dir, "symlink-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Symlink scope",
      tasks: [{
        id: "T001",
        subject: "Reject symlink escape",
        writable_paths: ["allowed-link.txt"],
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importPlan(dir, planPath);

    const result = await scopeGuard(dir, { taskId: "T001", changedPaths: ["allowed-link.txt"] });
    assert.equal(result.status, "fail");
    assert.match(result.deniedPaths[0], /allowed-link\.txt -> /);
    await rm(outsidePath, { force: true });
  });
});

test("pathAllowed supports exact paths, directories, globs, and empty scopes", () => {
  assert.equal(pathAllowed("src/index.js", ["src/**"]), true);
  assert.equal(pathAllowed("src/index.js", ["src"]), true);
  assert.equal(pathAllowed("README.md", ["README.md"]), true);
  assert.equal(pathAllowed("test/core.test.mjs", ["test/*.mjs"]), true);
  assert.equal(pathAllowed("src/example.mjs", ["src/**/*.mjs"]), true);
  assert.equal(pathAllowed("src/infra/example.mjs", ["src/**/*.mjs"]), true);
  assert.equal(pathAllowed("src/index.js.map", ["src/index.js"]), false);
  assert.equal(pathAllowed("docs/plan.md", ["src/**"]), false);
  assert.equal(pathAllowed("src/index.js", []), false);
});

test("pathAllowed folds dot segments and rejects .. escapes and absolute paths", () => {
  // escaping/absolute inputs are denied even against permissive scopes
  assert.equal(pathAllowed("src/../.wildarrange/ledger.jsonl", ["src/**"]), false);
  assert.equal(pathAllowed("../outside.txt", ["**"]), false);
  assert.equal(pathAllowed("src/../../outside.txt", ["src/**", "**"]), false);
  assert.equal(pathAllowed("/etc/passwd", ["**"]), false);
  assert.equal(pathAllowed("C:/Windows/system.ini", ["**"]), false);
  assert.equal(pathAllowed("\\\\server\\share\\file.txt", ["**"]), false);
  // escaping/absolute patterns never match
  assert.equal(pathAllowed("src/index.js", ["../**"]), false);
  assert.equal(pathAllowed("src/index.js", ["/abs/**"]), false);
  // legitimate relative paths and ** globs are unaffected
  assert.equal(pathAllowed("src/./index.js", ["src/**"]), true);
  assert.equal(pathAllowed("src/lib/../index.js", ["src/**"]), true);
  assert.equal(pathAllowed("src/infra/example.mjs", ["src/**/*.mjs"]), true);
  assert.equal(pathAllowed("src/index.js", ["**"]), true);
});

test("manifest change classification covers added, deleted, and modified files", () => {
  assert.deepEqual(classifyManifestPathChanges(
    {
      "src/deleted.js": "10:1",
      "src/modified.js": "10:1",
      "src/same.js": "10:1",
    },
    {
      "src/added.js": "10:1",
      "src/modified.js": "12:2",
      "src/same.js": "10:1",
    },
  ), [
    { path: "src/added.js", status: "added" },
    { path: "src/deleted.js", status: "deleted" },
    { path: "src/modified.js", status: "modified" },
  ]);
});
