// =============================================================================
// 文件名称：external-runtime-parity.test.mjs
// 所属模块：test
// 作用说明：
//   外置治理（projectRoot + governanceRoot + runtimeRoot）的运行态侧对等回归：
//   并行 admit、注入 Markdown、配置防篡改、零项目文件、治理仓 Git/配置脚手架。
// =============================================================================

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runCommandFile } from "../src/infra/command-runner.mjs";
import { admitParallelAgentResult, runParallelAgents } from "../src/orchestration/parallel-runtime.mjs";
import { generateContractArtifacts } from "../src/interface/contract-view.mjs";
import { applyContractCardDecision } from "../src/capabilities/contract-governance.mjs";
import { contractGovernancePaths, persistContractScan, scanContractGovernanceUniverse } from "../src/infra/contract-governance.mjs";
import { installAdapters } from "../src/interface/adapters.mjs";
import { initializeProjectGovernance } from "../src/interface/project-setup.mjs";
import { ensureTaskPacket, resolveRuntimeCliCommandPrefix } from "../src/infra/runtime-snapshot.mjs";
import { scanProjectRules } from "../src/infra/rule-scanner.mjs";
import { writeDefaultWildArrangeConfig } from "../src/infra/runtime-config.mjs";
import { getBoundWorkspaceContext } from "../src/infra/workspace-context.mjs";
import { buildPlanDraftDirective } from "../src/ai/routing.mjs";
import { preToolUseGuard } from "../src/ai/pre-tool-guard.mjs";
import { runDoctor } from "../src/interface/doctor.mjs";
import { restoreRuntimeStateBackup, verifyConfigBaseline, writeConfigBaseline, writeRuntimeStateBackup } from "../src/infra/security.mjs";
import { resolveInjectionPoint } from "../src/ai/injection.mjs";
import { resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { gitCommitAll, withExternalProject } from "./helpers/external-fixture.mjs";

async function git(cwd, args) {
  const result = await runCommandFile("git", args, cwd);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function resultCommand(filePath, content) {
  const encodedPath = Buffer.from(filePath, "utf8").toString("base64");
  const encodedContent = Buffer.from(content, "utf8").toString("base64");
  return [
    "node -e",
    JSON.stringify(`const fs=require('fs');const d=(v)=>Buffer.from(v,'base64').toString('utf8');fs.writeFileSync(process.argv[1],JSON.stringify({summary:'ready',files:[{path:d('${encodedPath}'),content:d('${encodedContent}')}]}));`),
    "{outputJson}",
  ].join(" ");
}

test("external parallel run -> admit works without touching the project runtime dir", async () => {
  await withExternalProject(async ({ root, projectRoot }) => {
    const planPath = path.join(root, "plan.json");
    await writeFile(planPath, JSON.stringify({
      id: "P-EXT",
      title: "External parallel admit",
      objective: "admit must not write patches into the project",
      tasks: [{
        id: "T001",
        subject: "Admit child artifact",
        writable_paths: ["src/**"],
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node -e \"if(!process.version)process.exit(1)\""],
      }],
    }, null, 2), "utf8");
    await importPlan(projectRoot, planPath);
    const batch = await runParallelAgents(projectRoot, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command: resultCommand("src/ext.txt", "ok\n"),
      isolation: "git-worktree",
    });
    const admitted = await admitParallelAgentResult(projectRoot, { runId: batch.runId, taskId: "T001" });
    assert.equal(admitted.status, "completed", JSON.stringify(admitted, null, 2));
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);
    assert.equal((await git(projectRoot, ["status", "--short"])).trim(), "");
  });
});

