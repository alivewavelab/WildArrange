// =============================================================================
// 文件名称：transact-with-ledger.test.mjs
// 所属模块：test
// 作用说明：
//   验证 transactWithLedger 原子性：ledger outage 前 abort 无残留、
//   persist 失败 ledger 仍审计、claimTeamTask/importPlan/recovery 同类不变式。
//   不测：真实磁盘满或网络分区下的长期恢复。
//
// 【运行原理速读】
//   模拟 ledger 写入失败或 persist 抛错，
//   断言 authoritative state 未提交且 ledger 行可对照。
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { appendLedgerOnce, readVerifiedLedgerEntries, verifyLedger } from "../src/infra/ledger.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { transactWithLedger } from "../src/infra/task-state-lock.mjs";
import { persistPostIntegrationRecovery } from "../src/orchestration/admission-recovery.mjs";
import { importPlan, loadTaskState } from "../src/orchestration/plan-state.mjs";
import { claimTeamTask } from "../src/orchestration/task-board.mjs";

// ARC-003 顺序回归：非完成路径统一为「先 appendLedger 后 persist」。
// 账本失败 -> 实际状态不得改变（无账状态不得出现）；
// persist 失败 -> 账本必须已有记录（可审计）。

async function withTempDir(fn) {
  const baseDir = path.join(os.tmpdir(), "wildarrange-tests");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-transact-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sabotageLedger(dir) {
  await chmod(resolveWildArrangePath(dir, "ledger.jsonl"), 0o444);
}

async function repairLedger(dir) {
  await chmod(resolveWildArrangePath(dir, "ledger.jsonl"), 0o644);
}

async function ledgerText(dir) {
  return readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8");
}

async function importProbePlan(dir) {
  const planPath = resolveWildArrangePath(dir, "artifacts", "transact-plan.json");
  await writeJson(planPath, {
    id: "plan_ledger_order",
    title: "Ledger order probe",
    tasks: [
      {
        id: "T001",
        subject: "Probe task",
        verify_commands: ["node -e \"process.exit(0)\""],
        writable_paths: ["src/**"],
      },
    ],
  });
  return importPlan(dir, planPath);
}

test("transactWithLedger: ledger outage aborts before persist and leaves no state residue", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await sabotageLedger(dir);
    let persistCalled = false;
    const markerPath = resolveWildArrangePath(dir, "team", "persist-marker.json");
    try {
      await assert.rejects(
        () => transactWithLedger(dir, { type: "transact_probe" }, async () => {
          persistCalled = true;
          await writeJson(markerPath, { touched: true });
        }),
        /EACCES|EPERM|permission denied/i,
      );
    } finally {
      await repairLedger(dir);
    }
    assert.equal(persistCalled, false, "ledger failure must abort before persist");
    assert.equal(await readJson(markerPath, null), null, "no unaudited state file may appear");
  });
});

test("transactWithLedger: persist failure keeps the ledger entry auditable", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await assert.rejects(
      () => transactWithLedger(dir, { type: "transact_probe_persist_failure" }, async () => {
        throw new Error("persist boom");
      }),
      /persist boom/,
    );
    assert.match(await ledgerText(dir), /transact_probe_persist_failure/, "ledger must already hold the audit event");
    const verification = await verifyLedger(dir);
    assert.equal(verification.ok, true, `ledger chain must stay intact: ${JSON.stringify(verification.failures)}`);
  });
});

test("claimTeamTask: ledger outage never leaves an unaudited in_progress state", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await writeJson(path.join(dir, "wildarrange.config.json"), { gitCoordination: { mode: "off" } });
    await importProbePlan(dir);

    await sabotageLedger(dir);
    try {
      await assert.rejects(() => claimTeamTask(dir, { taskId: "T001" }), /EACCES|EPERM|permission denied/i);
      assert.doesNotMatch(await ledgerText(dir), /team_task_claimed/);
    } finally {
      await repairLedger(dir);
    }
    const state = await loadTaskState(dir);
    assert.equal(state.tasks[0].status, "pending", "tasks.json must stay pending when the claim audit fails");
  });
});

