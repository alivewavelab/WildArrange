import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadHelixConfig,
  migrateRuntimeConfigState,
} from "../src/infra/runtime-config.mjs";
import {
  restoreRuntimeStateBackup,
  writeRuntimeStateBackup,
} from "../src/infra/security.mjs";
import { loadTaskLedger } from "../src/infra/task-state-store.mjs";
import { appendLedger } from "../src/infra/ledger.mjs";
import { archiveAndDeleteTeamTask, migrateTaskLedgerState } from "../src/orchestration/task-board.mjs";
import { statusReport, writeWorkflowSummary } from "../src/orchestration/status.mjs";

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-state-migration-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function legacyTask(status = "completed") {
  return {
    id: "T001",
    subject: "Legacy task",
    description: "Old task state",
    status,
    owner: "Atlas",
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
  await withTempDir(async (dir) => {
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 99,
      kind: "task_ledger",
      activePlanId: "P1",
      tasks: [],
    });
    await assert.rejects(() => loadTaskLedger(dir), /newer than supported version/);
  });
});

test("legacy completed tasks fail closed and normalize their owner", async () => {
  await withTempDir(async (dir) => {
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      planId: "P1",
      tasks: [legacyTask()],
      updatedAt: "2026-06-10T00:01:00.000Z",
    });
    const ledger = await loadTaskLedger(dir);
    assert.equal(ledger.kind, "task_ledger");
    assert.equal(ledger.tasks[0].owner, "Jiuwei");
    assert.equal(ledger.tasks[0].status, "needs_user_decision");
    assert.equal(ledger.tasks[0].completionRevalidation.required, true);
  });
});

test("root config is authoritative over stale runtime-only keys", async () => {
  await withTempDir(async (dir) => {
    await writeJson(path.join(dir, ".helix", "config.json"), {
      runtime: "helix-linear",
      legacyOnly: { enabled: true },
    });
    await writeJson(path.join(dir, "helix.config.json"), {
      reporting: { verbosity: "normal" },
    });
    const loaded = await loadHelixConfig(dir);
    assert.equal(loaded.sourcePath, "helix.config.json");
    assert.equal(loaded.config.runtime, "wildarrange-linear");
    assert.equal(loaded.config.reporting.verbosity, "normal");
    assert.equal(loaded.config.legacyOnly, undefined);
  });
});

test("state migration rewrites active config projections and canonical task ledger", async () => {
  await withTempDir(async (dir) => {
    await writeJson(path.join(dir, "helix.config.json"), {
      reporting: { verbosity: "quiet" },
    });
    await writeJson(path.join(dir, ".helix", "config.json"), {
      runtime: "helix-linear",
      legacyOnly: true,
      dynamicAgents: { quick: { provider: "legacy" } },
      promptVariants: { host: "legacy prompt bias" },
    });
    await writeJson(path.join(dir, ".helix", "agents.json"), { version: 1, agents: { Atlas: {} } });
    await writeJson(path.join(dir, ".helix", "categories.json"), { version: 1, categories: { quick: {} } });
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      planId: "P1",
      tasks: [legacyTask()],
      updatedAt: "2026-06-10T00:01:00.000Z",
    });
    await writeJson(path.join(dir, ".helix", "plans", "P1.json"), {
      id: "P1",
      title: "Legacy plan",
      objective: "Migrate safely",
      tasks: [legacyTask()],
    });

    const config = await migrateRuntimeConfigState(dir);
    const tasks = await migrateTaskLedgerState(dir);

    assert.equal(config.sourcePath, "helix.config.json");
    assert.equal(tasks.revalidationRequired, 1);
    const persisted = JSON.parse(await readFile(path.join(dir, ".helix", "team", "tasks.json"), "utf8"));
    assert.equal(persisted.kind, "task_ledger");
    assert.equal(persisted.activePlanId, "P1");
    assert.equal(persisted.tasks[0].owner, "Jiuwei");
    assert.equal(persisted.tasks[0].status, "needs_user_decision");
    assert.ok(persisted.tasks[0].completionRevalidation.migratedAt);
    const runtimeConfig = JSON.parse(await readFile(path.join(dir, ".helix", "config.json"), "utf8"));
    assert.equal(runtimeConfig.runtime, "wildarrange-linear");
    assert.equal(runtimeConfig.legacyOnly, undefined);
    assert.equal(runtimeConfig.dynamicAgents, undefined);
    assert.equal(runtimeConfig.promptVariants, undefined);
    assert.deepEqual(config.removedProjections.sort(), [".helix/agents.json", ".helix/categories.json"]);
    await assert.rejects(readFile(path.join(dir, ".helix", "agents.json"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(path.join(dir, ".helix", "categories.json"), "utf8"), /ENOENT/);
  });
});

