/**
 * Command execution primitive shared by every gate that needs to run a
 * shell command (worker, verify, review, standards, ad-hoc CLI calls).
 * Every command passes through evaluateCommandSafety() first; nothing in
 * this file may weaken that check.
 */
import { spawn } from "node:child_process";
import { blockedCommandResult, evaluateCommandSafety } from "../helix-command-safety.mjs";

const DEFAULT_COMMAND_OUTPUT_MAX_CHARS = 200_000;
const COMMAND_SIGKILL_GRACE_MS = 2_000;

export function runCommand(command, cwd, timeoutMs = 120_000, options = {}) {
  return new Promise((resolve) => {
    const safety = evaluateCommandSafety(command, { allowUnsafe: options.allowUnsafe === true, extraPatterns: options.extraPatterns });
    if (!safety.allowed) {
      resolve(blockedCommandResult(command, safety));
      return;
    }
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HELIX_RUNTIME: "1" },
    });
    let stdout = "";
    let stderr = "";
    const maxOutputChars = Number.isInteger(options.maxOutputChars) && options.maxOutputChars > 0
      ? options.maxOutputChars
      : DEFAULT_COMMAND_OUTPUT_MAX_CHARS;
    const outputTruncated = { stdout: false, stderr: false };
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    function finish(result) {
      if (settled) return;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      settled = true;
      resolve({ ...result, outputTruncated });
    }
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, COMMAND_SIGKILL_GRACE_MS);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const next = appendCapped(stdout, chunk.toString(), maxOutputChars);
      stdout = next.value;
      outputTruncated.stdout ||= next.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const next = appendCapped(stderr, chunk.toString(), maxOutputChars);
      stderr = next.value;
      outputTruncated.stderr ||= next.truncated;
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish({
          exitCode: 124,
          stdout,
          stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms`.trim(),
          timedOut: true,
        });
        return;
      }
      finish({ exitCode: code ?? 1, stdout, stderr, timedOut: false });
    });
  });
}

function appendCapped(current, chunk, maxChars) {
  if (current.length >= maxChars) return { value: current, truncated: true };
  const available = maxChars - current.length;
  if (chunk.length <= available) return { value: current + chunk, truncated: false };
  return { value: current + chunk.slice(0, available), truncated: true };
}
