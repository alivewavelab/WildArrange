// =============================================================================
// 文件名称：state-archive-restore.test.mjs
// 所属模块：test
// 作用说明：
//   验证外置运行态的状态持久化：未来 schema 拒绝、治理配置权威覆盖 runtime 键、
//   无 proof chain 的 completed 拒绝、归档删除与备份恢复。
//   不测：在线零停机升级或远程 sync。
//
// 【运行原理速读】
//   写入 tasks/config fixture，调用 archive / restore / statusReport，
//   断言 doctor/status 拒绝原因与恢复结果。
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { access, appendFile, chmod, lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveGovernancePaths, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { loadWildArrangeConfig } from "../src/infra/runtime-config.mjs";
import { restoreRuntimeStateBackup, writeRuntimeStateBackup } from "../src/infra/state-backup.mjs";
import { loadTaskLedger } from "../src/infra/task-state-store.mjs";
import { appendLedger } from "../src/infra/ledger.mjs";
import { writeRuntimeContextSnapshot } from "../src/infra/runtime-snapshot.mjs";
import { runDoctor } from "../src/interface/doctor.mjs";
import { archiveAndDeleteTeamTask } from "../src/orchestration/task-archive.mjs";
import { statusReport, writeWorkflowSummary } from "../src/orchestration/status.mjs";
import { withExternalProject } from "./helpers/external-fixture.mjs";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** 运行态文件相对项目根的 POSIX 路径；外置运行态位于项目之外，形如 ../state-home/...。 */
function runtimeRelative(dir, ...segments) {
  return path.relative(dir, resolveWildArrangePath(dir, ...segments)).replaceAll("\\", "/");
}

function legacyTask(status = "completed") {
  return {
    id: "T001",
    subject: "Legacy task",
    description: "Old task state",
    status,
    owner: "Jiuwei",
    attempts: 1,
    blockedBy: [],
    writable_paths: ["src/output.txt"],
    verify_commands: ["node --test"],
    review_commands: [],
    standards_commands: [],
    evidence: [],
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:01:00.000Z",
  };
}

test("task ledger rejects future schema versions", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 99,
      kind: "task_ledger",
      activePlanId: "P1",
      tasks: [],
    });
    await assert.rejects(() => loadTaskLedger(dir), /newer than supported version/);
  });
});

test("governance config is authoritative over stale runtime-only keys", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const governance = resolveGovernancePaths(dir);
    const governanceConfig = path.join(governance.rootDir, governance.configPath);
    await writeJson(resolveWildArrangePath(dir, "config.json"), {
      runtime: "wildarrange-linear",
      legacyOnly: { enabled: true },
    });
    await writeJson(governanceConfig, {
      reporting: { verbosity: "normal" },
    });
    const loaded = await loadWildArrangeConfig(dir);
    assert.equal(loaded.sourcePath, path.relative(dir, governanceConfig));
    assert.equal(loaded.config.runtime, "wildarrange-linear");
    assert.equal(loaded.config.reporting.verbosity, "normal");
    assert.equal(loaded.config.legacyOnly, undefined);
  });
});

test("status and summary reject completed state without the current proof chain", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const task = {
      ...legacyTask("completed"),
      owner: "Jiuwei",
      planId: "P1",
      ref: "P1:T001",
      history: [{ at: "2026-08-24T00:00:00.000Z", event: "status_changed", to: "completed" }],
    };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Current plan", objective: "Reject fake green", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(resolveWildArrangePath(dir, "work.json"), { activePlanId: "P1", status: "ready" });

    const status = await statusReport(dir);
    assert.equal(status.completed, 1);
    assert.equal(status.invalidCompleted, 1);
    assert.deepEqual(status.completionIntegrity.invalid[0].failures.sort(), [
      "acceptance_proof",
      "checkpoint_identity",
      "delivery_commit_missing",
      "ledger_event",
      "review",
      "scope",
      "verifier",
    ]);
    const summary = await writeWorkflowSummary(dir, { reason: "test" });
    assert.equal(summary.ok, false);
    await appendFile(resolveWildArrangePath(dir, "ledger.jsonl"), `${JSON.stringify({ type: "forged_completion" })}\n`, "utf8");
    const context = await writeRuntimeContextSnapshot(dir);
    assert.equal(context.status.invalidCompleted, 1);
    assert.equal(context.ledgerIntegrity.ok, false);
    assert.ok(!context.ledgerTail.some((entry) => entry.type === "forged_completion"));
    const doctor = await runDoctor(dir);
    assert.ok(doctor.findings.some((finding) => finding.section === "completion_audit" && finding.taskId === "T001"));
  });
});