test("status and summary reject completed state without the current proof chain", async () => {
  await withTempDir(async (dir) => {
    const task = {
      ...legacyTask("completed"),
      owner: "Jiuwei",
      planId: "P1",
      ref: "P1:T001",
      history: [{ at: "2026-08-24T00:00:00.000Z", event: "status_changed", to: "completed" }],
    };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Current plan", objective: "Reject fake green", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(path.join(dir, ".helix", "work.json"), { activePlanId: "P1", status: "ready" });

    const status = await statusReport(dir);
    assert.equal(status.completed, 1);
    assert.equal(status.invalidCompleted, 1);
    assert.deepEqual(status.completionIntegrity.invalid[0].failures.sort(), [
      "acceptance_proof",
      "checkpoint_identity",
      "ledger_event",
      "review",
      "scope",
      "verifier",
    ]);
    const summary = await writeWorkflowSummary(dir, { reason: "test" });
    assert.equal(summary.ok, false);
  });
});

test("archive delete leaves a ledger tombstone and removes only the target task artifacts", async () => {
  await withTempDir(async (dir) => {
    const task = {
      ...legacyTask("needs_user_decision"),
      owner: "Jiuwei",
      planId: "P1",
      ref: "P1:T001",
      history: [{ at: "2026-08-24T00:00:00.000Z", event: "legacy_imported" }],
      completionRevalidation: { required: true, previousStatus: "completed", migratedAt: "2026-08-24T00:00:00.000Z" },
      writable_paths: [".helix/artifacts/linear-smoke.txt", "src/**"],
    };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Legacy", objective: "Remove it", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(path.join(dir, ".helix", "plans", "P1.json"), { id: "P1", title: "Legacy", objective: "Remove it", tasks: [task] });
    await writeJson(path.join(dir, ".helix", "work.json"), {
      activePlanId: "P1",
      status: "ready",
      stage: "planned",
      planApproval: { required: true, status: "approved", planId: "P1" },
    });
    await writeJson(path.join(dir, ".helix", "checkpoints", "P1-T001.json"), { planId: "P1", taskId: "T001" });
    await writeJson(path.join(dir, ".helix", "checkpoints", "P2-T001.json"), { planId: "P2", taskId: "T001" });
    await mkdir(path.join(dir, ".helix", "artifacts"), { recursive: true });
    await writeFile(path.join(dir, ".helix", "artifacts", "linear-smoke.txt"), "ok\n", "utf8");
    await writeJson(path.join(dir, ".helix", "team", "outbox", "T001-legacy.json"), { taskId: "T001", summary: "legacy done-claim" });
    await writeJson(path.join(dir, ".helix", "team", "outbox", "T001-current.json"), { taskId: "T001", taskRef: "P1:T001", planId: "P1" });
    await writeJson(path.join(dir, ".helix", "team", "outbox", "T002-keep.json"), { taskId: "T002", taskRef: "P2:T002", planId: "P2" });

    const backup = await writeRuntimeStateBackup(dir, { reason: "before_archive_test" });
    const result = await archiveAndDeleteTeamTask(dir, {
      taskId: "T001",
      planId: "P1",
      reason: "obsolete_smoke_task",
      backupId: backup.backupId,
    });

    assert.equal(result.status, "deleted");
    assert.equal(result.activePlanId, null);
    const ledger = JSON.parse(await readFile(path.join(dir, ".helix", "team", "tasks.json"), "utf8"));
    assert.deepEqual(ledger.tasks, []);
    assert.deepEqual(ledger.plans, []);
    const work = JSON.parse(await readFile(path.join(dir, ".helix", "work.json"), "utf8"));
    assert.equal(work.status, "idle");
    assert.equal(work.planApproval, null);
    await assert.rejects(access(path.join(dir, ".helix", "plans", "P1.json")), /ENOENT/);
    await assert.rejects(access(path.join(dir, ".helix", "checkpoints", "P1-T001.json")), /ENOENT/);
    await assert.rejects(access(path.join(dir, ".helix", "artifacts", "linear-smoke.txt")), /ENOENT/);
    await assert.rejects(access(path.join(dir, ".helix", "team", "outbox", "T001-legacy.json")), /ENOENT/);
    await assert.rejects(access(path.join(dir, ".helix", "team", "outbox", "T001-current.json")), /ENOENT/);
    await access(path.join(dir, ".helix", "team", "outbox", "T002-keep.json"));
    assert.ok(result.deletedPaths.includes(".helix/team/outbox/T001-legacy.json"));
    assert.ok(result.deletedPaths.includes(".helix/team/outbox/T001-current.json"));
    await access(path.join(dir, ".helix", "checkpoints", "P2-T001.json"));
    const audit = await readFile(path.join(dir, ".helix", "ledger.jsonl"), "utf8");
    assert.match(audit, /team_task_archive_requested/);
    assert.match(audit, /team_task_archived_deleted/);
    assert.match(audit, new RegExp(backup.backupId));
  });
});

