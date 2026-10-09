// =============================================================================
// 文件名称：executor.test.mjs
// 所属模块：test
// 作用说明：验证内置执行者 `wildarrange executor probe|review|work --cli claude|kimi|cursor`：
//   各 CLI 的调用参数、包内容传递、JSON 提取、失败与旧回执判定、子会话标记，
//   以及经真实开工检查的端到端接线。全部使用假 CLI，不调用真实模型。
// =============================================================================
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommandFile } from "../src/infra/command-runner.mjs";
import { extractJsonObject, runExecutor } from "../src/interface/executor-cli.mjs";
import { gitCommitAll, withExternalProject, declare, importApprovedPlan } from "./helpers/external-fixture.mjs";

const CLI_PATH = path.join(process.cwd(), "bin", "wildarrange.mjs");

/**
 * 假模型 CLI：记录 argv/cwd/stdin/标记；FAKE_MODE 控制回答：
 * ok 正确回答，stale 旧挑战码，garbage 不含 JSON，fail 退出 1。输出格式随 FAKE_CLI 模仿真实 CLI。
 */
async function fakeCli(dir) {
  const bin = path.join(dir, "fake-model.cjs");
  await writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const dir = ${JSON.stringify(dir)};
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.writeFileSync(path.join(dir, "last.json"), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin, marker: process.env.WILDARRANGE_EXECUTOR_SESSION || null, kimiEngine: process.env.KIMI_CODE_EXPERIMENTAL_FLAG || null }));
const mode = process.env.FAKE_MODE || "ok", cli = process.env.FAKE_CLI;
if (mode === "fail") { console.error("model unavailable"); process.exit(1); }
const packetPath = process.env.WILDARRANGE_READINESS_PACKET || process.env.WILDARRANGE_REVIEW_PACKET;
let answer = "DONE: edited files";
if (packetPath) {
  // Codex has no file-read tool when commands are forbidden; it must receive the packet on stdin.
  if (cli === "codex" && (process.argv.at(-1) !== "-" || !stdin.includes("PACKET:\\n"))) { console.error("packet is not readable without commands"); process.exit(1); }
  if (cli === "kimi" && process.argv.includes("--agent") && process.env.KIMI_CODE_EXPERIMENTAL_FLAG !== "1") { console.error("plan agent requires the v2 engine"); process.exit(1); }
  const p = JSON.parse(cli === "codex" ? stdin.split("PACKET:\\n")[1] : fs.readFileSync(packetPath, "utf8"));
  answer = p.kind === "execution_readiness_probe"
    ? JSON.stringify({ ready: true, challenge: mode === "stale" ? "old-challenge" : p.challenge, loadedSkills: p.requiredSkills.map((s) => s.name) })
    : JSON.stringify({ decision: "PASS", checks: Object.keys(p.rules || {}).map((rule) => ({ rule, decision: "PASS", reason: "fake" })), findings: [] });
}
if (mode === "garbage") answer = "I could not decide.";
const outIndex = process.argv.indexOf("-o");
if (cli === "codex") { fs.writeFileSync(process.argv[outIndex + 1], answer); process.stdout.write("codex log line\\ntokens used: 10\\n"); }
else if (cli === "kimi") process.stdout.write("• Reading the packet.\\n• " + answer + "\\n\\nTo resume this session: kimi -r x\\n");
else process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "Here you go:\\n\`\`\`json\\n" + answer + "\\n\`\`\`" }));
`, "utf8");
  await chmod(bin, 0o755);
  return bin;
}

async function lastCall(dir) {
  return JSON.parse(await readFile(path.join(dir, "last.json"), "utf8"));
}

async function withPacket(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-executor-"));
  const packetPath = path.join(dir, "probe.json");
  await writeFile(packetPath, JSON.stringify({ kind: "execution_readiness_probe", challenge: "c-42", requiredSkills: [{ name: "programming" }], instruction: "Return only JSON {ready:true,challenge,loadedSkills}" }));
  const bin = await fakeCli(dir);
  await fn({ dir, packetPath, bin });
}

test("extractJsonObject finds the answer inside prose, bullets and code fences", () => {
  assert.deepEqual(extractJsonObject('• {"a":1}\n\nTo resume: kimi -r x'), { a: 1 });
  assert.deepEqual(extractJsonObject('Here:\n```json\n{"s":"has } and { inside","n":{"x":[1,2]}}\n```'), { s: "has } and { inside", n: { x: [1, 2] } });
  assert.deepEqual(extractJsonObject('{not json} then {"ok":true}'), { ok: true });
  assert.equal(extractJsonObject("no object here"), null);
});

test("probe passes the packet to each CLI without putting it on the command line and returns only the JSON", async () => {
  await withPacket(async ({ dir, packetPath, bin }) => {
    for (const cli of ["claude", "kimi", "cursor", "codex"]) {
      const result = await runExecutor({ role: "probe", cli, bin, cwd: dir, env: { WILDARRANGE_READINESS_PACKET: packetPath, FAKE_CLI: cli } });
      assert.equal(result.exitCode, 0, `${cli}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), { ready: true, challenge: "c-42", loadedSkills: ["programming"] }, cli);
      const call = await lastCall(dir);
      assert.equal(call.marker, "1", `${cli} child session must carry the executor marker so WildArrange hooks stay out of it`);
      assert.ok(!call.argv.join(" ").includes("c-42"), `${cli}: packet content must not be passed as an argument`);
      if (cli === "claude") {
        assert.ok(call.stdin.includes("c-42"), "claude receives the packet on stdin");
        assert.deepEqual(call.argv.slice(0, 3), ["-p", "--output-format", "json"]);
        for (const tool of ["Bash", "Edit", "Write"]) assert.ok(call.argv.includes(tool), `claude probe must disallow ${tool}`);
      } else if (cli === "codex") {
        assert.ok(call.stdin.includes("c-42"), "codex receives the full packet without needing shell reads");
        assert.equal(call.argv.at(-1), "-");
      } else {
        assert.ok(call.argv.join(" ").includes(packetPath), `${cli} is pointed at the packet file`);
      }
      if (cli === "cursor") {
        assert.ok(call.argv.join(" ").includes("--mode ask"), "cursor probe runs read-only");
        // 实机：非交互模式不带 --trust 会停在"信任此目录"提示并退出 1
        assert.ok(call.argv.includes("--trust"), "cursor must trust the workspace non-interactively");
      }
      // kimi -p 会自动批准工具调用；只读由内置 plan 档案（无 Shell、无写文件工具）保证，实机已验证
      if (cli === "kimi") {
        assert.deepEqual(call.argv.slice(call.argv.indexOf("--agent"), call.argv.indexOf("--agent") + 2), ["--agent", "plan"], "kimi probe runs the read-only plan profile");
        assert.equal(call.kimiEngine, "1", "the plan profile requires the v2 engine");
      }
      // codex 的只读由操作系统沙盒保证（实机：写文件报 operation not permitted）
      if (cli === "codex") assert.deepEqual(call.argv.slice(call.argv.indexOf("--sandbox"), call.argv.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
    }
  });
});