test("status doctor and context agree when proof and checkpoint delivery SHAs diverge", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const planId = "P-SHA";
    const task = {
      ...legacyTask("completed"),
      planId,
      ref: `${planId}:T001`,
      history: [{ at: "2026-09-10T00:00:00.000Z", event: "completed", status: "completed" }],
      delivery: { active: true, status: "committed_local", integrationSha: "a".repeat(40) },
    };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId,
      activePlanId: planId,
      plans: [{ id: planId, taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(resolveWildArrangePath(dir, "work.json"), { activePlanId: planId, status: "ready" });
    await writeJson(resolveWildArrangePath(dir, "reports", "acceptance", planId, "T001.json"), {
      kind: "acceptance_proof",
      planId,
      taskId: "T001",
      pass: true,
      evidenceRefs: { deliveryBaseline: { status: "committed_local", commitSha: "b".repeat(40) } },
    });
    await writeJson(resolveWildArrangePath(dir, "checkpoints", planId, "T001.json"), {
      planId,
      taskId: "T001",
      verifyResult: { pass: true },
      scopeResult: { status: "pass" },
      reviewResult: { pass: true },
      deliveryBaseline: { active: true, status: "committed_local", integrationSha: "a".repeat(40) },
    });
    await appendLedger(dir, { type: "node_checkpoint_completed", planId, taskId: "T001" });

    const status = await statusReport(dir);
    const context = await writeRuntimeContextSnapshot(dir);
    const doctor = await runDoctor(dir);
    assert.deepEqual(status.completionIntegrity.invalid[0].failures, ["delivery_commit_mismatch"]);
    assert.deepEqual(context.status.completionIntegrity.invalid[0].failures, ["delivery_commit_mismatch"]);
    assert.ok(doctor.findings.some((finding) => finding.taskId === "T001" && finding.failures?.includes("delivery_commit_mismatch")));
  });
});

test("Git completed evidence requires matching 40-character commit SHAs", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const planId = "P-GIT-SHA";
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId,
      activePlanId: planId,
      plans: [{ id: planId, taskIds: ["T001"] }],
      tasks: [{
        ...legacyTask("completed"),
        planId,
        ref: `${planId}:T001`,
        history: [{ at: "2026-09-10T00:00:00.000Z", event: "completed", status: "completed" }],
      }],
    });
    await writeJson(resolveWildArrangePath(dir, "work.json"), { activePlanId: planId, status: "ready" });
    const proofPath = resolveWildArrangePath(dir, "reports", "acceptance", planId, "T001.json");
    const checkpointPath = resolveWildArrangePath(dir, "checkpoints", planId, "T001.json");
    const proof = { kind: "acceptance_proof", planId, taskId: "T001", pass: true, evidenceRefs: {} };
    const checkpoint = {
      planId,
      taskId: "T001",
      verifyResult: { pass: true },
      scopeResult: { status: "pass" },
      reviewResult: { pass: true },
    };
    await writeJson(proofPath, proof);
    await writeJson(checkpointPath, checkpoint);
    await appendLedger(dir, { type: "node_checkpoint_completed", planId, taskId: "T001" });

    const missing = await statusReport(dir);
    assert.deepEqual(missing.completionIntegrity.invalid[0].failures, ["delivery_commit_missing"]);

    proof.evidenceRefs.deliveryBaseline = { status: "committed_local", commitSha: "not-a-git-sha" };
    checkpoint.deliveryBaseline = { status: "committed_local", commitSha: "not-a-git-sha" };
    await writeJson(proofPath, proof);
    await writeJson(checkpointPath, checkpoint);
    const malformed = await statusReport(dir);
    assert.deepEqual(malformed.completionIntegrity.invalid[0].failures, [
      "delivery_commit_invalid",
      "delivery_commit_missing",
    ]);

    const deliverySha = "c".repeat(40);
    const taskLedger = JSON.parse(await readFile(resolveWildArrangePath(dir, "team", "tasks.json"), "utf8"));
    taskLedger.tasks[0].delivery_workspace = { deliverySha };
    proof.evidenceRefs.deliveryBaseline = { status: "committed_local", commitSha: deliverySha };
    checkpoint.deliveryBaseline = { status: "committed_local", commitSha: deliverySha };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), taskLedger);
    await writeJson(proofPath, proof);
    await writeJson(checkpointPath, checkpoint);
    const validWorkspaceShape = await statusReport(dir);
    assert.equal(validWorkspaceShape.invalidCompleted, 0);
  });
});

