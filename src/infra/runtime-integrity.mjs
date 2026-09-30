// =============================================================================
// 文件名称：runtime-integrity.mjs
// 所属模块：infra
// 作用说明：
//   运行态关键状态文件完整性检查（doctor 使用）。
// =============================================================================
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { normalizeRelativePath } from "./path-match.mjs";
import { readJson, resolveWildArrangePath } from "./runtime-store.mjs";

/** doctor 运行时完整性检查的最低必备状态文件。 */
const REQUIRED_STATE_FILES = [
  ["ledger.jsonl"],
  ["work.json"],
];

/**
 * verifyRuntimeState：本模块对外异步 API。
 */
export async function verifyRuntimeState(rootDir) {
  const files = [];
  for (const segments of REQUIRED_STATE_FILES) {
    const filePath = resolveWildArrangePath(rootDir, ...segments);
    const relativePath = normalizeRelativePath(path.join(".wildarrange", ...segments));
    if (!existsSync(filePath)) {
      files.push({ path: relativePath, status: "missing" });
      continue;
    }
    const fileStat = await stat(filePath);
    files.push({ path: relativePath, status: "present", bytes: fileStat.size });
  }
  const work = await readJson(resolveWildArrangePath(rootDir, "work.json"), null);
  const tasksPath = resolveWildArrangePath(rootDir, "team", "tasks.json");
  if (work?.activePlanId) {
    if (!existsSync(tasksPath)) {
      files.push({ path: ".wildarrange/team/tasks.json", status: "missing" });
    } else {
      const fileStat = await stat(tasksPath);
      files.push({ path: ".wildarrange/team/tasks.json", status: "present", bytes: fileStat.size });
    }
  } else {
    // 无 active plan 时不强制 tasks.json 存在；有 plan 则上面已标 missing
    files.push({
      path: ".wildarrange/team/tasks.json",
      status: existsSync(tasksPath) ? "present" : "not_required",
      reason: "no active plan",
    });
  }
  const failures = files.filter((file) => file.status === "missing").map((file) => ({
    path: file.path,
    reason: file.status,
  }));
  return {
    kind: "runtime_state_integrity",
    ok: failures.length === 0,
    status: failures.length === 0 ? "pass" : "fail",
    files,
    failures,
  };
}