test("probe failures are reported as failures, never as a ready answer", async () => {
  await withPacket(async ({ dir, packetPath, bin }) => {
    const run = (mode, extra = {}) => runExecutor({ role: "probe", cli: "claude", bin, cwd: dir, env: { WILDARRANGE_READINESS_PACKET: packetPath, FAKE_CLI: "claude", FAKE_MODE: mode }, ...extra });
    const garbage = await run("garbage");
    assert.notEqual(garbage.exitCode, 0);
    assert.match(garbage.stderr, /no JSON object/);
    const failed = await run("fail");
    assert.notEqual(failed.exitCode, 0);
    assert.match(failed.stderr, /model unavailable/);
    const missing = await run("ok", { bin: path.join(dir, "no-such-cli") });
    assert.notEqual(missing.exitCode, 0);
    assert.match(missing.stderr, /not found/);
    // 旧挑战码原样回传：由开工检查比对挑战码并拒绝（见下方端到端测试）
    const stale = await run("stale");
    assert.equal(JSON.parse(stale.stdout).challenge, "old-challenge");
    await assert.rejects(runExecutor({ role: "probe", cli: "gemini", bin, cwd: dir, env: {} }), /unsupported executor CLI/);
    await assert.rejects(runExecutor({ role: "probe", cli: "claude", bin, cwd: dir, env: {} }), /WILDARRANGE_READINESS_PACKET/);
  });
});