test("archive delete leaves a ledger tombstone and removes only the target task artifacts", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const task = {
      ...legacyTask("needs_user_decision"),
      owner: "Jiuwei",
      planId: "P1",
      ref: "P1:T001",
      history: [{ at: "2026-08-24T00:00:00.000Z", event: "created" }],
      writable_paths: [runtimeRelative(dir, "artifacts", "linear-smoke.txt"), "src/**"],
    };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Legacy", objective: "Remove it", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(resolveWildArrangePath(dir, "plans", "P1.json"), { id: "P1", title: "Legacy", objective: "Remove it", tasks: [task] });
    await writeJson(resolveWildArrangePath(dir, "work.json"), {
      activePlanId: "P1",
      status: "ready",
      stage: "planned",
      planApproval: { required: true, status: "approved", planId: "P1" },
    });
    await writeJson(resolveWildArrangePath(dir, "checkpoints", "P1", "T001.json"), { planId: "P1", taskId: "T001" });
    await writeJson(resolveWildArrangePath(dir, "checkpoints", "P2", "T001.json"), { planId: "P2", taskId: "T001" });
    await mkdir(resolveWildArrangePath(dir, "artifacts"), { recursive: true });
    await writeFile(resolveWildArrangePath(dir, "artifacts", "linear-smoke.txt"), "ok\n", "utf8");
    await writeJson(resolveWildArrangePath(dir, "team", "outbox", "T001-current.json"), { taskId: "T001", taskRef: "P1:T001", planId: "P1" });
    await writeJson(resolveWildArrangePath(dir, "team", "outbox", "T002-keep.json"), { taskId: "T002", taskRef: "P2:T002", planId: "P2" });

    const backup = await writeRuntimeStateBackup(dir, { reason: "before_archive_test" });
    const result = await archiveAndDeleteTeamTask(dir, {
      taskId: "T001",
      planId: "P1",
      reason: "obsolete_smoke_task",
      backupId: backup.backupId,
    });

    assert.equal(result.status, "deleted");
    assert.equal(result.activePlanId, null);
    const ledger = JSON.parse(await readFile(resolveWildArrangePath(dir, "team", "tasks.json"), "utf8"));
    assert.deepEqual(ledger.tasks, []);
    assert.deepEqual(ledger.plans, []);
    const work = JSON.parse(await readFile(resolveWildArrangePath(dir, "work.json"), "utf8"));
    assert.equal(work.status, "idle");
    assert.equal(work.planApproval, null);
    await assert.rejects(access(resolveWildArrangePath(dir, "plans", "P1.json")), /ENOENT/);
    await assert.rejects(access(resolveWildArrangePath(dir, "checkpoints", "P1", "T001.json")), /ENOENT/);
    await assert.rejects(access(resolveWildArrangePath(dir, "artifacts", "linear-smoke.txt")), /ENOENT/);
    await assert.rejects(access(resolveWildArrangePath(dir, "team", "outbox", "T001-current.json")), /ENOENT/);
    await access(resolveWildArrangePath(dir, "team", "outbox", "T002-keep.json"));
    assert.ok(result.deletedPaths.includes(runtimeRelative(dir, "team", "outbox", "T001-current.json")));
    await access(resolveWildArrangePath(dir, "checkpoints", "P2", "T001.json"));
    const audit = await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8");
    assert.match(audit, /team_task_archive_requested/);
    assert.match(audit, /team_task_archived_deleted/);
    assert.match(audit, new RegExp(backup.backupId));
  });
});