test("external session_start mounts default Markdown from the runtime root and reports missing files", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const snapshot = resolveWildArrangePath(projectRoot, "snapshots", "context.md");
    await mkdir(path.dirname(snapshot), { recursive: true });
    await writeFile(snapshot, "# External snapshot\n", "utf8");
    const point = await resolveInjectionPoint(projectRoot, "session_start", {});
    const mounted = point.markdown.find((item) => item.path === ".wildarrange/snapshots/context.md");
    assert.ok(mounted, JSON.stringify(point.markdown));
    assert.match(mounted.content, /External snapshot/);
    assert.ok(point.markdownMissing.some((item) => item.path === ".wildarrange/rules/context.md"), "absent default files are listed, not silent");
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);
  });
});

test("external config baseline fingerprints the governance config and doctor flags a dirty governance repo", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    const configPath = path.join(governanceRoot, "policy", "wildarrange.config.json");
    await writeFile(configPath, JSON.stringify({ reporting: { verbosity: "verbose" } }, null, 2), "utf8");
    await gitCommitAll(governanceRoot, "add governance config");
    const baseline = await writeConfigBaseline(projectRoot, { reason: "test" });
    assert.ok(baseline.files.some((file) => file.path === "governance:policy/wildarrange.config.json"), JSON.stringify(baseline.files));
    assert.equal(baseline.governance.clean, true);
    assert.match(baseline.governance.head, /^[0-9a-f]{40}$/);
    assert.equal((await verifyConfigBaseline(projectRoot)).ok, true);

    await writeFile(configPath, JSON.stringify({ reporting: { verbosity: "quiet" } }, null, 2), "utf8");
    const tampered = await verifyConfigBaseline(projectRoot);
    assert.equal(tampered.ok, false);
    assert.ok(tampered.failures.some((failure) => failure.reason === "hash_mismatch"));
    const report = await runDoctor(projectRoot);
    assert.ok(report.findings.some((finding) => finding.code === "governance_repository_dirty"), "dirty governance repo is reported");
    assert.ok(report.findings.some((finding) => finding.section === "config_baseline" && finding.severity === "error"));
  });
});

test("external state backup keeps a governance config copy but never restores into the governance repo", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    const configPath = path.join(governanceRoot, "policy", "wildarrange.config.json");
    await writeFile(configPath, "{}\n", "utf8");
    const manifest = await writeRuntimeStateBackup(projectRoot, { reason: "test" });
    const entry = manifest.files.find((file) => file.scope === "governance");
    assert.equal(entry?.status, "copied");
    await writeFile(configPath, "{\"changed\":true}\n", "utf8");
    const restored = await restoreRuntimeStateBackup(projectRoot, { backupId: manifest.backupId });
    assert.ok(restored.skipped.some((file) => file.reason === "governance_repository_managed"));
    assert.equal(await readFile(configPath, "utf8"), "{\"changed\":true}\n");
  });
});

test("external contracts scan keeps the customer project git status clean and lands registry in the governance repo", async () => {
  const projectFiles = {
    "client/src-tauri/src/lib.rs": "#[tauri::command]\npub async fn launch_game(id: String) -> Result<(), String> { Ok(()) }\nfn main() { tauri::Builder::default().invoke_handler(tauri::generate_handler![launch_game]); }\n",
    "client/src/game.ts": "import { invoke } from \"@tauri-apps/api/core\";\nexport const launch = () => invoke(\"launch_game\", { id: \"g1\" });\n",
  };
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    const scan = await scanContractGovernanceUniverse(projectRoot, {});
    await persistContractScan(projectRoot, scan);
    const card = scan.cards.find((item) => item.contractId === "tauri:launch_game");
    await applyContractCardDecision(projectRoot, { cardId: card.id, decision: "approve", reason: "baseline", expectedFingerprint: card.fingerprint });
    await generateContractArtifacts(projectRoot);
    assert.equal((await git(projectRoot, ["status", "--short"])).trim(), "", "project stays clean");
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);
    const paths = contractGovernancePaths(projectRoot);
    assert.ok(paths.registry.startsWith(governanceRoot) && existsSync(paths.registry));
    assert.ok(paths.html.startsWith(governanceRoot) && existsSync(paths.html));
  }, { projectFiles });
});