test("worker runs in the task directory with each CLI's file-editing mode and the task brief", async () => {
  await withPacket(async ({ dir, bin }) => {
    const contextPath = path.join(dir, "context.json");
    await writeFile(contextPath, JSON.stringify({ task: { id: "T009", subject: "Add greet", description: "Export greet(name).", writable_paths: ["src/greet.js"], successCriteria: [] }, skills: [] }));
    const worktree = await mkdtemp(path.join(os.tmpdir(), "wildarrange-worktree-"));
    for (const cli of ["claude", "kimi", "cursor", "codex"]) {
      const result = await runExecutor({ role: "work", cli, bin, cwd: worktree, env: { WILDARRANGE_EXECUTION_CONTEXT: contextPath, FAKE_CLI: cli } });
      assert.equal(result.exitCode, 0, `${cli}: ${result.stderr}`);
      const call = await lastCall(dir);
      assert.equal(await realpathOf(call.cwd), await realpathOf(worktree), `${cli} works inside the task worktree`);
      const brief = cli === "claude" ? call.stdin : call.argv.join(" ");
      assert.match(brief, /T009/);
      assert.match(brief, /src\/greet\.js/);
      assert.match(brief, /Do not commit/);
      if (cli === "claude") {
        assert.ok(call.argv.includes("acceptEdits"));
        assert.ok(!call.argv.includes("Bash"), "claude worker gets no shell tool");
      }
      // kimi 不允许 -p 与 --yolo/--auto 同用，-p 本身已自动批准（实机验证）
      if (cli === "kimi") {
        assert.ok(!call.argv.includes("--yolo") && !call.argv.includes("--agent"), "kimi worker uses plain -p with the default editing profile");
        assert.equal(call.kimiEngine, null, "worker must retain the user's default engine");
      }
      if (cli === "cursor") assert.ok(call.argv.includes("--force"), "cursor needs --force to edit non-interactively (approved by the user)");
      // codex 的 Worker 由沙盒限制在任务 worktree（实机：写主目录被拒）
      if (cli === "codex") assert.deepEqual(call.argv.slice(call.argv.indexOf("--sandbox"), call.argv.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"]);
    }
  });
});

test("readiness passes end to end with the built-in executor configured as the probe and reviewer", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot, root }) => {
    const bin = await fakeCli(root);
    const command = (role) => `node "${CLI_PATH}" executor ${role} --cli kimi --bin "${bin}"`;
    const configPath = path.join(governanceRoot, "policy", "wildarrange.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.executionReadiness = { ...config.executionReadiness, workerProbe: command("probe") };
    config.review = { ...config.review, responsibility: { ...config.review?.responsibility, command: command("review") } };
    await writeFile(configPath, JSON.stringify(config, null, 2));
    await gitCommitAll(governanceRoot, "built-in executors");
    const planPath = path.join(root, "plan.json");
    await writeFile(planPath, JSON.stringify({ title: "Executors", tasks: [{ id: "T001", subject: "Write", owner: "ZhuRong", writable_paths: ["src/a.js"], responsibilityChanges: declare("src/a.js"), worker_command: `node "${CLI_PATH}" executor work --cli claude`, verify_commands: ["node -e \"1\""] }] }));
    await importApprovedPlan(projectRoot, planPath);
    const env = { WILDARRANGE_STATE_HOME: path.join(root, "state-home"), FAKE_CLI: "kimi" };
    const ready = await runCommandFile(process.execPath, [CLI_PATH, "readiness", "--task", "T001"], projectRoot, 60_000, { env });
    assert.equal(JSON.parse(ready.stdout).status, "pass", ready.stdout);
    const stale = await runCommandFile(process.execPath, [CLI_PATH, "readiness", "--task", "T001"], projectRoot, 60_000, { env: { ...env, FAKE_MODE: "stale" } });
    assert.notEqual(JSON.parse(stale.stdout).status, "pass", "an old challenge must not pass readiness");
  });
});

test("runCommandFile can feed stdin to the child process", async () => {
  const result = await runCommandFile(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], process.cwd(), 10_000, { input: "hello-stdin" });
  assert.equal(result.stdout, "hello-stdin");
});

async function realpathOf(value) {
  const { realpath } = await import("node:fs/promises");
  return realpath(value);
}

test("host hook bridges stay out of executor child sessions", async () => {
  const { resolveWorkspaceContext } = await import("../src/infra/workspace-context.mjs");
  const { installAdapters } = await import("../src/interface/adapters.mjs");
  await withExternalProject(async ({ projectRoot, stateHome }) => {
    const workspace = await resolveWorkspaceContext(projectRoot, { stateHome });
    const report = await installAdapters(projectRoot, workspace, { target: "all", mode: "local", localCliPath: CLI_PATH });
    const payload = JSON.stringify({ hook_event_name: "Stop", session_id: "executor", cwd: projectRoot });
    for (const host of ["claude", "codex", "kimi"]) {
      const run = (marker) => runCommandFile(process.execPath, [report.targets[host].bridgePath], projectRoot, 30_000, { input: payload, env: { WILDARRANGE_STATE_HOME: stateHome, ...(marker ? { WILDARRANGE_EXECUTOR_SESSION: "1" } : {}) } });
      assert.notEqual((await run(false)).stdout, "", `${host}: a governed session normally gets hook output`);
      const silent = await run(true);
      assert.equal(silent.exitCode, 0);
      assert.equal(silent.stdout, "", `${host}: executor sessions must not get injection or continuation`);
    }
  });
});