test("archive delete preserves ambiguous legacy DoneClaims when another Plan reuses the task id", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const first = { ...legacyTask("pending"), planId: "P1", ref: "P1:T001" };
    const second = { ...legacyTask("pending"), planId: "P2", ref: "P2:T001" };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [
        { id: "P1", title: "First", taskIds: ["T001"] },
        { id: "P2", title: "Second", taskIds: ["T001"] },
      ],
      tasks: [first, second],
    });
    await writeJson(resolveWildArrangePath(dir, "plans", "P1.json"), { id: "P1", tasks: [first] });
    await writeJson(resolveWildArrangePath(dir, "plans", "P2.json"), { id: "P2", tasks: [second] });
    await writeJson(resolveWildArrangePath(dir, "team", "outbox", "T001-legacy.json"), { taskId: "T001" });
    await writeJson(resolveWildArrangePath(dir, "team", "outbox", "T001-P1.json"), { taskId: "T001", taskRef: "P1:T001" });
    await writeJson(resolveWildArrangePath(dir, "team", "outbox", "T001-P2.json"), { taskId: "T001", taskRef: "P2:T001" });

    await archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P1", reason: "remove_first" });

    await assert.rejects(access(resolveWildArrangePath(dir, "team", "outbox", "T001-P1.json")), /ENOENT/);
    await access(resolveWildArrangePath(dir, "team", "outbox", "T001-P2.json"));
    await access(resolveWildArrangePath(dir, "team", "outbox", "T001-legacy.json"));
  });
});

test("archive delete rejects unsafe plan ids before resolving plan paths", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      activePlanId: null,
      plans: [],
      tasks: [],
    });
    const sentinelPath = path.join(dir, "sentinel.json");
    await writeJson(sentinelPath, { keep: true, tasks: [legacyTask()] });

    await assert.rejects(
      archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "../../sentinel", reason: "attack" }),
      /safe single-segment identifier/,
    );

    assert.deepEqual(JSON.parse(await readFile(sentinelPath, "utf8")), { keep: true, tasks: [legacyTask()] });
    const ledger = JSON.parse(await readFile(resolveWildArrangePath(dir, "team", "tasks.json"), "utf8"));
    assert.deepEqual(ledger.tasks, []);
  });
});

test("archive delete with an explicit Plan never falls back to a unique task in another Plan", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const task = { ...legacyTask("pending"), planId: "P1", ref: "P1:T001" };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Only", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(resolveWildArrangePath(dir, "plans", "P1.json"), { id: "P1", title: "Only", tasks: [task] });

    await assert.rejects(
      archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P2", reason: "typo" }),
      /unknown task/,
    );

    const ledger = JSON.parse(await readFile(resolveWildArrangePath(dir, "team", "tasks.json"), "utf8"));
    assert.deepEqual(ledger.tasks.map((candidate) => candidate.ref), ["P1:T001"]);
    await access(resolveWildArrangePath(dir, "plans", "P1.json"));
  });
});

test("archive delete fails before canonical mutation when an unrelated DoneClaim is corrupt", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const task = { ...legacyTask("pending"), planId: "P1", ref: "P1:T001" };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Current", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(resolveWildArrangePath(dir, "plans", "P1.json"), { id: "P1", title: "Current", tasks: [task] });
    await writeJson(resolveWildArrangePath(dir, "checkpoints", "P1", "T001.json"), { taskId: "T001" });
    const corruptClaimPath = resolveWildArrangePath(dir, "team", "outbox", "T999-corrupt.json");
    await mkdir(path.dirname(corruptClaimPath), { recursive: true });
    await writeFile(corruptClaimPath, "{not-json", "utf8");

    await assert.rejects(
      archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P1", reason: "corrupt_outbox" }),
      /JSON/,
    );

    const ledger = JSON.parse(await readFile(resolveWildArrangePath(dir, "team", "tasks.json"), "utf8"));
    assert.deepEqual(ledger.tasks.map((candidate) => candidate.ref), ["P1:T001"]);
    assert.deepEqual(ledger.plans.find((plan) => plan.id === "P1").taskIds, ["T001"]);
    await access(resolveWildArrangePath(dir, "checkpoints", "P1", "T001.json"));
  });
});

