import { compileCommandSafetyPatterns } from "../helix-command-safety.mjs";
import { loadHelixConfig, nowIso } from "../helix-foundation.mjs";
import { runCommand } from "./command-runner.mjs";

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

  const { config } = await loadHelixConfig(rootDir);
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
