// =============================================================================
// 文件名称：agent-spawn.mjs
// 所属模块：infra
// 作用说明：
//   解析并行 Agent 的 spawn 命令模板，将占位符替换为实际路径与任务上下文。
//   不负责启动进程，只产出可执行的 shell 命令字符串。
//
// 【运行原理速读】
//   可以把它想成「并行 worker 启动命令的填表机」：
//
//   · 何时执行？
//     parallel-runtime 为子 Agent 分配工作目录并需要外部 runner 命令时。
//
//   · 它做了什么？
//     ① 选 adapter 与模板 ② 注入 rootDir/taskId/agent 等占位符 ③ 返回 configured 标志。
//
//   · 和其他部分的关系？
//     依赖 agent-registry 规范化 Agent 名、command-runner 引用 shell 转义。
// =============================================================================
import path from "node:path";
import { normalizeAgentKey } from "./agent-registry.mjs";
import { quoteShellArgument } from "./command-runner.mjs";

/**
 * 根据配置与任务上下文解析 Agent spawn 命令。
 * @param {string} rootDir 项目根目录
 * @param {object} config WildArrange 运行时配置
 * @param {object} task 任务对象
 * @param {object} context 含 runDir、workDir、agent、taskPacketPath 等
 * @param {object} [options] 可覆盖 command、adapter、runnerCommand
 * @returns {{ adapter: string, command: string|null, source: string, configured: boolean }}
 */
export function resolveAgentSpawn(rootDir, config, task, context, options = {}) {
  const explicitCommand = options.command || options.runnerCommand;
  const adapter = normalizeAdapterName(options.adapter || task.adapter || task.host_adapter || config.parallelAgents?.defaultAdapter);
  const spawnConfig = config.parallelAgents?.spawnAdapters || {};
  const adapterConfig = adapter ? spawnConfig[adapter] : null;
  const template = explicitCommand || adapterConfig?.command || null;
  if (!template || template === true) {
    return {
      adapter: adapter || "command",
      command: null,
      source: explicitCommand ? "explicit" : "none",
      configured: false,
    };
  }

  const agent = normalizeAgentKey(context.agent) || context.agent;
  return {
    adapter: adapter || adapterConfig?.adapter || "command",
    command: renderSpawnCommand(template, {
      rootDir,
      runDir: context.runDir,
      workDir: context.workDir || context.runDir,
      task,
      agent,
      taskPacketPath: context.taskPacketPath,
      resultPath: context.resultPath,
    }),
    source: explicitCommand ? "explicit" : "adapter",
    configured: true,
  };
}

/**
 * 将 spawn 模板中的 `{placeholder}` 替换为已 shell 转义的上下文值。
 * @param {string} command 含占位符的命令模板
 * @param {object} context 占位符数据源
 * @returns {string} 渲染后的完整命令
 */
export function renderSpawnCommand(command, context) {
  return String(command)
    .replaceAll("{rootDir}", quoteShellArgument(context.rootDir))
    .replaceAll("{runDir}", quoteShellArgument(context.runDir))
    .replaceAll("{workDir}", quoteShellArgument(context.workDir))
    .replaceAll("{taskId}", quoteShellArgument(context.task.id))
    .replaceAll("{agent}", quoteShellArgument(context.agent))
    .replaceAll("{taskJson}", quoteShellArgument(context.taskPacketPath))
    .replaceAll("{outputJson}", quoteShellArgument(context.resultPath));
}

function normalizeAdapterName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}