test("archive delete rolls back staged files and Plan mirror when tasks markdown cannot be written", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const removed = { ...legacyTask("pending"), planId: "P1", ref: "P1:T001" };
    const kept = { ...legacyTask("pending"), id: "T002", subject: "Keep", planId: "P1", ref: "P1:T002" };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Current", taskIds: ["T001", "T002"] }],
      tasks: [removed, kept],
    });
    await writeJson(resolveWildArrangePath(dir, "plans", "P1.json"), {
      id: "P1",
      title: "Current",
      tasks: [removed, kept],
    });
    const checkpointPath = resolveWildArrangePath(dir, "checkpoints", "P1", "T001.json");
    await writeJson(checkpointPath, { taskId: "T001" });
    const lockedMarkdown = path.join(dir, "locked-tasks.md");
    await writeFile(lockedMarkdown, "original markdown\n", "utf8");
    await chmod(lockedMarkdown, 0o444);
    const tasksMarkdownPath = resolveWildArrangePath(dir, "team", "tasks.md");
    await symlink(lockedMarkdown, tasksMarkdownPath);

    await assert.rejects(
      archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P1", reason: "mirror_failure" }),
      /EACCES|permission denied|recovery_required/,
    );

    const ledger = JSON.parse(await readFile(resolveWildArrangePath(dir, "team", "tasks.json"), "utf8"));
    assert.deepEqual(ledger.tasks.map((task) => task.ref), ["P1:T001", "P1:T002"]);
    assert.deepEqual(ledger.plans.find((plan) => plan.id === "P1").taskIds, ["T001", "T002"]);
    await access(resolveWildArrangePath(dir, "plans", "P1.json"));
    await access(checkpointPath);
    assert.equal(await readFile(lockedMarkdown, "utf8"), "original markdown\n");
    const backupIds = await readdir(resolveWildArrangePath(dir, "backups"));
    assert.equal(backupIds.length, 1);
    const recoveryManifest = JSON.parse(await readFile(
      resolveWildArrangePath(dir, "backups", backupIds[0], "manifest.json"),
      "utf8",
    ));
    assert.equal(recoveryManifest.archivePackages.length, 1);
    assert.equal(recoveryManifest.archivePackages[0].status, "recovery_required");
    assert.match(recoveryManifest.archivePackages[0].stagingPath, /archive-staging/);
    await chmod(lockedMarkdown, 0o644);
  });
});

test("archive delete synchronizes a non-active Plan mirror and leaves active tasks markdown active-only", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const active = { ...legacyTask("pending"), id: "T100", subject: "Active task", planId: "P1", ref: "P1:T100" };
    const removed = { ...legacyTask("pending"), subject: "Remove from background", planId: "P2", ref: "P2:T001" };
    const kept = { ...legacyTask("pending"), id: "T002", subject: "Keep in background", planId: "P2", ref: "P2:T002" };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [
        { id: "P1", title: "Active", taskIds: ["T100"] },
        { id: "P2", title: "Background", taskIds: ["T001", "T002"] },
      ],
      tasks: [active, removed, kept],
    });
    await writeJson(resolveWildArrangePath(dir, "plans", "P1.json"), { id: "P1", title: "Active", tasks: [active] });
    await writeJson(resolveWildArrangePath(dir, "plans", "P2.json"), { id: "P2", title: "Background", tasks: [removed, kept] });

    const result = await archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P2", reason: "background_cleanup" });

    assert.equal(result.activePlanId, "P1");
    const ledger = JSON.parse(await readFile(resolveWildArrangePath(dir, "team", "tasks.json"), "utf8"));
    assert.deepEqual(ledger.plans.find((plan) => plan.id === "P2").taskIds, ["T002"]);
    assert.deepEqual(ledger.tasks.filter((task) => task.planId === "P2").map((task) => task.ref), ["P2:T002"]);
    const markdown = await readFile(resolveWildArrangePath(dir, "team", "tasks.md"), "utf8");
    assert.match(markdown, /Active task/);
    assert.doesNotMatch(markdown, /Keep in background|Remove from background/);
  });
});

