// =============================================================================
// 文件名称：cli-help.test.mjs
// 所属模块：test
// 作用说明：
//   验证 CLI 分层帮助：默认六核心命令、--help --all 全注册表、
//   docs commands 物化 Markdown、renderHelp 子集关系。
//   不测：各子命令业务语义或远程安装流程。
//
// 【运行原理速读】
//   执行 wildarrange --help / --help --all / docs commands，
//   对照 COMMAND_REGISTRY 与 CORE_COMMANDS 断言输出覆盖与分层。
// =============================================================================

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
  assert.match(core, /"generated_by": "host_semantic"/);
  assert.doesNotMatch(core, /"generated_by": "host_semantic \(/);
  assert.match(core, /"owner": "Jiuwei\|ZhuRong"/);
  assert.match(core, /"worker_command": "command that changes files"/);
});

test("command registry and bin dispatch are pinned to each other in both directions", async () => {
  const binSource = await readFile(WILDARRANGE_BIN, "utf8");

  // Leading literal tokens of a usage string, stopping at the first flag or
  // placeholder: "archivist suggestions resolve --id <id>" → ["archivist", "suggestions", "resolve"].
  const leadingTokens = (usage) => {
    const tokens = [];
    for (const token of usage.split(/\s+/)) {
      if (token.startsWith("[") || token.startsWith("--") || token.startsWith("<")) break;
      tokens.push(token);
    }
    return tokens;
  };
  const registryPaths = COMMAND_REGISTRY.map((entry) => leadingTokens(entry.usage));
  assert.ok(registryPaths.every((tokens) => tokens.length > 0), "every registry entry has a literal command token");

  // Split bin/wildarrange.mjs into per-command dispatch blocks; each block
  // runs until the next `command === "..."` check.
  const commandChecks = [...binSource.matchAll(/(?<![\w$])command === "([^"]+)"/g)];
  const blocksByCommand = new Map();
  for (const [index, check] of commandChecks.entries()) {
    const end = commandChecks[index + 1]?.index ?? binSource.length;
    const block = binSource.slice(check.index, end);
    blocksByCommand.set(check[1], [...(blocksByCommand.get(check[1]) || []), block]);
  }

  // registry -> bin: every registered command path has a real dispatch branch.
  // The subcommand literal must appear quoted in the block, or as a word in
  // the block's guard/error text (the `node` block names its nodes only in
  // the "requires" error message).
  for (const entry of COMMAND_REGISTRY) {
    const tokens = leadingTokens(entry.usage);
    const blocks = blocksByCommand.get(tokens[0]) || [];
    assert.ok(blocks.length > 0, `registry command "${entry.usage}" has no bin dispatch branch for "${tokens[0]}"`);
    const blockText = blocks.join("\n");
    for (const token of tokens.slice(1)) {
      const quoted = blockText.includes(`"${token}"`);
      const asWord = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(blockText);
      assert.ok(quoted || asWord, `registry command "${entry.usage}" has no bin branch for subcommand "${token}"`);
    }
  }

  // bin -> registry: every dispatch branch (command / subcommand / nested
  // action) is registered. Meta commands that only print help stay exempt.
  const META_COMMANDS = new Set(["help", "--help"]);
  const isRegisteredPrefix = (tokens) =>
    registryPaths.some((pathTokens) => tokens.every((token, i) => pathTokens[i] === token));
  for (const [command, blocks] of blocksByCommand) {
    if (META_COMMANDS.has(command)) continue;
    assert.ok(isRegisteredPrefix([command]), `bin branch "${command}" is not registered in COMMAND_REGISTRY`);
    for (const block of blocks) {
      const subcommands = [
        ...block.matchAll(/subcommand === "([^"]+)"/g),
        ...block.matchAll(/args\._\[1\] === "([^"]+)"/g),
      ].map((match) => match[1]).filter((token) => !token.startsWith("--"));
      for (const subcommand of subcommands) {
        assert.ok(isRegisteredPrefix([command, subcommand]), `bin branch "${command} ${subcommand}" is not registered in COMMAND_REGISTRY`);
      }
      const actions = [
        ...block.matchAll(/action === "([^"]+)"/g),
        ...block.matchAll(/args\._\[2\] === "([^"]+)"/g),
      ].map((match) => match[1]).filter((token) => !token.startsWith("--"));
      for (const action of actions) {
        assert.ok(
          subcommands.some((subcommand) => isRegisteredPrefix([command, subcommand, action])),
          `bin branch "${command} ... ${action}" is not registered in COMMAND_REGISTRY`,
        );
      }
    }
  }
});
