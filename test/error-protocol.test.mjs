import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { invokeCapability } from "../src/capabilities/gateway.mjs";
import { runDeliveryPipeline } from "../src/orchestration/delivery-pipeline.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import {
  buildErrorProtocol,
  errorProtocolOf,
  formatErrorInline,
  wildarrangeError,
} from "../src/infra/error-protocol.mjs";

const CLI_PATH = path.join(process.cwd(), "bin", "wildarrange.mjs");

test("error protocol renders inline with code, module and next_action", () => {
  const protocol = buildErrorProtocol({
    code: "gate_failed",
    module: "capabilities/verify.mjs",
    message: "验证门未通过",
    nextAction: "查看 verify report",
  });
  const line = formatErrorInline(protocol);
  assert.match(line, /\[WILDARRANGE-gate_failed\]/);
  assert.match(line, /\(capabilities\/verify\.mjs\)/);
  assert.match(line, /验证门未通过/);
  assert.match(line, /\| next: 查看 verify report/);

  const error = wildarrangeError({ code: "x", module: "m", message: "boom", nextAction: "fix" });
  assert.deepEqual(errorProtocolOf(error), error.protocol);
  const fallback = errorProtocolOf(new Error("plain"), { code: "cli_error", module: "bin/wildarrange.mjs", nextAction: "doctor" });
  assert.equal(fallback.code, "cli_error");
  assert.equal(fallback.message, "plain");
});

test("gateway envelope error carries the protocol for unknown and throwing capabilities", async () => {
  await assert.rejects(
    invokeCapability("nonsense", {}),
    (error) => {
      assert.equal(error.protocol.code, "unknown_capability");
      assert.equal(error.protocol.module, "capabilities/gateway.mjs");
      assert.match(error.message, /\[WILDARRANGE-unknown_capability\]/);
      return true;
    },
  );

  await withTempDir(async (dir) => {
    const envelope = await invokeCapability("checkpoint", { rootDir: dir });
    assert.equal(envelope.status, "fail");
    assert.equal(envelope.error.code, "capability_threw");
    assert.equal(envelope.error.module, "capabilities/checkpoint.mjs");
    assert.match(envelope.error.next_action, /doctor/);
  });
});

test("delivery pipeline blocked result carries an inline error protocol pointing at the failing gate", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const task = {
      id: "T001",
      subject: "failing verify",
      writable_paths: ["src/app.js"],
      verify_commands: ["node -e \"process.exit(1)\""],
    };
    const result = await runDeliveryPipeline(dir, "P-test", task);
    assert.equal(result.status, "blocked");
    assert.equal(result.error.code, "gate_failed");
    assert.equal(result.error.module, "capabilities/verify.mjs");
    assert.match(result.error.next_action, /verify report/);
    assert.match(formatErrorInline(result.error), /\[WILDARRANGE-gate_failed\] \(capabilities\/verify\.mjs\)/);
  });
});

test("CLI non-zero exit renders the inline error protocol on stderr", async () => {
  await withTempDir(async (dir) => {
    const result = await runCli(dir, ["nonsense-command"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /\[WILDARRANGE-cli_error\] \(bin\/wildarrange\.mjs\)/);
    assert.match(result.stderr, /\| next: /);
  });
});

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-error-protocol-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCli(cwd, argv, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...argv], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
