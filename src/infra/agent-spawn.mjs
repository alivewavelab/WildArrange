import path from "node:path";
import { normalizeAgentKey } from "./agent-registry.mjs";
import { quoteShellArgument } from "./command-runner.mjs";

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