test("archive delete can purge an explicit unindexed legacy plan without touching canonical tasks", async () => {
  await withTempDir(async (dir) => {
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: null,
      activePlanId: null,
      plans: [],
      tasks: [],
    });
    await writeJson(path.join(dir, ".helix", "plans", "OLD.json"), {
      id: "OLD",
      tasks: [{ ...legacyTask("completed"), planId: undefined }],
    });
    await writeJson(path.join(dir, ".helix", "checkpoints", "OLD-T001.json"), {
      planId: "OLD",
      taskId: "T001",
    });

    const backup = await writeRuntimeStateBackup(dir, { reason: "before_legacy_archive" });
    const result = await archiveAndDeleteTeamTask(dir, {
      taskId: "T001",
      planId: "OLD",
      reason: "purge_unindexed_legacy_plan",
      backupId: backup.backupId,
    });

    assert.equal(result.status, "deleted");
    assert.equal(result.archiveSource, "unindexed_legacy_plan");
    await assert.rejects(access(path.join(dir, ".helix", "plans", "OLD.json")), /ENOENT/);
    await assert.rejects(access(path.join(dir, ".helix", "checkpoints", "OLD-T001.json")), /ENOENT/);
    const ledger = JSON.parse(await readFile(path.join(dir, ".helix", "team", "tasks.json"), "utf8"));
    assert.deepEqual(ledger.tasks, []);
    assert.deepEqual(ledger.plans, []);
    assert.match(await readFile(path.join(dir, ".helix", "ledger.jsonl"), "utf8"), /unindexed_legacy_plan/);
  });
});

test("archive delete preserves ambiguous legacy DoneClaims when another Plan reuses the task id", async () => {
  await withTempDir(async (dir) => {
    const first = { ...legacyTask("pending"), planId: "P1", ref: "P1:T001" };
    const second = { ...legacyTask("pending"), planId: "P2", ref: "P2:T001" };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
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
    await writeJson(path.join(dir, ".helix", "plans", "P1.json"), { id: "P1", tasks: [first] });
    await writeJson(path.join(dir, ".helix", "plans", "P2.json"), { id: "P2", tasks: [second] });
    await writeJson(path.join(dir, ".helix", "team", "outbox", "T001-legacy.json"), { taskId: "T001" });
    await writeJson(path.join(dir, ".helix", "team", "outbox", "T001-P1.json"), { taskId: "T001", taskRef: "P1:T001" });
    await writeJson(path.join(dir, ".helix", "team", "outbox", "T001-P2.json"), { taskId: "T001", taskRef: "P2:T001" });

    await archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P1", reason: "remove_first" });

    await assert.rejects(access(path.join(dir, ".helix", "team", "outbox", "T001-P1.json")), /ENOENT/);
    await access(path.join(dir, ".helix", "team", "outbox", "T001-P2.json"));
    await access(path.join(dir, ".helix", "team", "outbox", "T001-legacy.json"));
  });
});

