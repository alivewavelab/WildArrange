/**
 * Command execution primitive shared by every gate that needs to run a
 * shell command (worker, verify, review, standards, ad-hoc CLI calls).
 * Every command passes through evaluateCommandSafety() first; nothing in
 * this file may weaken that check.
 */
import { spawn } from "node:child_process";
import { blockedCommandResult, evaluateCommandSafety } from "./command-safety.mjs";

const DEFAULT_COMMAND_OUTPUT_MAX_CHARS = 200_000;
const COMMAND_SIGKILL_GRACE_MS = 2_000;
const WINDOWS_TERMINATION_CONFIRM_MS = 2_000;

export function runCommand(command, cwd, timeoutMs = 120_000, options = {}) {
  return runProcess(command, [], command, cwd, timeoutMs, { ...options, shell: true });
}

export function runCommandFile(file, args, cwd, timeoutMs = 120_000, options = {}) {
  if (typeof file !== "string" || file.trim().length === 0) {
    throw new TypeError("command file is required");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("command args must be an array of strings");
  }
  const command = [file, ...args].map(formatCommandPart).join(" ");
  return runProcess(file, args, command, cwd, timeoutMs, {
    ...options,
    shell: false,
    safetyCommand: commandTextForSafety(file, args, command),
  });
}

export function quoteShellArgument(value, platform = process.platform) {
  const text = String(value);
  if (platform === "win32") return `"${text.replaceAll('"', '""')}"`;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function runProcess(file, args, command, cwd, timeoutMs, options) {
  return new Promise((resolve) => {
    const safety = evaluateCommandSafety(options.safetyCommand || command, { allowUnsafe: options.allowUnsafe === true, extraPatterns: options.extraPatterns });
    if (!safety.allowed) {
      resolve(blockedCommandResult(command, safety));
      return;
    }
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        shell: options.shell,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WILDARRANGE_RUNTIME: "1", ...(options.env || {}) },
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({
        exitCode: 127,
        stdout: "",
        stderr: `Command failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
        timedOut: false,
        spawnError: true,
        outputTruncated: { stdout: false, stderr: false },
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    const maxOutputChars = Number.isInteger(options.maxOutputChars) && options.maxOutputChars > 0
      ? options.maxOutputChars
      : DEFAULT_COMMAND_OUTPUT_MAX_CHARS;
    const outputTruncated = { stdout: false, stderr: false };
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    let terminationTimer = null;
    let terminationPromise = Promise.resolve();
    function finish(result) {
      if (settled) return;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      settled = true;
      resolve({ ...result, outputTruncated });
    }
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        // Killing cmd.exe alone leaks its real child (for example a timed-out
        // verifier) on Windows. taskkill /T closes the complete process tree.
        const terminateTree = options.windowsTreeKiller || killWindowsProcessTree;
        terminationPromise = Promise.resolve()
          .then(() => terminateTree(child))
          .catch((error) => ({
            ok: false,
            method: "taskkill_tree",
            pid: child.pid,
            exitCode: null,
            error: error instanceof Error ? error.message : String(error),
          }));
        terminationPromise.then((termination) => {
          if (!settled && termination?.ok === false) finishTerminationFailure(termination);
        });
        terminationTimer = setTimeout(() => {
          if (!settled) {
            finishTerminationFailure({
              ok: false,
              method: "taskkill_tree",
              pid: child.pid,
              exitCode: null,
              error: `process termination was not confirmed within ${WINDOWS_TERMINATION_CONFIRM_MS}ms`,
            });
          }
        }, WINDOWS_TERMINATION_CONFIRM_MS);
      } else {
        killPosixProcessGroup(child, "SIGTERM");
        killTimer = setTimeout(() => {
          if (!settled) killPosixProcessGroup(child, "SIGKILL");
        }, COMMAND_SIGKILL_GRACE_MS);
      }
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
    child.on("close", async (code) => {
      if (timedOut) {
        const termination = await terminationPromise;
        if (termination?.ok === false) {
          finishTerminationFailure(termination);
          return;
        }
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

    function finishTerminationFailure(termination) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish({
        exitCode: 125,
        stdout,
        stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms; process termination failed: ${termination?.error || `taskkill exited ${termination?.exitCode ?? "without confirmation"}`}`.trim(),
        timedOut: true,
        terminationFailed: true,
        recoveryRequired: true,
        pid: child.pid || null,
        termination: {
          method: termination?.method || "taskkill_tree",
          requested: true,
          confirmed: false,
          exitCode: termination?.exitCode ?? null,
          error: termination?.error || null,
          rootProcessPreserved: true,
        },
      });
    }
    // spawn 自身失败（shell 缺失、cwd 不存在、权限拒绝）走 error 事件而不是
    // close；没有这个监听，unhandled 'error' 会直接击穿整个进程。
    child.on("error", (error) => {
      finish({
        exitCode: 127,
        stdout,
        stderr: `${stderr}\nCommand failed to spawn: ${error instanceof Error ? error.message : String(error)}`.trim(),
        timedOut: false,
        spawnError: true,
      });
    });
  });
}

function killPosixProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function killWindowsProcessTree(child) {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let errorOutput = "";
    killer.stderr.on("data", (chunk) => {
      errorOutput = appendCapped(errorOutput, chunk.toString(), 4_000).value;
    });
    killer.on("error", (error) => {
      resolve({
        ok: false,
        method: "taskkill_tree",
        pid: child.pid,
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    killer.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, method: "taskkill_tree", pid: child.pid, exitCode: 0, error: null });
        return;
      }
      resolve({
        ok: false,
        method: "taskkill_tree",
        pid: child.pid,
        exitCode: code,
        error: errorOutput.trim() || `taskkill exited ${code ?? "without an exit code"}`,
      });
    });
  });
}

function formatCommandPart(value) {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : JSON.stringify(value);
}

function commandTextForSafety(file, args, command) {
  if (!/(^|[\\/])git(?:\.exe)?$/i.test(file)) return command;
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(arg)) {
      index += 2;
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") || arg.startsWith("--namespace=")) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const canonical = ["git", ...args.slice(index)].map(formatCommandPart).join(" ");
  return `${command}\n${canonical}`;
}

function appendCapped(current, chunk, maxChars) {
  if (current.length >= maxChars) return { value: current, truncated: true };
  const available = maxChars - current.length;
  if (chunk.length <= available) return { value: current + chunk, truncated: false };
  return { value: current + chunk.slice(0, available), truncated: true };
}
