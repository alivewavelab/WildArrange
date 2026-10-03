// =============================================================================
// 文件名称：claude-host.test.mjs
// 所属模块：test
// 作用说明：验证 Claude Code 宿主外置接入：插件包结构、Hook bridge 的拦截/注入/续跑、
//   未连接项目静默、doctor 回执，以及经 claude CLI 的显式激活与卸载（测试用假 CLI，
//   绝不触碰真实 ~/.claude）。
// =============================================================================
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveWorkspaceContext } from "../src/infra/workspace-context.mjs";
import { runDoctor } from "../src/interface/doctor.mjs";
import { activateClaudeAdapter, installAdapters, uninstallAdapters } from "../src/interface/adapters.mjs";
import { withExternalProject, declare, importApprovedPlan } from "./helpers/external-fixture.mjs";

const CLI_PATH = path.join(process.cwd(), "bin", "wildarrange.mjs");
const HAS_CLAUDE = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;

/** 生成 Claude 插件包；importTask 时导入只允许写 src/result.js 的已批准计划。 */
async function prepareClaude({ projectRoot, stateHome }, { importTask = true } = {}) {
  const workspace = await resolveWorkspaceContext(projectRoot, { stateHome });
  const report = await installAdapters(projectRoot, workspace, { target: "claude", mode: "local", localCliPath: CLI_PATH });
  if (importTask) {
    const planPath = path.join(stateHome, "plan.json");
    await writeFile(planPath, JSON.stringify({
      id: "claude-plan",
      title: "Claude host",
      tasks: [{
        id: "T001", subject: "Write result", owner: "ZhuRong",
        writable_paths: ["src/result.js"], responsibilityChanges: declare("src/result.js"),
        worker_command: "node -e \"1\"", verify_commands: ["node -e \"1\""],
      }],
    }));
    await importApprovedPlan(projectRoot, planPath);
  }
  return { workspace, report, entry: report.targets.claude };
}