test("archive delete rejects unsafe plan ids before resolving legacy plan paths", async () => {
  await withTempDir(async (dir) => {
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
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
    const ledger = JSON.parse(await readFile(path.join(dir, ".helix", "team", "tasks.json"), "utf8"));
    assert.deepEqual(ledger.tasks, []);
  });
});

test("archive delete with an explicit Plan never falls back to a unique task in another Plan", async () => {
  await withTempDir(async (dir) => {
    const task = { ...legacyTask("pending"), planId: "P1", ref: "P1:T001" };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Only", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(path.join(dir, ".helix", "plans", "P1.json"), { id: "P1", title: "Only", tasks: [task] });

    await assert.rejects(
      archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P2", reason: "typo" }),
      /unknown task/,
    );

    const ledger = JSON.parse(await readFile(path.join(dir, ".helix", "team", "tasks.json"), "utf8"));
    assert.deepEqual(ledger.tasks.map((candidate) => candidate.ref), ["P1:T001"]);
    await access(path.join(dir, ".helix", "plans", "P1.json"));
  });
});

test("archive delete fails before canonical mutation when an unrelated DoneClaim is corrupt", async () => {
  await withTempDir(async (dir) => {
    const task = { ...legacyTask("pending"), planId: "P1", ref: "P1:T001" };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Current", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(path.join(dir, ".helix", "plans", "P1.json"), { id: "P1", title: "Current", tasks: [task] });
    await writeJson(path.join(dir, ".helix", "checkpoints", "P1-T001.json"), { taskId: "T001" });
    const corruptClaimPath = path.join(dir, ".helix", "team", "outbox", "T999-corrupt.json");
    await mkdir(path.dirname(corruptClaimPath), { recursive: true });
    await writeFile(corruptClaimPath, "{not-json", "utf8");

    await assert.rejects(
      archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P1", reason: "corrupt_outbox" }),
      /JSON/,
    );

    const ledger = JSON.parse(await readFile(path.join(dir, ".helix", "team", "tasks.json"), "utf8"));
    assert.deepEqual(ledger.tasks.map((candidate) => candidate.ref), ["P1:T001"]);
    const plan = JSON.parse(await readFile(path.join(dir, ".helix", "plans", "P1.json"), "utf8"));
    assert.deepEqual(plan.tasks.map((candidate) => candidate.ref), ["P1:T001"]);
    await access(path.join(dir, ".helix", "checkpoints", "P1-T001.json"));
  });
});