test("archive delete of the active Plan's final task does not auto-activate another Plan", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const removed = { ...legacyTask("pending"), planId: "P1", ref: "P1:T001" };
    const waiting = { ...legacyTask("pending"), id: "T002", subject: "Needs explicit activation", planId: "P2", ref: "P2:T002" };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [
        { id: "P1", title: "Current", taskIds: ["T001"] },
        { id: "P2", title: "Waiting", taskIds: ["T002"] },
      ],
      tasks: [removed, waiting],
    });
    await writeJson(resolveWildArrangePath(dir, "plans", "P1.json"), { id: "P1", title: "Current", tasks: [removed] });
    await writeJson(resolveWildArrangePath(dir, "plans", "P2.json"), { id: "P2", title: "Waiting", tasks: [waiting] });
    await writeJson(resolveWildArrangePath(dir, "work.json"), {
      activePlanId: "P1",
      status: "complete",
      stage: "completed",
      planApproval: { required: true, status: "approved", planId: "P1" },
    });

    const result = await archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P1", reason: "finish_cleanup" });

    assert.equal(result.activePlanId, null);
    const ledger = JSON.parse(await readFile(resolveWildArrangePath(dir, "team", "tasks.json"), "utf8"));
    assert.equal(ledger.activePlanId, null);
    assert.equal(ledger.planId, null);
    assert.deepEqual(ledger.plans.map((plan) => plan.id), ["P2"]);
    assert.deepEqual(ledger.tasks.map((task) => task.ref), ["P2:T002"]);
    const work = JSON.parse(await readFile(resolveWildArrangePath(dir, "work.json"), "utf8"));
    assert.equal(work.activePlanId, null);
    assert.equal(work.status, "idle");
    assert.equal(work.stage, "initialized");
    assert.equal(work.planApproval, null);
    assert.match(await readFile(resolveWildArrangePath(dir, "team", "tasks.md"), "utf8"), /No active tasks/);
    await access(resolveWildArrangePath(dir, "plans", "P2.json"));
  });
});

test("archive delete removes an exact artifact directory as one recoverable staged unit", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const task = {
      ...legacyTask("pending"),
      planId: "P1",
      ref: "P1:T001",
      writable_paths: [runtimeRelative(dir, "artifacts", "P1-T001")],
    };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Artifacts", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(resolveWildArrangePath(dir, "plans", "P1.json"), { id: "P1", title: "Artifacts", tasks: [task] });
    const artifactFile = resolveWildArrangePath(dir, "artifacts", "P1-T001", "nested", "result.json");
    await writeJson(artifactFile, { ok: true });

    const result = await archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P1", reason: "artifact_cleanup" });

    await assert.rejects(access(resolveWildArrangePath(dir, "artifacts", "P1-T001")), /ENOENT/);
    assert.ok(result.deletedPaths.includes(runtimeRelative(dir, "artifacts", "P1-T001")));
  });
});

test("archive delete fails closed on duplicate or corrupted canonical task identities", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const task = { ...legacyTask("pending"), planId: "P1", ref: "P1:T001" };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Broken", taskIds: ["T001", "T001"] }],
      tasks: [task, { ...task, subject: "Duplicate identity" }],
    });
    await writeJson(resolveWildArrangePath(dir, "plans", "P1.json"), { id: "P1", tasks: [task, task] });

    await assert.rejects(
      archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P1", reason: "must_not_mass_delete" }),
      /duplicate canonical task identity/,
    );

    const ledger = JSON.parse(await readFile(resolveWildArrangePath(dir, "team", "tasks.json"), "utf8"));
    assert.equal(ledger.tasks.length, 2);
    assert.deepEqual(ledger.tasks.map((candidate) => candidate.ref), ["P1:T001", "P1:T001"]);
  });

  await withExternalProject(async ({ projectRoot: dir }) => {
    const task = { ...legacyTask("pending"), planId: "P1", ref: "P2:T001" };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Broken ref", taskIds: ["T001"] }],
      tasks: [task],
    });

    await assert.rejects(
      archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P1", reason: "must_not_follow_bad_ref" }),
      /invalid canonical task identity/,
    );
    const ledger = JSON.parse(await readFile(resolveWildArrangePath(dir, "team", "tasks.json"), "utf8"));
    assert.equal(ledger.tasks.length, 1);
    assert.equal(ledger.tasks[0].ref, "P2:T001");
  });
});

