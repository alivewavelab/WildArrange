// =============================================================================
// 文件名称：verify.mjs
// 所属模块：capabilities
// 作用说明：
//   按 task.verify_commands 顺序执行验收命令，汇总 exitCode 形成 verifier
//   evidence。首条失败即短路，不继续后续命令。
//
// 【运行原理速读】
//   · 何时执行？worker 完成后由 orchestration 或 gateway verify 能力触发。
//   · 做了什么？加载 command-safety 规则 → 逐条 runCommand → 返回 pass 与
//     results 数组（长度须与 verify_commands 一致才算完整证据）。
//   · 缺了它会怎样？review gate 与 acceptance proof 均无法证明目标已验收。
// =============================================================================

import { compileCommandSafetyPatterns } from "../infra/command-safety.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { nowIso } from "../infra/runtime-store.mjs";
import { runCommand } from "../infra/command-runner.mjs";

/**
 * 顺序执行 task.verify_commands，首败即停，返回 verifier evidence。
 * @param {string} rootDir 项目根目录
 * @param {object} task 含 verify_commands 的任务
 * @param {object} [options] executionRoot 覆盖命令 cwd
 * @returns {Promise<object>} kind=verifier，含 pass 与 results
 */
export async function runVerifier(rootDir, task, options = {}) {
  if (!Array.isArray(task.verify_commands) || task.verify_commands.length === 0) {
    return {
      kind: "verifier",
      at: nowIso(),
      pass: false,
      results: [{
        command: null,
        exitCode: 1,
        stdout: "",
        stderr: "verify_commands must contain at least one command",
      }],
    };
  }

  const { config } = await loadWildArrangeConfig(rootDir);
  const extraPatterns = compileCommandSafetyPatterns(config);
  const results = [];
  for (const command of task.verify_commands) {
    const result = await runCommand(command, options.executionRoot || rootDir, 120_000, { extraPatterns });
    results.push({ command, ...result });
    // §3.4：首条验收命令失败即停，后续命令不能掩盖首个失败根因。
    if (result.exitCode !== 0) break;
  }

  return {
    kind: "verifier",
    at: nowIso(),
    pass: results.every((result) => result.exitCode === 0),
    results,
  };
}
