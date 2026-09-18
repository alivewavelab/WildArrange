// =============================================================================
// 文件名称：admission-inputs.mjs
// 所属模块：orchestration
// 作用说明：
//   并行 admission 的结果读取、候选文件/补丁路径归一化与实际变更收集。
//   只处理输入边界和路径事实，不 claim、不 apply、不运行质量门。
//
// 【运行原理速读】
//   agent-result.json / patch → 本模块校验并归一化；
//   admission 事务只消费结构化路径，不重复解释外部结果格式。
// =============================================================================
import { runCommandFile } from "../infra/command-runner.mjs";
import path from "node:path";
import { readJson, resolveWildArrangePath } from "../infra/runtime-store.mjs";
import { normalizeRelativePath } from "../infra/path-match.mjs";

// --- 辅助导出 ---

/** 用 git diff/ls-files 收集 admission 后工作区实际变更路径。 */
export async function collectActualAdmissionPaths(rootDir, fallbackPaths) {
  const result = await runCommandFile("git", ["-C", rootDir, "diff", "--name-only", "--", ".", ":!.wildarrange"], rootDir, 30_000);
  if (result.exitCode !== 0) return fallbackPaths;
  const paths = result.stdout.split(/\r?\n/).map((line) => normalizeRelativePath(line.trim())).filter(Boolean);
  const untracked = await runCommandFile("git", ["-C", rootDir, "ls-files", "--others", "--exclude-standard", "--", ".", ":!.wildarrange"], rootDir, 30_000);
  if (untracked.exitCode === 0) {
    for (const line of untracked.stdout.split(/\r?\n/)) {
      const filePath = normalizeRelativePath(line.trim());
      if (filePath) paths.push(filePath);
    }
  }
  return paths.length > 0 ? [...new Set(paths)] : fallbackPaths;
}

/** 读取 agent-runs 下某 run/task 的 result.json。 */
export async function readParallelAgentResult(rootDir, runId, taskId) {
  const directPath = resolveWildArrangePath(rootDir, "agent-runs", runId, taskId, "result.json");
  const result = await readJson(directPath, null);
  if (!result) throw new Error(`parallel result not found: ${path.relative(rootDir, directPath)}`);
  return result;
}

/** 规范化 parallel result.files 为 { path, content } 列表。 */
export function normalizeProposedFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map((file, index) => {
    if (!file || typeof file !== "object") throw new Error(`result.files[${index}] must be an object`);
    const filePath = normalizeRelativePath(String(file.path || file.file || ""));
    if (!filePath) throw new Error(`result.files[${index}].path is required`);
    if (path.isAbsolute(filePath) || filePath.startsWith("../") || filePath.includes("/../")) {
      throw new Error(`result.files[${index}].path must stay inside the project`);
    }
    if (typeof file.content !== "string") throw new Error(`result.files[${index}].content must be a string`);
    return { path: filePath, content: file.content };
  });
}

/** normalizeProposedFiles 的安全版：失败时返回空数组。 */
export function normalizeProposedFilesOrEmpty(files) {
  try {
    return normalizeProposedFiles(files);
  } catch {
    return [];
  }
}

/** 归一化 patch 声明的路径列表，拒绝绝对路径与 ../ 逃逸。 */
export function normalizePatchPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths.map((filePath) => normalizeRelativePath(String(filePath || ""))).filter((filePath) => filePath && !path.isAbsolute(filePath) && !filePath.startsWith("../") && !filePath.includes("/../"));
}