test("state restore recovers the exact Plan, proof, DoneClaim, and artifact archive package", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const task = {
      ...legacyTask("needs_user_decision"),
      owner: "Jiuwei",
      planId: "P1",
      ref: "P1:T001",
      writable_paths: [runtimeRelative(dir, "artifacts", "P1-T001")],
    };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Recover", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(resolveWildArrangePath(dir, "plans", "P1.json"), { id: "P1", title: "Recover", tasks: [task] });
    await writeJson(resolveWildArrangePath(dir, "work.json"), { activePlanId: "P1", status: "ready", stage: "planned" });
    const checkpointPath = resolveWildArrangePath(dir, "checkpoints", "P1", "T001.json");
    const acceptanceJsonPath = resolveWildArrangePath(dir, "reports", "acceptance", "P1", "T001.json");
    const acceptanceMarkdownPath = resolveWildArrangePath(dir, "reports", "acceptance", "P1", "T001.md");
    const outboxPath = resolveWildArrangePath(dir, "team", "outbox", "T001-current.json");
    const artifactPath = resolveWildArrangePath(dir, "artifacts", "P1-T001", "nested", "result.json");
    await writeJson(checkpointPath, { taskRef: "P1:T001", checkpoint: true });
    await writeJson(acceptanceJsonPath, { taskRef: "P1:T001", pass: true });
    await mkdir(path.dirname(acceptanceMarkdownPath), { recursive: true });
    await writeFile(acceptanceMarkdownPath, "# Acceptance\n", "utf8");
    await writeJson(outboxPath, { taskId: "T001", taskRef: "P1:T001", done: true });
    await writeJson(artifactPath, { result: "recover me" });

    const backup = await writeRuntimeStateBackup(dir, { reason: "archive_restore_drill" });
    const archived = await archiveAndDeleteTeamTask(dir, {
      taskId: "T001",
      planId: "P1",
      reason: "restore_drill",
      backupId: backup.backupId,
    });
    assert.equal(archived.backupId, backup.backupId);
    for (const deletedPath of [checkpointPath, acceptanceJsonPath, acceptanceMarkdownPath, outboxPath, path.dirname(path.dirname(artifactPath))]) {
      await assert.rejects(access(deletedPath), /ENOENT/);
    }

    const manifest = JSON.parse(await readFile(
      resolveWildArrangePath(dir, "backups", backup.backupId, "manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.archivePackages.length, 1);
    assert.equal(manifest.archivePackages[0].taskRef, "P1:T001");
    assert.equal(manifest.archivePackages[0].status, "committed");
    assert.ok(manifest.archivePackages[0].stagingPath.includes("archive-staging"));

    const restored = await restoreRuntimeStateBackup(dir, { backupId: backup.backupId });
    for (const expectedPath of [
      "runtime/plans/P1.json",
      "runtime/checkpoints/P1/T001.json",
      "runtime/reports/acceptance/P1/T001.json",
      "runtime/reports/acceptance/P1/T001.md",
      "runtime/team/outbox/T001-current.json",
      "runtime/artifacts/P1-T001",
    ]) {
      assert.ok(restored.restored.includes(expectedPath), expectedPath);
    }
    const restoredLedger = JSON.parse(await readFile(resolveWildArrangePath(dir, "team", "tasks.json"), "utf8"));
    assert.deepEqual(restoredLedger.tasks.map((candidate) => candidate.ref), ["P1:T001"]);
    assert.equal(JSON.parse(await readFile(artifactPath, "utf8")).result, "recover me");
    assert.equal(JSON.parse(await readFile(outboxPath, "utf8")).done, true);
    assert.equal(JSON.parse(await readFile(checkpointPath, "utf8")).checkpoint, true);
  });
});