function runBridge(bridgePath, payload, stateHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath], {
      cwd: payload.cwd, env: { ...process.env, WILDARRANGE_STATE_HOME: stateHome }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** 假 claude CLI：记录参数与 CLAUDE_CONFIG_DIR；marketplace/插件状态存在旁边的 JSON；FAIL_ON 命中的子命令返回 1。 */
async function fakeClaude(dir) {
  // 以 CommonJS 运行，不依赖任何 package.json 的 type
  const bin = path.join(dir, "fake-claude.cjs");
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(args) + "\\n");
fs.appendFileSync(path.join(dir, "env.log"), (process.env.CLAUDE_CONFIG_DIR || "") + "\\n");
fs.appendFileSync(path.join(dir, "cwd.log"), process.cwd() + "\\n");
const load = (name) => fs.existsSync(path.join(dir, name)) ? JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) : [];
const save = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
const sub = args.slice(0, 3).join(" ");
if (process.env.FAKE_CLAUDE_FAIL_ON && sub.startsWith(process.env.FAKE_CLAUDE_FAIL_ON)) { console.error("boom"); process.exit(1); }
if (sub === "plugin marketplace list") { console.log(JSON.stringify(load("marketplaces.json"))); process.exit(0); }
if (sub === "plugin marketplace add") save("marketplaces.json", [...load("marketplaces.json"), { name: "wildarrange-local", source: "directory", path: args[3] }]);
if (sub === "plugin marketplace remove") save("marketplaces.json", load("marketplaces.json").filter((m) => m.name !== args[3]));
if (sub === "plugin list --json") { console.log(JSON.stringify(load("plugins.json"))); process.exit(0); }
const bundleVersion = () => { const m = load("marketplaces.json")[0]; return m ? JSON.parse(fs.readFileSync(path.join(m.path, "plugins", "wildarrange-governance", ".claude-plugin", "plugin.json"), "utf8")).version : null; };
if (args[0] === "plugin" && args[1] === "install") save("plugins.json", [...load("plugins.json"), { id: args[2], scope: "user", enabled: true, version: bundleVersion() }]);
if (args[0] === "plugin" && args[1] === "update") save("plugins.json", load("plugins.json").map((p) => p.id === args[2] ? { ...p, version: bundleVersion() } : p));
if (args[0] === "plugin" && args[1] === "uninstall") save("plugins.json", load("plugins.json").filter((p) => p.id !== args[2]));
process.exit(0);
`, "utf8");
  await chmod(bin, 0o755);
  return bin;
}

async function calls(dir) {
  const text = existsSync(path.join(dir, "calls.log")) ? await readFile(path.join(dir, "calls.log"), "utf8") : "";
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).join(" "));
}

test("claude bundle is a valid local marketplace plugin under runtime, with no customer files", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot } = roots;
    const { entry } = await prepareClaude(roots, { importTask: false });
    const marketplaceRoot = path.dirname(path.dirname(entry.marketplacePath));
    const marketplace = JSON.parse(await readFile(entry.marketplacePath, "utf8"));
    assert.equal(marketplace.name, "wildarrange-local");
    assert.deepEqual(marketplace.plugins.map((plugin) => [plugin.name, plugin.source]), [["wildarrange-governance", "./plugins/wildarrange-governance"]]);
    const manifest = JSON.parse(await readFile(entry.manifestPath, "utf8"));
    assert.equal(manifest.name, "wildarrange-governance");
    const hooks = JSON.parse(await readFile(entry.hooksPath, "utf8")).hooks;
    assert.match(hooks.PreToolUse[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\//);
    for (const tool of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      assert.ok(hooks.PreToolUse[0].matcher.split("|").includes(tool), tool);
    }
    assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PreToolUse", "SessionStart", "Stop", "SubagentStop", "UserPromptSubmit"]);
    assert.ok(existsSync(path.join(entry.pluginRoot, "skills", "wildarrange-status", "SKILL.md")));
    assert.ok(entry.pluginRoot.startsWith(marketplaceRoot));
    assert.equal(existsSync(path.join(projectRoot, ".claude")), false);
    if (HAS_CLAUDE) {
      // marketplace 校验不打开插件内的 hooks；插件目录单独校验
      for (const target of [marketplaceRoot, entry.pluginRoot]) {
        const validated = spawnSync("claude", ["plugin", "validate", target], { encoding: "utf8" });
        assert.equal(validated.status, 0, validated.stdout + validated.stderr);
      }
    }
  });
});

test("claude bridge enforces scope, injects context, restores after compaction and continues unfinished work", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, stateHome } = roots;
    const { entry } = await prepareClaude(roots);
    const bridge = (payload) => runBridge(entry.bridgePath, { session_id: "claude-1", cwd: projectRoot, ...payload }, stateHome);
    const decision = (result) => JSON.parse(result.stdout).hookSpecificOutput;

    const allowed = await bridge({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(projectRoot, "src", "result.js"), content: "x" } });
    assert.equal(allowed.exitCode, 0, allowed.stderr);
    assert.notEqual(decision(allowed).permissionDecision, "deny");
    for (const tool_input of [{ file_path: path.join(projectRoot, "other.js"), content: "x" }, { notebook_path: path.join(projectRoot, "nb.ipynb"), new_source: "x" }]) {
      const denied = await bridge({ hook_event_name: "PreToolUse", tool_name: tool_input.notebook_path ? "NotebookEdit" : "Write", tool_input });
      assert.equal(denied.exitCode, 0, denied.stderr);
      assert.equal(decision(denied).permissionDecision, "deny", JSON.stringify(tool_input));
      assert.match(decision(denied).permissionDecisionReason, /out|scope|planned/i);
    }

    const started = await bridge({ hook_event_name: "SessionStart", source: "startup" });
    assert.match(started.stdout, /<wildarrange-injection event="SessionStart"/);
    // Claude Code 的 PostCompact 不能注入上下文；压缩后的 SessionStart(source=compact) 承担恢复
    const compacted = await bridge({ hook_event_name: "SessionStart", source: "compact" });
    assert.match(compacted.stdout, /<wildarrange-injection event="PostCompact"/);

    const post = await bridge({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(projectRoot, "src", "result.js") }, tool_response: {} });
    assert.equal(post.exitCode, 0, post.stderr);
    const postOutput = JSON.parse(post.stdout).hookSpecificOutput;
    assert.equal(postOutput.hookEventName, "PostToolUse");
    assert.match(postOutput.additionalContext, /<wildarrange-injection event="PostToolUse"/);

    const stop = await bridge({ hook_event_name: "Stop" });
    assert.equal(JSON.parse(stop.stdout).decision, "block", stop.stdout);
    // 已被 Stop Hook 拉回过一次：放行停止，避免空转到 Claude Code 的连续拦截上限
    const again = await bridge({ hook_event_name: "Stop", stop_hook_active: true });
    assert.equal(again.exitCode, 0, again.stderr);
    assert.equal(again.stdout, "");

    const unrelated = await mkdtemp(path.join(os.tmpdir(), "wildarrange-claude-unrelated-"));
    try {
      const silent = await runBridge(entry.bridgePath, { hook_event_name: "PreToolUse", session_id: "x", cwd: unrelated, tool_name: "Write", tool_input: { file_path: path.join(unrelated, "a.js") } }, stateHome);
      assert.equal(silent.exitCode, 0);
      assert.equal(silent.stdout, "");
    } finally {
      await rm(unrelated, { recursive: true, force: true });
    }

    const doctor = await runDoctor(projectRoot);
    assert.equal(doctor.sections.adapters.targets.find((target) => target.target === "claude")?.activation, "execution_observed");
  });
});

test("claude activation installs through the claude CLI idempotently and uninstall removes it", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, root } = roots;
    const { workspace, entry } = await prepareClaude(roots, { importTask: false });
    const fakeDir = await mkdtemp(path.join(root, "fake-claude-"));
    const claudeBin = await fakeClaude(fakeDir);
    const marketplaceRoot = path.dirname(path.dirname(entry.marketplacePath));

    const first = await activateClaudeAdapter(projectRoot, workspace, { claudeBin });
    assert.equal(first.status, "installed_waiting_for_lifecycle_receipt");
    assert.deepEqual(await calls(fakeDir), [
      `plugin validate ${marketplaceRoot}`,
      "plugin marketplace list --json",
      `plugin marketplace add ${marketplaceRoot}`,
      "plugin list --json",
      "plugin install wildarrange-governance@wildarrange-local --scope user",
    ]);
    await activateClaudeAdapter(projectRoot, workspace, { claudeBin });
    assert.deepEqual((await calls(fakeDir)).slice(5), [
      `plugin validate ${marketplaceRoot}`,
      "plugin marketplace list --json",
      "plugin marketplace update wildarrange-local",
      "plugin list --json",
    ], "re-activation refreshes the marketplace and skips an up-to-date plugin");
    assert.equal(existsSync(path.join(projectRoot, ".claude")), false);

    // Claude Code 运行的是安装时缓存的副本：插件包内容一变版本号必须变，再次激活才会刷新缓存
    const before = JSON.parse(await readFile(entry.manifestPath, "utf8")).version;
    assert.match(before, /^1\.0\.0-[0-9a-f]{12}$/);
    const changed = await installAdapters(projectRoot, workspace, { target: "claude", mode: "npx", localCliPath: CLI_PATH });
    assert.notEqual(JSON.parse(await readFile(changed.targets.claude.manifestPath, "utf8")).version, before);
    assert.ok((await runDoctor(projectRoot)).findings.some((finding) => finding.code === "external_adapter_config_modified" && /stale/.test(finding.message)), "doctor flags an installed plugin older than the bundle");
    const mark = (await calls(fakeDir)).length;
    await activateClaudeAdapter(projectRoot, workspace, { claudeBin });
    assert.ok((await calls(fakeDir)).slice(mark).includes("plugin update wildarrange-governance@wildarrange-local --scope user"));
    assert.ok(!(await runDoctor(projectRoot)).findings.some((finding) => finding.code === "external_adapter_config_modified"));

    const removed = await uninstallAdapters(projectRoot, workspace, { target: "claude", claudeBin });
    const tail = (await calls(fakeDir)).slice(-2);
    // 只动用户级声明：不带 --scope 的 remove 会连客户项目 .claude/settings*.json 里的同名声明一起删
    assert.deepEqual(tail, ["plugin uninstall wildarrange-governance@wildarrange-local --scope user", "plugin marketplace remove wildarrange-local --scope user"]);
    // 在客户项目里执行会读到项目级设置（例如项目禁用了插件），用户级操作因此误判；所有调用都在运行态目录执行
    const cwds = new Set((await readFile(path.join(fakeDir, "cwd.log"), "utf8")).trim().split("\n"));
    assert.deepEqual([...cwds], [path.join(workspace.runtimeRoot, "adapters", "external")]);
    assert.equal(existsSync(marketplaceRoot), false);
    assert.deepEqual(removed.nextActions, []);

    // --user-root 把 Claude Code 用户配置隔离到该目录，与 Cursor/Codex 的语义一致
    await installAdapters(projectRoot, workspace, { target: "claude", mode: "local", localCliPath: CLI_PATH });
    await activateClaudeAdapter(projectRoot, workspace, { claudeBin, userRoot: path.join(root, "home") });
    const envs = (await readFile(path.join(fakeDir, "env.log"), "utf8")).trim().split("\n");
    assert.equal(envs.at(-1), path.join(root, "home", ".claude"));
  });
});

test("claude activation reports a failing claude CLI and records no activation", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, root } = roots;
    const { workspace } = await prepareClaude(roots, { importTask: false });
    const fakeDir = await mkdtemp(path.join(root, "fake-claude-"));
    const claudeBin = await fakeClaude(fakeDir);
    process.env.FAKE_CLAUDE_FAIL_ON = "plugin install";
    try {
      await assert.rejects(activateClaudeAdapter(projectRoot, workspace, { claudeBin }), /claude plugin install .* failed: boom/);
    } finally {
      delete process.env.FAKE_CLAUDE_FAIL_ON;
    }
    const report = JSON.parse(await readFile(path.join(workspace.runtimeRoot, "adapters", "external", "install-report.json"), "utf8"));
    assert.equal(report.targets.claude.user, undefined);
    await assert.rejects(activateClaudeAdapter(projectRoot, workspace, { claudeBin: path.join(root, "no-such-claude") }), /claude CLI .*not found|ENOENT|failed/i);
  });
});

test("a project's own .claude hook settings are recognised as host automation during adoption", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const { scanVerificationUniverse } = await import("../src/capabilities/verification-discovery.mjs");
    const { buildGovernanceFileIndex } = await import("../src/interface/adoption-panel.mjs");
    const { cards } = await scanVerificationUniverse(projectRoot);
    assert.equal(cards.find((card) => card.path === ".claude/settings.json")?.asset, "host_hook", JSON.stringify(cards.map((card) => [card.path, card.asset])));
    const index = await buildGovernanceFileIndex(projectRoot);
    const automation = index.groups.find((group) => group.id === "automation").files.map((file) => file.path);
    assert.ok(automation.includes(".claude/settings.json"), automation.join(", "));
  }, { projectFiles: { "README.md": "# Fixture project\n", ".claude/settings.json": JSON.stringify({ hooks: { PreToolUse: [] } }) } });
});

test("activate --target all skips Claude Code for projects installed before it existed", async () => {
  await withExternalProject(async ({ projectRoot, stateHome, root }) => {
    const workspace = await resolveWorkspaceContext(projectRoot, { stateHome });
    for (const target of ["cursor", "codex"]) await installAdapters(projectRoot, workspace, { target, mode: "local", localCliPath: CLI_PATH });
    const { runCommandFile } = await import("../src/infra/command-runner.mjs");
    const result = await runCommandFile(process.execPath, [CLI_PATH, "adapter", "activate", "--target", "all", "--user-root", path.join(root, "home")], projectRoot, 60_000, { env: { WILDARRANGE_STATE_HOME: stateHome } });
    assert.equal(result.exitCode, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.claude.status, "skipped");
    assert.ok(parsed.cursor && parsed.codex);
  });
});

test("a failing CLI never makes the Claude bridge exit 2, which Claude Code would treat as a block", async () => {
  await withExternalProject(async ({ projectRoot, stateHome, root }) => {
    const workspace = await resolveWorkspaceContext(projectRoot, { stateHome });
    const exitTwo = path.join(root, "exit-two.mjs");
    await writeFile(exitTwo, "process.exit(2);\n");
    const report = await installAdapters(projectRoot, workspace, { target: "claude", mode: "local", localCliPath: exitTwo });
    const result = await runBridge(report.targets.claude.bridgePath, { hook_event_name: "PreToolUse", session_id: "x", cwd: projectRoot, tool_name: "Write", tool_input: { file_path: path.join(projectRoot, "a.js") } }, stateHome);
    assert.equal(result.exitCode, 1, "fail-open hosts must see a non-blocking error");
  });
});