test("archive delete rolls back staged files and Plan mirror when tasks markdown cannot be written", async () => {
  await withTempDir(async (dir) => {
    const removed = { ...legacyTask("pending"), planId: "P1", ref: "P1:T001" };
    const kept = { ...legacyTask("pending"), id: "T002", subject: "Keep", planId: "P1", ref: "P1:T002" };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Current", taskIds: ["T001", "T002"] }],
      tasks: [removed, kept],
    });
    await writeJson(path.join(dir, ".helix", "plans", "P1.json"), {
      id: "P1",
      title: "Current",
      tasks: [removed, kept],
    });
    const checkpointPath = path.join(dir, ".helix", "checkpoints", "P1-T001.json");
    await writeJson(checkpointPath, { taskId: "T001" });
    const lockedMarkdown = path.join(dir, "locked-tasks.md");
    await writeFile(lockedMarkdown, "original markdown\n", "utf8");
    await chmod(lockedMarkdown, 0o444);
    const tasksMarkdownPath = path.join(dir, ".helix", "team", "tasks.md");
    await symlink(lockedMarkdown, tasksMarkdownPath);

    await assert.rejects(
      archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P1", reason: "mirror_failure" }),
      /EACCES|permission denied|recovery_required/,
    );

    const ledger = JSON.parse(await readFile(path.join(dir, ".helix", "team", "tasks.json"), "utf8"));
    assert.deepEqual(ledger.tasks.map((task) => task.ref), ["P1:T001", "P1:T002"]);
    const plan = JSON.parse(await readFile(path.join(dir, ".helix", "plans", "P1.json"), "utf8"));
    assert.deepEqual(plan.tasks.map((task) => task.ref), ["P1:T001", "P1:T002"]);
    await access(checkpointPath);
    assert.equal(await readFile(lockedMarkdown, "utf8"), "original markdown\n");
    const backupIds = await readdir(path.join(dir, ".helix", "backups"));
    assert.equal(backupIds.length, 1);
    const recoveryManifest = JSON.parse(await readFile(
      path.join(dir, ".helix", "backups", backupIds[0], "manifest.json"),
      "utf8",
    ));
    assert.equal(recoveryManifest.archivePackages.length, 1);
    assert.equal(recoveryManifest.archivePackages[0].status, "recovery_required");
    assert.match(recoveryManifest.archivePackages[0].stagingPath, /archive-staging/);
    await chmod(lockedMarkdown, 0o644);
  });
});

test("archive delete synchronizes a non-active Plan mirror and leaves active tasks markdown active-only", async () => {
  await withTempDir(async (dir) => {
    const active = { ...legacyTask("pending"), id: "T100", subject: "Active task", planId: "P1", ref: "P1:T100" };
    const removed = { ...legacyTask("pending"), subject: "Remove from background", planId: "P2", ref: "P2:T001" };
    const kept = { ...legacyTask("pending"), id: "T002", subject: "Keep in background", planId: "P2", ref: "P2:T002" };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
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
    await writeJson(path.join(dir, ".helix", "plans", "P1.json"), { id: "P1", title: "Active", tasks: [active] });
    await writeJson(path.join(dir, ".helix", "plans", "P2.json"), { id: "P2", title: "Background", tasks: [removed, kept] });

    const result = await archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P2", reason: "background_cleanup" });

    assert.equal(result.activePlanId, "P1");
    const background = JSON.parse(await readFile(path.join(dir, ".helix", "plans", "P2.json"), "utf8"));
    assert.deepEqual(background.tasks.map((task) => task.ref), ["P2:T002"]);
    const markdown = await readFile(path.join(dir, ".helix", "team", "tasks.md"), "utf8");
    assert.match(markdown, /Active task/);
    assert.doesNotMatch(markdown, /Keep in background|Remove from background/);
  });
});

test("archive delete of the active Plan's final task does not auto-activate another Plan", async () => {
  await withTempDir(async (dir) => {
    const removed = { ...legacyTask("pending"), planId: "P1", ref: "P1:T001" };
    const waiting = { ...legacyTask("pending"), id: "T002", subject: "Needs explicit activation", planId: "P2", ref: "P2:T002" };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
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
    await writeJson(path.join(dir, ".helix", "plans", "P1.json"), { id: "P1", title: "Current", tasks: [removed] });
    await writeJson(path.join(dir, ".helix", "plans", "P2.json"), { id: "P2", title: "Waiting", tasks: [waiting] });
    await writeJson(path.join(dir, ".helix", "work.json"), {
      activePlanId: "P1",
      status: "complete",
      stage: "completed",
      planApproval: { required: true, status: "approved", planId: "P1" },
    });

    const result = await archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P1", reason: "finish_cleanup" });

    assert.equal(result.activePlanId, null);
    const ledger = JSON.parse(await readFile(path.join(dir, ".helix", "team", "tasks.json"), "utf8"));
    assert.equal(ledger.activePlanId, null);
    assert.equal(ledger.planId, null);
    assert.deepEqual(ledger.plans.map((plan) => plan.id), ["P2"]);
    assert.deepEqual(ledger.tasks.map((task) => task.ref), ["P2:T002"]);
    const work = JSON.parse(await readFile(path.join(dir, ".helix", "work.json"), "utf8"));
    assert.equal(work.activePlanId, null);
    assert.equal(work.status, "idle");
    assert.equal(work.stage, "initialized");
    assert.equal(work.planApproval, null);
    assert.match(await readFile(path.join(dir, ".helix", "team", "tasks.md"), "utf8"), /No active tasks/);
    await access(path.join(dir, ".helix", "plans", "P2.json"));
  });
});

