/**
 * CLI 分层与文档生成物测试：
 * - 默认 --help 只显示核心六命令；--help --all 显示完整注册表；
 * - docs commands 从注册表物化 Markdown（单一事实源）；
 * - 注册表条目与真实 CLI 分发一致（help 全量输出覆盖注册表每条命令）。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { COMMAND_REGISTRY, CORE_COMMANDS, renderCommandsMarkdown, renderHelp } from "../src/interface/cli-help.mjs";

const execFileAsync = promisify(execFile);
const WILDARRANGE_BIN = path.resolve(import.meta.dirname, "..", "bin", "wildarrange.mjs");
const ROOT = path.resolve(import.meta.dirname, "..");

test("default help shows only the core six commands with a pointer to --all", async () => {
  const { stdout } = await execFileAsync(process.execPath, [WILDARRANGE_BIN, "--help"], { cwd: ROOT });
  for (const core of CORE_COMMANDS) {
    assert.ok(stdout.includes(`wildarrange ${core}`), `core command ${core} must be in default help`);
  }
  assert.ok(!stdout.includes("parallel retry"), "non-core commands stay out of default help");
  assert.match(stdout, /--help --all/);
});

test("--help --all lists every registered command", async () => {
  const { stdout } = await execFileAsync(process.execPath, [WILDARRANGE_BIN, "--help", "--all"], { cwd: ROOT });
  for (const entry of COMMAND_REGISTRY) {
    assert.ok(stdout.includes(entry.usage), `missing from --help --all: ${entry.usage}`);
  }
  assert.ok(!stdout.includes("仅显示核心六命令"));
});

test("help --all (subcommand form) also works", async () => {
  const { stdout } = await execFileAsync(process.execPath, [WILDARRANGE_BIN, "help", "--all"], { cwd: ROOT });
  assert.ok(stdout.includes("parallel retry"));
});

test("docs commands materializes the registry as markdown", async () => {
  const markdown = renderCommandsMarkdown();
  assert.match(markdown, /请勿手改/);
  const rows = markdown.split("\n").filter((line) => line.startsWith("| `wildarrange"));
  assert.equal(rows.length, COMMAND_REGISTRY.length, "每一条注册命令都必须物化");

  const { stdout } = await execFileAsync(process.execPath, [WILDARRANGE_BIN, "docs", "commands"], { cwd: ROOT });
  assert.equal(stdout, markdown, "CLI 输出必须与注册表渲染一致");
});

test("docs commands --write writes doc/generated/commands.md", async () => {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-docs-"));
  try {
    const { stdout } = await execFileAsync(process.execPath, [WILDARRANGE_BIN, "docs", "commands", "--write"], { cwd: dir });
    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    const written = await readFile(path.join(dir, "doc", "generated", "commands.md"), "utf8");
    assert.equal(written, renderCommandsMarkdown());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderHelp core view is a strict subset of the full view", () => {
  const core = renderHelp({ all: false });
  const all = renderHelp({ all: true });
  assert.ok(core.length < all.length);
  assert.ok(all.includes("Plan schema"));
  assert.ok(core.includes("Plan schema"), "plan schema 对新手常驻");
});