test("doctor names missing executors with ready-to-copy built-in commands, and warns when the reviewer is not independent", async () => {
  const { runDoctor } = await import("../src/interface/doctor.mjs");
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    const missing = (await runDoctor(projectRoot)).findings.find((finding) => finding.code === "execution_readiness_unconfigured");
    assert.equal(missing?.severity, "error");
    assert.match(missing.message, /workerProbe/);
    assert.match(missing.message, /review\.responsibility\.command/);
    assert.match(missing.nextAction, /executor probe --cli \w+/);
    assert.match(missing.nextAction, /executor review --cli \w+/);

    const configPath = path.join(governanceRoot, "policy", "wildarrange.config.json");
    // reviewer:false 的夹具不生成治理配置文件，从空配置开始
    const config = JSON.parse(await readFile(configPath, "utf8").catch(() => "{}"));
    config.executionReadiness = { ...config.executionReadiness, workerProbe: "wildarrange executor probe --cli claude" };
    config.review = { ...config.review, responsibility: { ...config.review?.responsibility, command: "wildarrange executor review --cli claude" } };
    await writeFile(configPath, JSON.stringify(config, null, 2));
    await gitCommitAll(governanceRoot, "same executor");
    const findings = (await runDoctor(projectRoot)).findings;
    assert.equal(findings.some((finding) => finding.code === "execution_readiness_unconfigured"), false);
    assert.equal(findings.find((finding) => finding.code === "executor_reviewer_not_independent")?.severity, "warn");
  }, { reviewer: false });
});

test("the linear worker timeout is configurable and defaults long enough for model workers", async () => {
  const { runWorker } = await import("../src/capabilities/worker.mjs");
  const { DEFAULT_WILDARRANGE_CONFIG } = await import("../src/infra/default-config.mjs");
  assert.equal(DEFAULT_WILDARRANGE_CONFIG.executionReadiness.workerTimeoutMs, 1_800_000);
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    const configPath = path.join(governanceRoot, "policy", "wildarrange.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.executionReadiness = { ...config.executionReadiness, workerTimeoutMs: 1500 };
    await writeFile(configPath, JSON.stringify(config, null, 2));
    await gitCommitAll(governanceRoot, "short worker timeout");
    const startedAt = Date.now();
    const result = await runWorker(projectRoot, { worker_command: "node -e \"setTimeout(()=>{},10000)\"" });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - startedAt < 8000, "the configured timeout, not the old 120s default, applies");
  });
});

test("codex is found inside the ChatGPT desktop app when it is not on PATH, and preferred as the sandboxed worker", async () => {
  const { inspectExecutorConfig, resolveExecutorBin } = await import("../src/interface/executor-cli.mjs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-bundled-codex-"));
  const bundled = path.join(dir, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(bundled), { recursive: true });
  await writeFile(bundled, "#!/bin/sh\n");
  await chmod(bundled, 0o755);
  const claudeDir = path.join(dir, "bin");
  await mkdir(claudeDir);
  await writeFile(path.join(claudeDir, "claude"), "#!/bin/sh\n");
  assert.equal(resolveExecutorBin("codex", { pathEnv: claudeDir, appRoots: [dir] }), bundled);
  assert.equal(resolveExecutorBin("claude", { pathEnv: claudeDir, appRoots: [dir] }), "claude");
  const result = inspectExecutorConfig({}, { pathEnv: claudeDir, appRoots: [dir] });
  assert.deepEqual(result.available, ["codex", "claude"]);
  assert.match(result.recommended.workerProbe, /executor probe --cli codex$/);
  assert.match(result.recommended.reviewerCommand, /executor review --cli claude$/);
});

test("formal executor forwards cancellation to its separate model process group", { skip: process.platform === "win32" }, async () => {
  await withPacket(async ({ dir, packetPath, bin }) => {
    const pidFile = path.join(dir, "model.pid");
    await writeFile(packetPath, JSON.stringify({ kind: "project_review_step" }));
    await writeFile(bin, "#!/usr/bin/env node\nrequire('node:fs').writeFileSync("
      + JSON.stringify(pidFile) + ", String(process.pid)); setTimeout(()=>{},20000);\n");
    let finished = false;
    const pending = runExecutor({ role: "review", cli: "kimi", bin, cwd: dir,
      env: { WILDARRANGE_REVIEW_PACKET: packetPath } }).then(result => { finished = true; return result; });
    try {
      const deadline = Date.now() + 5000;
      let pid;
      while (!finished && Date.now() < deadline) {
        pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
        if (pid) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(pid, "model process started");
      process.emit("SIGTERM");
      const result = await pending;
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.stdout, "");
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      if (!finished && process.listenerCount("SIGTERM")) process.emit("SIGTERM");
      await pending;
    }
  });
});