test("external plan draft directive points at the runtime root and the guard lets the host write it", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const directive = buildPlanDraftDirective({ route: "plan", needsPlan: true }, { sessionId: "ext", prompt: "add a feature", projectRoot, executionRoot: projectRoot });
    assert.equal(directive.draftPath, resolveWildArrangePath(projectRoot, "plan-drafts", "ext-plan.json"));
    assert.ok(path.isAbsolute(directive.draftPath));
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);
    const guard = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "ext",
      tool_name: "Write",
      tool_input: { file_path: directive.draftPath, content: "{}" },
    }, { executionRoot: projectRoot });
    assert.notEqual(guard.decision, "deny", JSON.stringify(guard));
  });
});

test("init-governance scaffolds an armed config, initializes Git once and never overwrites", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wildarrange-init-gov-"));
  try {
    const projectRoot = path.join(root, "project");
    const governanceRoot = path.join(root, "governance");
    await mkdir(projectRoot, { recursive: true });
    const first = await initializeProjectGovernance(projectRoot, { governanceRoot, repository: "https://example.test/p.git" });
    assert.ok(first.created.includes("policy/wildarrange.config.json"));
    assert.equal(first.gitInitialized, true);
    const config = JSON.parse(await readFile(path.join(governanceRoot, "policy", "wildarrange.config.json"), "utf8"));
    assert.equal(config.qualityGates.commentChecker.blockOnFindings, true, "quality gate is armed by default");
    const head = (await git(governanceRoot, ["rev-parse", "HEAD"])).trim();
    assert.equal((await git(governanceRoot, ["status", "--short"])).trim(), "", "initial commit contains every scaffold file");

    await writeFile(path.join(governanceRoot, "policy", "AGENTS.md"), "# Human policy\n", "utf8");
    const second = await initializeProjectGovernance(projectRoot, { governanceRoot, repository: "https://example.test/p.git" });
    assert.equal(second.gitInitialized, false);
    assert.equal(second.git.skipped, "already_a_git_repository");
    assert.equal(await readFile(path.join(governanceRoot, "policy", "AGENTS.md"), "utf8"), "# Human policy\n");
    assert.equal((await git(governanceRoot, ["rev-parse", "HEAD"])).trim(), head, "rerun does not commit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external config init --root writes the governance config, not the project", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    const result = await writeDefaultWildArrangeConfig(projectRoot, { root: true, armed: true });
    assert.equal(result.created, true);
    assert.equal(existsSync(path.join(governanceRoot, "policy", "wildarrange.config.json")), true);
    assert.equal(existsSync(path.join(projectRoot, "wildarrange.config.json")), false);
    assert.equal((await git(projectRoot, ["status", "--short"])).trim(), "");
  });
});

test("plan import fails fast when the governance repository has no Git HEAD", async () => {
  await withExternalProject(async ({ root, projectRoot, governanceRoot }) => {
    await rm(path.join(governanceRoot, ".git"), { recursive: true, force: true });
    const planPath = path.join(root, "plan.json");
    await writeFile(planPath, JSON.stringify({
      id: "P-NOGIT", title: "t", objective: "o",
      tasks: [{ id: "T001", subject: "s", writable_paths: ["src/**"], verify_commands: ["node --version"], review_commands: ["node --version"] }],
    }), "utf8");
    await assert.rejects(() => importPlan(projectRoot, planPath), /no Git HEAD[\s\S]*git -C .* init/);
  });
});

test("placeholder governance policy is not injected and doctor warns", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const rules = await scanProjectRules(projectRoot);
    assert.equal(rules.governancePolicyRules, 0);
    assert.equal(rules.rules.some((rule) => rule.source === "governance_policy"), false);
    const report = await runDoctor(projectRoot);
    assert.ok(report.findings.some((finding) => finding.code === "governance_policy_placeholder"));
  }, { policy: "# Policy\n\n- [待确认] fill me in\n" });
  await withExternalProject(async ({ projectRoot }) => {
    const rules = await scanProjectRules(projectRoot);
    assert.equal(rules.governancePolicyRules, 1);
    const report = await runDoctor(projectRoot);
    assert.equal(report.findings.some((finding) => finding.code === "governance_policy_placeholder"), false);
  });
});

