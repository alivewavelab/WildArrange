import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { nowIso } from "../infra/runtime-store.mjs";
import { compileCommandSafetyPatterns } from "../infra/command-safety.mjs";
import { runCommand } from "../infra/command-runner.mjs";

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
  const result = await runCommand(command, rootDir, options.timeoutMs, { extraPatterns });
  return { kind: "worker", at: nowIso(), command, ...result };
}