test("claimTeamTask: persist failure leaves the claim event in the ledger and state untouched", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await writeJson(path.join(dir, "wildarrange.config.json"), { gitCoordination: { mode: "off" } });
    await importProbePlan(dir);
    // persistTaskState re-reads the plan mirror; removing it fails the persist
    // step after the ledger append.
    await rm(resolveWildArrangePath(dir, "plans", "plan_ledger_order.json"));

    await assert.rejects(() => claimTeamTask(dir, { taskId: "T001" }), /ENOENT/);
    assert.match(await ledgerText(dir), /team_task_claimed/, "claim must be auditable even though persist failed");
    const state = await loadTaskState(dir);
    assert.equal(state.tasks[0].status, "pending", "tasks.json must not be half-mutated");
  });
});

test("importPlan: persist failure leaves plan_imported in the ledger without committing state", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    // Block the canonical plan write: a directory occupying the target path
    // makes the atomic rename fail inside the persist step.
    await mkdir(resolveWildArrangePath(dir, "plans", "plan_persist_probe.json"), { recursive: true });
    const planPath = resolveWildArrangePath(dir, "artifacts", "blocked-plan.json");
    await writeJson(planPath, {
      id: "plan_persist_probe",
      title: "Blocked persist probe",
      tasks: [
        {
          id: "T001",
          subject: "Probe task",
          verify_commands: ["node -e \"process.exit(0)\""],
          writable_paths: ["src/**"],
        },
      ],
    });

    await assert.rejects(() => importPlan(dir, planPath));
    assert.match(await ledgerText(dir), /plan_imported/, "import must be auditable even though persist failed");
    assert.equal(
      await readJson(resolveWildArrangePath(dir, "team", "tasks.json"), null),
      null,
      "tasks.json must not exist when the plan persist failed",
    );
    const work = await readJson(resolveWildArrangePath(dir, "work.json"), null);
    assert.equal(work.activePlanId, null, "work.json must not point at an uncommitted plan");
  });
});

test("persistPostIntegrationRecovery: ledger outage leaves the authoritative state unchanged", async () => {
  // 顺序回归：该路径过去先 persist 后 appendLedger，账本故障会留下无审计的
  // recovery 状态；现在必须先入账本。
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await writeJson(path.join(dir, "wildarrange.config.json"), { gitCoordination: { mode: "off" } });
    await importProbePlan(dir);
    const taskState = await loadTaskState(dir);
    const task = taskState.tasks[0];

    await sabotageLedger(dir);
    try {
      await assert.rejects(
        () => persistPostIntegrationRecovery(dir, taskState, task, {
          runId: "run_probe",
          summary: "probe recovery",
          checkpointFailed: false,
          integrationCommit: { status: "pushed", integrationSha: "abc123" },
        }),
        /EACCES|EPERM|permission denied/i,
      );
      assert.doesNotMatch(await ledgerText(dir), /post_integration_recovery_required/);
    } finally {
      await repairLedger(dir);
    }
    const state = await loadTaskState(dir);
    assert.equal(state.tasks[0].status, "pending", "tasks.json must not record an unaudited recovery state");
    assert.equal(state.tasks[0].last_failure, undefined, "no unaudited failure marker may persist");
  });
});

test("appendLedgerOnce: concurrent dedupe+append stays atomic and records exactly one entry", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const event = {
      type: "remote_task_claimed",
      planId: "plan_ledger_order",
      taskId: "T001",
      remoteHeadSha: "sha-probe",
    };
    const isDuplicate = (entry) => entry.type === "remote_task_claimed"
      && entry.planId === event.planId
      && entry.taskId === event.taskId
      && entry.remoteHeadSha === event.remoteHeadSha;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => appendLedgerOnce(dir, { ...event }, isDuplicate)),
    );
    assert.equal(results.filter((result) => result.skipped === false).length, 1);
    assert.equal(results.filter((result) => result.skipped === true).length, 7);
    const recorded = (await readVerifiedLedgerEntries(dir)).filter(isDuplicate);
    assert.equal(recorded.length, 1, "duplicate claims must collapse into a single audited entry");
  });
});