test("doctor only judges hosts that the install report actually generated", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const workspace = getBoundWorkspaceContext(projectRoot);
    const none = await runDoctor(projectRoot);
    assert.ok(none.findings.some((finding) => finding.code === "external_adapter_not_prepared"));
    await installAdapters(projectRoot, workspace, { target: "codex", mode: "local", localCliPath: path.resolve("bin/wildarrange.mjs") });
    const report = await runDoctor(projectRoot);
    const adapterFindings = report.findings.filter((finding) => finding.section === "adapters");
    assert.deepEqual(adapterFindings.map((finding) => finding.target), ["codex"]);
    assert.equal(report.findings.some((finding) => finding.code === "external_adapter_not_prepared"), false);
    assert.equal(await resolveRuntimeCliCommandPrefix(projectRoot), `node "${path.resolve("bin/wildarrange.mjs")}"`, "external install report supplies the CLI prefix");
  });
});

test("task start baseline keeps successCriteria under its real key", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const task = { id: "T001", subject: "s", writable_paths: ["src/**"], verify_commands: ["node --version"], successCriteria: [{ title: "works", expectedEvidence: "exit 0" }] };
    await ensureTaskPacket(projectRoot, "P-BASE", task);
    const baseline = JSON.parse(await readFile(resolveWildArrangePath(projectRoot, "task-packets", "P-BASE", "T001", "baseline.json"), "utf8"));
    assert.deepEqual(baseline.task.successCriteria, task.successCriteria);
    assert.equal("success_criteria" in baseline.task, false);
  });
});

const execFileAsync = promisify(execFile);

test("setup wires governance repo, attach, runtime and adapters in one command without touching the project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wildarrange-setup-"));
  try {
    const projectRoot = path.join(root, "project");
    const governanceRoot = path.join(root, "governance");
    const env = { ...process.env, WILDARRANGE_STATE_HOME: path.join(root, "state") };
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "README.md"), "# customer\n", "utf8");
    await git(projectRoot, ["init", "-q", "-b", "main"]);
    await git(projectRoot, ["config", "user.name", "T"]);
    await git(projectRoot, ["config", "user.email", "t@example.invalid"]);
    await git(projectRoot, ["add", "-A"]);
    await git(projectRoot, ["commit", "-q", "-m", "seed"]);
    const cli = path.resolve("bin/wildarrange.mjs");
    const run = (args) => execFileAsync(process.execPath, [cli, ...args], { cwd: projectRoot, env }).catch((error) => error);

    const setup = await run(["setup", "--governance-root", governanceRoot, "--repository", "https://example.test/p.git", "--target", "codex"]);
    assert.equal(setup.code ?? 0, 0, setup.stderr);
    const result = JSON.parse(setup.stdout);
    assert.equal(result.kind, "wildarrange_setup");
    assert.ok(existsSync(result.adapters.codex.pluginRoot));
    assert.ok(result.nextActions.some((line) => line.includes("codex plugin marketplace add")));
    assert.equal((await git(projectRoot, ["status", "--short"])).trim(), "", "customer project stays clean");
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);
    assert.equal((await git(governanceRoot, ["status", "--short"])).trim(), "");
    assert.ok(existsSync(path.join(governanceRoot, "policy", "wildarrange.config.json")));

    const doctor = await run(["doctor"]);
    const report = JSON.parse(doctor.stdout);
    assert.deepEqual(report.findings.filter((finding) => finding.section === "adapters").map((finding) => finding.target), ["codex"]);
    assert.equal((await git(projectRoot, ["status", "--short"])).trim(), "");

    const missing = await run(["setup", "--governance-root", path.join(root, "g2")]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /--repository/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
