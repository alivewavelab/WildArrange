// =============================================================================
// 文件名称：task-migration.mjs
// 所属模块：orchestration
// 作用说明：
//   旧版 task ledger 到当前 canonical task ledger 的迁移。
//   只处理历史结构升级，不参与日常任务创建、认领或执行状态写入。
// =============================================================================
import { appendLedger } from "../infra/ledger.mjs";
import { STATE_VERSION, ensureWildArrangeDirs, nowIso, readJson, resolveWildArrangePath, writeJsonAtomic } from "../infra/runtime-store.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";
import { loadTaskLedger } from "../infra/task-state-store.mjs";
import { writeTasksMarkdown } from "./plan-state.mjs";

/** 迁移旧版 task ledger 格式到当前 taskState 结构。 */
export async function migrateTaskLedgerState(rootDir) {
  return withTaskStateLock(rootDir, "task-ledger-migrate", async () => {
    await ensureWildArrangeDirs(rootDir);
    const ledger = await loadTaskLedger(rootDir);
    if (!ledger) {
      return {
        kind: "task_ledger_migration",
        status: "not_required",
        migratedTasks: 0,
        revalidationRequired: 0,
      };
    }

    const at = nowIso();
    const nextLedger = {
      ...ledger,
      version: STATE_VERSION,
      kind: "task_ledger",
      planId: ledger.activePlanId,
      activePlanId: ledger.activePlanId,
      // §3.4：迁移不得清除 completionRevalidation 标记；已标记任务须继续强制重验收。
      tasks: ledger.tasks.map((task) => task.completionRevalidation?.required === true
        ? {
            ...task,
            completionRevalidation: {
              ...task.completionRevalidation,
              migratedAt: task.completionRevalidation.migratedAt || at,
            },
          }
        : task),
      updatedAt: at,
    };

    // §3.4：canonical tasks.json 最后写入；plan/md 镜像先对齐，避免半迁移可读状态。
    for (const planEntry of nextLedger.plans || []) {
      const planPath = resolveWildArrangePath(rootDir, "plans", `${planEntry.id}.json`);
      const plan = await readJson(planPath, null);
      if (!plan) continue;
      const tasks = nextLedger.tasks.filter((task) => task.planId === planEntry.id);
      const nextPlan = { ...plan, tasks, updatedAt: at };
      await writeJsonAtomic(planPath, nextPlan);
      if (planEntry.id === nextLedger.activePlanId) {
        await writeTasksMarkdown(rootDir, nextPlan);
      }
    }

    await writeJsonAtomic(resolveWildArrangePath(rootDir, "team", "tasks.json"), nextLedger);
    const revalidationRequired = nextLedger.tasks.filter((task) => task.completionRevalidation?.required === true).length;
    const normalizedOwners = nextLedger.tasks.filter((task) => task.owner && task.history?.some((entry) => entry.event === "legacy_imported")).length;
    await appendLedger(rootDir, {
      type: "task_ledger_migrated",
      activePlanId: nextLedger.activePlanId,
      taskCount: nextLedger.tasks.length,
      revalidationRequired,
      normalizedOwners,
    });
    return {
      kind: "task_ledger_migration",
      status: "migrated",
      activePlanId: nextLedger.activePlanId,
      migratedTasks: nextLedger.tasks.length,
      revalidationRequired,
      normalizedOwners,
    };
  });
}