test("archive delete removes an exact artifact directory as one recoverable staged unit", async () => {
  await withTempDir(async (dir) => {
    const task = {
      ...legacyTask("pending"),
      planId: "P1",
      ref: "P1:T001",
      writable_paths: [".helix/artifacts/P1-T001"],
    };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Artifacts", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(path.join(dir, ".helix", "plans", "P1.json"), { id: "P1", title: "Artifacts", tasks: [task] });
    const artifactFile = path.join(dir, ".helix", "artifacts", "P1-T001", "nested", "result.json");
    await writeJson(artifactFile, { ok: true });

    const result = await archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P1", reason: "artifact_cleanup" });

    await assert.rejects(access(path.join(dir, ".helix", "artifacts", "P1-T001")), /ENOENT/);
    assert.ok(result.deletedPaths.includes(".helix/artifacts/P1-T001"));
  });
});

test("archive delete fails closed on duplicate or corrupted canonical task identities", async () => {
  await withTempDir(async (dir) => {
    const task = { ...legacyTask("pending"), planId: "P1", ref: "P1:T001" };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Broken", taskIds: ["T001", "T001"] }],
      tasks: [task, { ...task, subject: "Duplicate identity" }],
    });
    await writeJson(path.join(dir, ".helix", "plans", "P1.json"), { id: "P1", tasks: [task, task] });

    await assert.rejects(
      archiveAndDeleteTeamTask(dir, { taskId: "T001", planId: "P1", reason: "must_not_mass_delete" }),
      /duplicate canonical task identity/,
    );

    const ledger = JSON.parse(await readFile(path.join(dir, ".helix", "team", "tasks.json"), "utf8"));
    assert.equal(ledger.tasks.length, 2);
    assert.deepEqual(ledger.tasks.map((candidate) => candidate.ref), ["P1:T001", "P1:T001"]);
  });

  await withTempDir(async (dir) => {
    const task = { ...legacyTask("pending"), planId: "P1", ref: "P2:T001" };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
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
    const ledger = JSON.parse(await readFile(path.join(dir, ".helix", "team", "tasks.json"), "utf8"));
    assert.equal(ledger.tasks.length, 1);
    assert.equal(ledger.tasks[0].ref, "P2:T001");
  });
});

test("archive delete removes only one task from a multi-task unindexed legacy Plan", async () => {
  await withTempDir(async (dir) => {
    const first = { ...legacyTask("completed"), writable_paths: [".helix/artifacts/shared-legacy"] };
    const second = {
      ...legacyTask("pending"),
      id: "T002",
      subject: "Keep legacy task",
      writable_paths: [".helix/artifacts/shared-legacy"],
    };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: null,
      activePlanId: null,
      plans: [],
      tasks: [],
    });
    await writeJson(path.join(dir, ".helix", "plans", "OLD.json"), {
      id: "OLD",
      title: "Legacy pair",
      tasks: [first, second],
    });
    await writeJson(path.join(dir, ".helix", "checkpoints", "OLD-T001.json"), { taskId: "T001" });
    await writeJson(path.join(dir, ".helix", "checkpoints", "OLD-T002.json"), { taskId: "T002" });
    const sharedArtifact = path.join(dir, ".helix", "artifacts", "shared-legacy", "keep.txt");
    await mkdir(path.dirname(sharedArtifact), { recursive: true });
    await writeFile(sharedArtifact, "shared\n", "utf8");

    const result = await archiveAndDeleteTeamTask(dir, {
      taskId: "T001",
      planId: "OLD",
      reason: "precise_legacy_cleanup",
    });

    assert.equal(result.archiveSource, "unindexed_legacy_plan");
    const plan = JSON.parse(await readFile(path.join(dir, ".helix", "plans", "OLD.json"), "utf8"));
    assert.deepEqual(plan.tasks.map((task) => task.id), ["T002"]);
    await assert.rejects(access(path.join(dir, ".helix", "checkpoints", "OLD-T001.json")), /ENOENT/);
    await access(path.join(dir, ".helix", "checkpoints", "OLD-T002.json"));
    assert.equal(await readFile(sharedArtifact, "utf8"), "shared\n");
  });
});

