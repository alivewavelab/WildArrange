import { compileCommandSafetyPatterns } from "../infra/command-safety.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { nowIso } from "../infra/runtime-store.mjs";
import { runCommand } from "../infra/command-runner.mjs";

export async function runVerifier(rootDir, task) {
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
    const result = await runCommand(command, rootDir, 120_000, { extraPatterns });
    results.push({ command, ...result });
    if (result.exitCode !== 0) break;
  }

  return {
    kind: "verifier",
    at: nowIso(),
    pass: results.every((result) => result.exitCode === 0),
    results,
  };
}
