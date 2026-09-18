// =============================================================================
// 文件名称：worker.mjs
// 所属模块：capabilities
// 作用说明：
//   执行 task.worker_command（或 options 覆盖），产出 worker evidence。
//   未配置命令时返回 exitCode 0 的占位结果，表示实现由外部完成。
//
// 【运行原理速读】
//   · 何时执行？任务进入 execute 阶段，且 execution-readiness 已通过时。
//   · 做了什么？编译安全模式 → runCommand（可注入 WILDARRANGE_EXECUTION_CONTEXT）
//     → 封装 kind/exitCode/stdout/stderr。
//   · 缺了它会怎样？review 与 acceptance proof 缺少 worker 证据链。
// =============================================================================

import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { nowIso } from "../infra/runtime-store.mjs";
import { compileCommandSafetyPatterns } from "../infra/command-safety.mjs";
import { runCommand } from "../infra/command-runner.mjs";

/**
 * 执行 worker_command 并返回 worker evidence；无命令时返回外部完成占位。
 * @param {string} rootDir 项目根目录
 * @param {object} task 含 worker_command 的任务
 * @param {object} [options] workerCommand、timeoutMs、executionContextPath
 * @returns {Promise<object>} kind=worker，含 command 与 exitCode
 */
export async function runWorker(rootDir, task, options = {}) {
  const command = options.workerCommand || task.worker_command;
  if (!command) {
    return {
      kind: "worker",
      at: nowIso(),
      command: null,
      exitCode: 0,
      stdout: "No worker_command configured; treating implementation as externally completed.",
      stderr: "",
    };
  }
  const { config } = await loadWildArrangeConfig(rootDir);
  const extraPatterns = compileCommandSafetyPatterns(config);
  const result = await runCommand(command, options.executionRoot || rootDir, options.timeoutMs, { extraPatterns, env: options.executionContextPath ? { WILDARRANGE_EXECUTION_CONTEXT: options.executionContextPath } : {} });
  return { kind: "worker", at: nowIso(), command, ...result };
}