test("state restore recovers the exact Plan, proof, DoneClaim, and artifact archive package", async () => {
  await withTempDir(async (dir) => {
    const task = {
      ...legacyTask("needs_user_decision"),
      owner: "Jiuwei",
      planId: "P1",
      ref: "P1:T001",
      writable_paths: [".helix/artifacts/P1-T001"],
    };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Recover", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(path.join(dir, ".helix", "plans", "P1.json"), { id: "P1", title: "Recover", tasks: [task] });
    await writeJson(path.join(dir, ".helix", "work.json"), { activePlanId: "P1", status: "ready", stage: "planned" });
    const checkpointPath = path.join(dir, ".helix", "checkpoints", "P1-T001.json");
    const acceptanceJsonPath = path.join(dir, ".helix", "reports", "acceptance", "P1-T001.json");
    const acceptanceMarkdownPath = path.join(dir, ".helix", "reports", "acceptance", "P1-T001.md");
    const outboxPath = path.join(dir, ".helix", "team", "outbox", "T001-current.json");
    const artifactPath = path.join(dir, ".helix", "artifacts", "P1-T001", "nested", "result.json");
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
      path.join(dir, ".helix", "backups", backup.backupId, "manifest.json"),
      "utf8",
    ));
    assert.equal(manifest.archivePackages.length, 1);
    assert.equal(manifest.archivePackages[0].taskRef, "P1:T001");
    assert.equal(manifest.archivePackages[0].status, "committed");
    assert.ok(manifest.archivePackages[0].stagingPath.includes("archive-staging"));

    const restored = await restoreRuntimeStateBackup(dir, { backupId: backup.backupId });
    for (const expectedPath of [
      ".helix/plans/P1.json",
      ".helix/checkpoints/P1-T001.json",
      ".helix/reports/acceptance/P1-T001.json",
      ".helix/reports/acceptance/P1-T001.md",
      ".helix/team/outbox/T001-current.json",
      ".helix/artifacts/P1-T001",
    ]) {
      assert.ok(restored.restored.includes(expectedPath), expectedPath);
    }
    const restoredLedger = JSON.parse(await readFile(path.join(dir, ".helix", "team", "tasks.json"), "utf8"));
    assert.deepEqual(restoredLedger.tasks.map((candidate) => candidate.ref), ["P1:T001"]);
    assert.equal(JSON.parse(await readFile(artifactPath, "utf8")).result, "recover me");
    assert.equal(JSON.parse(await readFile(outboxPath, "utf8")).done, true);
    assert.equal(JSON.parse(await readFile(checkpointPath, "utf8")).checkpoint, true);
  });
});