test("state restore downgrades a forged completed task whose proof chain fails after restore", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const planId = "P-RESTORE";
    const currentTask = (id) => ({
      ...legacyTask("completed"),
      id,
      planId,
      ref: `${planId}:${id}`,
      history: [{ at: "2026-09-10T00:00:00.000Z", event: "completed", status: "completed" }],
    });
    const tasksPath = resolveWildArrangePath(dir, "team", "tasks.json");
    await writeJson(tasksPath, {
      version: 1,
      kind: "task_ledger",
      planId,
      activePlanId: planId,
      plans: [{ id: planId, taskIds: ["T-LEGIT", "T-FORGED"] }],
      tasks: [currentTask("T-LEGIT"), currentTask("T-FORGED")],
    });
    await writeJson(resolveWildArrangePath(dir, "work.json"), { activePlanId: planId, status: "ready" });
    // T-LEGIT 具备完整证据链；T-FORGED 只有 completed 状态、没有任何证据。
    await writeJson(resolveWildArrangePath(dir, "reports", "acceptance", planId, "T-LEGIT.json"), {
      kind: "acceptance_proof",
      planId,
      taskId: "T-LEGIT",
      pass: true,
      evidenceRefs: { deliveryBaseline: { status: "committed_local", commitSha: "d".repeat(40) } },
    });
    await writeJson(resolveWildArrangePath(dir, "checkpoints", planId, "T-LEGIT.json"), {
      planId,
      taskId: "T-LEGIT",
      deliveryBaseline: { status: "committed_local", commitSha: "d".repeat(40) },
      verifyResult: { pass: true },
      scopeResult: { status: "pass" },
      reviewResult: { pass: true },
    });
    await appendLedger(dir, { type: "node_checkpoint_completed", planId, taskId: "T-LEGIT" });

    const backup = await writeRuntimeStateBackup(dir, { reason: "forged_completed_drill" });
    // 备份后把伪造任务从现场移除，让它只在恢复时重新出现。
    const live = JSON.parse(await readFile(tasksPath, "utf8"));
    live.tasks = live.tasks.filter((task) => task.id !== "T-FORGED");
    await writeJson(tasksPath, live);

    const restored = await restoreRuntimeStateBackup(dir, { backupId: backup.backupId });
    assert.deepEqual(restored.downgradedCompleted.map((entry) => entry.taskId), ["T-FORGED"]);

    const after = JSON.parse(await readFile(tasksPath, "utf8"));
    const legit = after.tasks.find((task) => task.id === "T-LEGIT");
    const forged = after.tasks.find((task) => task.id === "T-FORGED");
    assert.equal(legit.status, "completed");
    assert.equal(forged.status, "needs_user_decision");
    assert.equal(forged.completionRevalidation.required, true);
    assert.equal(forged.completionRevalidation.reason, "restored_completed_without_valid_proof_chain");
    assert.equal(forged.completionRevalidation.previousStatus, "completed");
    assert.ok(forged.completionRevalidation.failures.length > 0);
    assert.ok(forged.history.some((entry) => entry.event === "restore_completion_requires_revalidation"
      && entry.from === "completed" && entry.to === "needs_user_decision"));
    assert.match(await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8"), /"downgradedCompletedCount":1/);
  });
});

test("state restore recreates a top-level dangling relative symlink from an archive package", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const task = {
      ...legacyTask("pending"),
      owner: "Jiuwei",
      planId: "P1",
      ref: "P1:T001",
      history: [{ at: "2026-08-25T00:00:00.000Z", event: "created", status: "pending" }],
      writable_paths: [runtimeRelative(dir, "artifacts", "P1-T001")],
    };
    await writeJson(resolveWildArrangePath(dir, "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Symlink", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(resolveWildArrangePath(dir, "plans", "P1.json"), { id: "P1", tasks: [task] });
    await writeJson(resolveWildArrangePath(dir, "work.json"), { activePlanId: "P1", status: "ready", stage: "planned" });
    const artifactLink = resolveWildArrangePath(dir, "artifacts", "P1-T001");
    await mkdir(path.dirname(artifactLink), { recursive: true });
    await symlink("./missing-payload.json", artifactLink);

    const archived = await archiveAndDeleteTeamTask(dir, {
      taskId: "T001",
      planId: "P1",
      reason: "dangling_symlink_regression",
    });
    await assert.rejects(lstat(artifactLink), /ENOENT/);

    const restored = await restoreRuntimeStateBackup(dir, { backupId: archived.backupId });
    assert.ok(restored.restored.includes("runtime/artifacts/P1-T001"));
    assert.equal((await lstat(artifactLink)).isSymbolicLink(), true);
    assert.equal((await readlink(artifactLink)).replaceAll("\\", "/"), "./missing-payload.json");
  });
});