test("archive keeps a colliding legacy evidence file owned by another hyphenated Plan identity", async () => {
  await withTempDir(async (dir) => {
    const archived = {
      ...legacyTask("pending"),
      id: "hotfix-T001",
      owner: "Jiuwei",
      planId: "P1",
      ref: "P1:hotfix-T001",
      history: [{ at: "2026-08-25T00:00:00.000Z", event: "created", status: "pending" }],
    };
    const retained = {
      ...legacyTask("completed"),
      owner: "Jiuwei",
      planId: "P1-hotfix",
      ref: "P1-hotfix:T001",
      history: [{ at: "2026-08-25T00:00:00.000Z", event: "completed", status: "completed" }],
    };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1-hotfix",
      activePlanId: "P1-hotfix",
      plans: [
        { id: "P1", title: "Archive", taskIds: ["hotfix-T001"] },
        { id: "P1-hotfix", title: "Retain", taskIds: ["T001"] },
      ],
      tasks: [archived, retained],
    });
    await writeJson(path.join(dir, ".helix", "plans", "P1.json"), { id: "P1", tasks: [archived] });
    await writeJson(path.join(dir, ".helix", "plans", "P1-hotfix.json"), { id: "P1-hotfix", tasks: [retained] });
    await writeJson(path.join(dir, ".helix", "work.json"), {
      activePlanId: "P1-hotfix",
      status: "complete",
      stage: "completed",
    });
    const legacyCheckpoint = path.join(dir, ".helix", "checkpoints", "P1-hotfix-T001.json");
    const legacyAcceptance = path.join(dir, ".helix", "reports", "acceptance", "P1-hotfix-T001.json");
    await writeJson(legacyCheckpoint, {
      planId: "P1-hotfix",
      taskId: "T001",
      verifyResult: { pass: true },
      scopeResult: { status: "pass" },
      reviewResult: { pass: true },
    });
    await writeJson(legacyAcceptance, {
      kind: "acceptance_proof",
      planId: "P1-hotfix",
      taskId: "T001",
      pass: true,
    });
    await appendLedger(dir, {
      type: "node_checkpoint_completed",
      planId: "P1-hotfix",
      taskId: "T001",
    });

    const result = await archiveAndDeleteTeamTask(dir, {
      taskId: "hotfix-T001",
      planId: "P1",
      reason: "hyphen_collision_regression",
    });

    assert.ok(!result.deletedPaths.includes(".helix/checkpoints/P1-hotfix-T001.json"));
    await access(legacyCheckpoint);
    await access(legacyAcceptance);
    const ledger = JSON.parse(await readFile(path.join(dir, ".helix", "team", "tasks.json"), "utf8"));
    assert.deepEqual(ledger.tasks.map((task) => task.ref), ["P1-hotfix:T001"]);
    const status = await statusReport(dir);
    assert.equal(status.completed, 1);
    assert.equal(status.invalidCompleted, 0);
  });
});

test("state restore recreates a top-level dangling relative symlink from an archive package", async () => {
  await withTempDir(async (dir) => {
    const task = {
      ...legacyTask("pending"),
      owner: "Jiuwei",
      planId: "P1",
      ref: "P1:T001",
      history: [{ at: "2026-08-25T00:00:00.000Z", event: "created", status: "pending" }],
      writable_paths: [".helix/artifacts/P1-T001"],
    };
    await writeJson(path.join(dir, ".helix", "team", "tasks.json"), {
      version: 1,
      kind: "task_ledger",
      planId: "P1",
      activePlanId: "P1",
      plans: [{ id: "P1", title: "Symlink", taskIds: ["T001"] }],
      tasks: [task],
    });
    await writeJson(path.join(dir, ".helix", "plans", "P1.json"), { id: "P1", tasks: [task] });
    await writeJson(path.join(dir, ".helix", "work.json"), { activePlanId: "P1", status: "ready", stage: "planned" });
    const artifactLink = path.join(dir, ".helix", "artifacts", "P1-T001");
    await mkdir(path.dirname(artifactLink), { recursive: true });
    await symlink("./missing-payload.json", artifactLink);

    const archived = await archiveAndDeleteTeamTask(dir, {
      taskId: "T001",
      planId: "P1",
      reason: "dangling_symlink_regression",
    });
    await assert.rejects(lstat(artifactLink), /ENOENT/);

    const restored = await restoreRuntimeStateBackup(dir, { backupId: archived.backupId });
    assert.ok(restored.restored.includes(".helix/artifacts/P1-T001"));
    assert.equal((await lstat(artifactLink)).isSymbolicLink(), true);
    assert.equal((await readlink(artifactLink)).replaceAll("\\", "/"), "./missing-payload.json");
  });
});
