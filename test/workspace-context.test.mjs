import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  attachGovernanceRepository,
  clearWorkspaceContext,
  loadGovernanceContract,
  loadGovernanceVerificationDefaults,
  initializeGovernanceRepository,
  resolveWorkspaceContext,
} from "../src/infra/workspace-context.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { importPlan, loadTaskState } from "../src/orchestration/plan-state.mjs";
import { buildRegistryFromCards } from "../src/infra/verification-registry.mjs";
import { runCommandFile } from "../src/infra/command-runner.mjs";
import { scanProjectRules } from "../src/infra/rule-scanner.mjs";
import {
  clearWildArrangeRuntimeRoot,
  resolveWildArrangePath,
} from "../src/infra/runtime-store.mjs";

async function withWorkspace(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const root = await mkdtemp(path.join(baseDir, "workspace-context-"));
  const projectRoot = path.join(root, "project");
  const governanceRoot = path.join(root, "governance");
  const stateHome = path.join(root, "state-home");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(path.join(governanceRoot, "policy"), { recursive: true });
  await mkdir(path.join(governanceRoot, "verification"), { recursive: true });
  await writeFile(path.join(governanceRoot, "wildarrange-governance.json"), JSON.stringify({
    schemaVersion: 1,
    project: { repository: "https://example.test/product.git", defaultBranch: "main" },
    policyRoot: "policy",
    verificationRegistry: "verification/registry.json",
  }, null, 2));
  try {
    await fn({ root, projectRoot, governanceRoot, stateHome });
  } finally {
    clearWorkspaceContext(projectRoot);
    clearWildArrangeRuntimeRoot(projectRoot);
    await rm(root, { recursive: true, force: true });
  }
}

test("workspace context: unattached projects preserve legacy runtime semantics", async () => {
  await withWorkspace(async ({ projectRoot, stateHome }) => {
    const context = await resolveWorkspaceContext(projectRoot, { stateHome });
    assert.equal(context.mode, "legacy");
    assert.equal(context.attached, false);
    assert.equal(context.runtimeRoot, path.join(projectRoot, ".wildarrange"));
    assert.equal(resolveWildArrangePath(projectRoot, "team", "tasks.json"), path.join(projectRoot, ".wildarrange", "team", "tasks.json"));
  });
});

test("workspace context: governance scaffold writes only the external root and preserves existing policy", async () => {
  await withWorkspace(async ({ root, projectRoot }) => {
    const governanceRoot = path.join(root, "scaffolded-governance");
    const initialized = await initializeGovernanceRepository(projectRoot, {
      governanceRoot,
      repository: "https://example.test/scaffolded.git",
      defaultBranch: "main",
    });
    assert.deepEqual(initialized.created.sort(), ["policy/AGENTS.md", "verification/registry.json", "wildarrange-governance.json"].sort());
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);
    await writeFile(path.join(governanceRoot, "policy", "AGENTS.md"), "# Human policy\n");
    const repeated = await initializeGovernanceRepository(projectRoot, { governanceRoot, repository: "https://example.test/scaffolded.git" });
    assert.ok(repeated.preserved.includes("policy/AGENTS.md"));
    assert.equal(await readFile(path.join(governanceRoot, "policy", "AGENTS.md"), "utf8"), "# Human policy\n");
  });
});

test("workspace context: external governance policy is loaded without copying it into the project", async () => {
  await withWorkspace(async ({ projectRoot, governanceRoot, stateHome }) => {
    await writeFile(path.join(governanceRoot, "policy", "AGENTS.md"), "# External policy\n\nGOVERNANCE_POLICY_PROBE\n");
    const context = await attachGovernanceRepository(projectRoot, { governanceRoot, stateHome });
    const rules = await scanProjectRules(projectRoot, { controlRoot: projectRoot });
    assert.equal(rules.governanceRoot, governanceRoot);
    assert.equal(rules.governancePolicyRules, 1);
    assert.ok(rules.rules.some((rule) => rule.source === "governance_policy" && rule.path === "governance/policy/AGENTS.md"));
    assert.match(rules.rules.find((rule) => rule.source === "governance_policy").content, /GOVERNANCE_POLICY_PROBE/);
    assert.equal(existsSync(path.join(projectRoot, "AGENTS.md")), false);
    assert.equal(existsSync(path.join(context.runtimeRoot, "rules", "context.json")), true);
  });
});

test("workspace context: attach keeps runtime and governance outside the project", async () => {
  await withWorkspace(async ({ projectRoot, governanceRoot, stateHome }) => {
    const attached = await attachGovernanceRepository(projectRoot, { governanceRoot, stateHome });
    assert.equal(attached.mode, "external");
    assert.equal(attached.governanceRoot, governanceRoot);
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);
    assert.equal(resolveWildArrangePath(projectRoot, "team", "tasks.json"), path.join(attached.runtimeRoot, "team", "tasks.json"));

    clearWildArrangeRuntimeRoot(projectRoot);
    const resolved = await resolveWorkspaceContext(projectRoot, { stateHome });
    assert.equal(resolved.mode, "external");
    assert.equal(resolved.runtimeRoot, attached.runtimeRoot);
    const registry = JSON.parse(await readFile(path.join(stateHome, "registry.json"), "utf8"));
    assert.equal(registry.projects[attached.projectId].governanceRoot, governanceRoot);
  });
});

test("workspace context: governance and runtime roots cannot be nested in the project", async () => {
  await withWorkspace(async ({ projectRoot, governanceRoot, stateHome }) => {
    const nestedGovernance = path.join(projectRoot, "governance");
    await mkdir(path.join(nestedGovernance, "policy"), { recursive: true });
    await writeFile(path.join(nestedGovernance, "wildarrange-governance.json"), JSON.stringify({
      schemaVersion: 1,
      project: { repository: "https://example.test/product.git" },
      policyRoot: "policy",
      verificationRegistry: "verification/registry.json",
    }));
    await assert.rejects(
      attachGovernanceRepository(projectRoot, { governanceRoot: nestedGovernance, stateHome }),
      /governance root must be separate/,
    );
    await assert.rejects(
      attachGovernanceRepository(projectRoot, { governanceRoot, stateHome, runtimeRoot: path.join(projectRoot, "runtime") }),
      /runtime root must be separate/,
    );
  });
});

test("workspace context: governance contract paths cannot escape the repository", async () => {
  await withWorkspace(async ({ governanceRoot }) => {
    await writeFile(path.join(governanceRoot, "wildarrange-governance.json"), JSON.stringify({
      schemaVersion: 1,
      project: { repository: "https://example.test/product.git" },
      policyRoot: "../outside",
      verificationRegistry: "verification/registry.json",
    }));
    await assert.rejects(loadGovernanceContract(governanceRoot), /policyRoot escapes/);
  });
});

test("workspace context: attach rejects a project that already has local runtime state", async () => {
  await withWorkspace(async ({ projectRoot, governanceRoot, stateHome }) => {
    await resolveWorkspaceContext(projectRoot, { stateHome, legacy: true });
    await initRuntime(projectRoot);
    await assert.rejects(
      attachGovernanceRepository(projectRoot, { governanceRoot, stateHome }),
      /project-local \.wildarrange runtime state exists/,
    );
    assert.equal(existsSync(path.join(stateHome, "registry.json")), false);
  });
});

test("workspace context: governance verification defaults are additive and bound into imported tasks", async () => {
  await withWorkspace(async ({ projectRoot, governanceRoot, stateHome }) => {
    const registry = buildRegistryFromCards([
      { id: "verify-1", path: "package.json", status: "approved", action: "adopt", patch: { kind: "registry_plan_default", field: "verify_commands", command: "node --version" } },
      { id: "review-1", path: "package.json", status: "approved", action: "adopt", patch: { kind: "registry_plan_default", field: "review_commands", command: "node --version" } },
    ]);
    await writeFile(path.join(governanceRoot, "verification", "registry.json"), JSON.stringify(registry, null, 2));
    // 计划导入要求治理仓有 Git HEAD 且干净（无 HEAD 时 fail-fast）
    for (const args of [
      ["init"],
      ["config", "user.email", "wildarrange-test@example.test"],
      ["config", "user.name", "WildArrange Test"],
      ["add", "."],
      ["commit", "-m", "governance baseline"],
    ]) {
      const result = await runCommandFile("git", ["-C", governanceRoot, ...args], governanceRoot, 15_000);
      assert.equal(result.exitCode, 0, result.stderr);
    }
    await attachGovernanceRepository(projectRoot, { governanceRoot, stateHome });
    await initRuntime(projectRoot);
    const binding = await loadGovernanceVerificationDefaults(projectRoot);
    assert.equal(binding.registryDigest, registry.digest);
    assert.deepEqual(binding.planDefaults.verify_commands, ["node --version"]);

    const planPath = path.join(projectRoot, "plan.json");
    await writeFile(planPath, JSON.stringify({
      id: "P-EXTERNAL",
      title: "External governance defaults",
      defaults: { verify_commands: ["node -e \"process.exit(0)\""] },
      tasks: [{ id: "T001", subject: "Write project output", worker_command: "node --version", writable_paths: ["src/**"] }],
    }));
    await importPlan(projectRoot, planPath);
    const state = await loadTaskState(projectRoot);
    assert.deepEqual(state.tasks[0].verify_commands, ["node --version", "node -e \"process.exit(0)\""]);
    assert.deepEqual(state.tasks[0].review_commands, ["node --version"]);
    assert.equal(state.governance_binding.registryDigest, registry.digest);
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);
  });
});

test("workspace context: tampered governance verification registry blocks plan import", async () => {
  await withWorkspace(async ({ projectRoot, governanceRoot, stateHome }) => {
    const registry = buildRegistryFromCards([]);
    registry.planDefaults.verify_commands.push("node --version");
    await writeFile(path.join(governanceRoot, "verification", "registry.json"), JSON.stringify(registry, null, 2));
    await attachGovernanceRepository(projectRoot, { governanceRoot, stateHome });
    await initRuntime(projectRoot);
    const planPath = path.join(projectRoot, "plan.json");
    await writeFile(planPath, JSON.stringify({ title: "Tampered governance", tasks: [{ subject: "Do work", verify_commands: ["node --version"], writable_paths: ["src/**"] }] }));
    await assert.rejects(importPlan(projectRoot, planPath), /registry digest mismatch/);
  });
});

test("workspace context: uncommitted governance policy cannot control a new plan", async () => {
  await withWorkspace(async ({ projectRoot, governanceRoot, stateHome }) => {
    const registry = buildRegistryFromCards([]);
    await writeFile(path.join(governanceRoot, "verification", "registry.json"), JSON.stringify(registry, null, 2));
    for (const args of [
      ["init"],
      ["config", "user.email", "wildarrange-test@example.test"],
      ["config", "user.name", "WildArrange Test"],
      ["add", "."],
      ["commit", "-m", "governance baseline"],
    ]) {
      const result = await runCommandFile("git", ["-C", governanceRoot, ...args], governanceRoot, 15_000);
      assert.equal(result.exitCode, 0, result.stderr);
    }
    await writeFile(path.join(governanceRoot, "policy", "AGENTS.md"), "# Unapproved governance change\n");
    await attachGovernanceRepository(projectRoot, { governanceRoot, stateHome });
    await initRuntime(projectRoot);
    await assert.rejects(loadGovernanceVerificationDefaults(projectRoot), /uncommitted changes/);
  });
});

test("workspace context: linked Git worktrees share project identity and runtime without losing their current root", async () => {
  await withWorkspace(async ({ root, projectRoot, governanceRoot, stateHome }) => {
    await writeFile(path.join(projectRoot, "README.md"), "baseline\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "wildarrange-test@example.test"],
      ["config", "user.name", "WildArrange Test"],
      ["add", "."],
      ["commit", "-m", "project baseline"],
    ]) {
      const result = await runCommandFile("git", ["-C", projectRoot, ...args], projectRoot, 15_000);
      assert.equal(result.exitCode, 0, result.stderr);
    }
    const linkedRoot = path.join(root, "linked-project");
    const worktree = await runCommandFile("git", ["-C", projectRoot, "worktree", "add", "--detach", linkedRoot], projectRoot, 15_000);
    assert.equal(worktree.exitCode, 0, worktree.stderr);
    const attached = await attachGovernanceRepository(projectRoot, { governanceRoot, stateHome });
    clearWorkspaceContext(projectRoot);
    clearWildArrangeRuntimeRoot(projectRoot);
    const linked = await resolveWorkspaceContext(linkedRoot, { stateHome });
    assert.equal(linked.projectId, attached.projectId);
    assert.equal(linked.runtimeRoot, attached.runtimeRoot);
    assert.equal(linked.projectRoot, linkedRoot);
  });
});

test("external onboarding: setup drafts use runtime and configuration belongs to governance", async () => {
  await withWorkspace(async ({ projectRoot, governanceRoot, stateHome }) => {
    const { configureProjectReview } = await import("../src/capabilities/project-review.mjs");
    const { loadWildArrangeConfig } = await import("../src/infra/runtime-config.mjs");
    const context = await attachGovernanceRepository(projectRoot, { governanceRoot, stateHome });
    await initRuntime(projectRoot);
    const drafts = path.join(context.runtimeRoot, "plan-drafts");
    await mkdir(drafts, { recursive: true });
    const draft = path.join(drafts, "setup.json");
    const { preToolUseGuard } = await import("../src/ai/pre-tool-guard.mjs");
    const guard = file => preToolUseGuard(projectRoot, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file } });
    assert.equal((await guard(draft)).code, "plan_draft_write");
    assert.equal((await guard(path.join(context.runtimeRoot, "config.json"))).decision, "deny");
    assert.equal((await guard(path.join(governanceRoot, "policy/wildarrange.config.json"))).decision, "deny");
    await writeFile(draft, JSON.stringify({ executionReadiness: { timeoutMs: 4321 } }));
    const configPath = path.join(governanceRoot, "policy/wildarrange.config.json");
    const preview = await configureProjectReview(projectRoot, ".wildarrange/plan-drafts/setup.json");
    assert.equal(preview.applied, false);
    const cliPreview = await runCommandFile(process.execPath, [path.join(process.cwd(), "bin/wildarrange.mjs"),
      "review", "configure", "--from", ".wildarrange/plan-drafts/setup.json"], projectRoot, 15_000,
      { env: { WILDARRANGE_STATE_HOME: stateHome } });
    assert.equal(cliPreview.exitCode, 0, cliPreview.stderr);
    assert.equal(JSON.parse(cliPreview.stdout).applied, false);
    assert.equal(existsSync(configPath), false);
    assert.equal((await configureProjectReview(projectRoot, draft, { apply: true })).applied, true);
    assert.equal((await loadWildArrangeConfig(projectRoot)).config.executionReadiness.timeoutMs, 4321);
    assert.equal(existsSync(path.join(projectRoot, "wildarrange.config.json")), false);
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);
    await writeFile(path.join(projectRoot, "outside.json"), "{}");
    await assert.rejects(configureProjectReview(projectRoot, "outside.json"), /plan-drafts/);
    await rm(drafts, { recursive: true });
    const outside = path.join(stateHome, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "setup.json"), "{}");
    await symlink(outside, drafts, process.platform === "win32" ? "junction" : "dir");
    assert.equal((await guard(draft)).decision, "deny");
    await assert.rejects(configureProjectReview(projectRoot, ".wildarrange/plan-drafts/setup.json"), /escapes/);
  });
});

test("external onboarding: commit A and B belong to governance while source freshness belongs to product", async () => {
  await withWorkspace(async ({ projectRoot, governanceRoot, stateHome }) => {
    const { startAdoption, decideAdoptionCard, applyApprovedCards, resumeAdoption } = await import("../src/orchestration/adoption.mjs");
    const { evaluateRegistryFreshness, readVerificationInventory } = await import("../src/infra/verification-registry.mjs");
    const git = async (root, args) => {
      const result = await runCommandFile("git", ["-C", root, ...args], root, 15_000);
      assert.equal(result.exitCode, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    await mkdir(path.join(projectRoot, "test"), { recursive: true });
    await writeFile(path.join(projectRoot, "test/ok.test.mjs"), "export const ok = 1;");
    await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "product", scripts: { test: "node --test test/ok.test.mjs" } }));
    await initializeGovernanceRepository(projectRoot, { governanceRoot, repository: "https://example.test/product.git" });
    for (const root of [projectRoot, governanceRoot]) {
      for (const args of [["init"], ["config", "user.email", "wa@example.test"], ["config", "user.name", "WA"], ["add", "."], ["commit", "-m", "baseline"]]) await git(root, args);
    }
    const initialRegistry = await readFile(path.join(governanceRoot, "verification/registry.json"), "utf8");
    const productHead = await git(projectRoot, ["rev-parse", "HEAD"]);
    await attachGovernanceRepository(projectRoot, { governanceRoot, stateHome });
    await initRuntime(projectRoot);
    const started = await startAdoption(projectRoot, { serve: false });
    assert.equal(started.ok, true);
    const locator = started.cards.find(card => card.asset === "config_locator");
    const command = started.cards.find(card => card.patch?.kind === "registry_plan_default");
    assert.ok(command, "scan must discover business package script");
    assert.equal(locator.path, "policy/wildarrange.config.json");
    assert.equal(locator.patch.value.verificationGovernance.registryPath, "verification/registry.json");
    for (const card of started.cards) {
      await decideAdoptionCard(projectRoot, { sessionId: started.session.sessionId, cardId: card.id, fingerprint: card.fingerprint,
        decision: [locator.id, command.id].includes(card.id) ? "approved" : "deferred" });
    }
    for (const card of [locator, command]) {
      const applied = await applyApprovedCards(projectRoot, { sessionId: started.session.sessionId, cardId: card.id });
      assert.equal(applied.ok, true, JSON.stringify(applied));
    }
    const preimageRoot = resolveWildArrangePath(projectRoot, "adoption/artifact-preimages");
    const preimages = await readdir(preimageRoot);
    assert.equal(preimages.length, 1);
    assert.equal(await readFile(path.join(preimageRoot, preimages[0]), "utf8"), initialRegistry);
    let resumed = await resumeAdoption(projectRoot, { serve: false });
    assert.equal(resumed.session.status, "awaiting_registry_commit", "old governance HEAD cannot satisfy commit A");
    await git(governanceRoot, ["add", "."]);
    await git(governanceRoot, ["commit", "-m", "commit A"]);
    const commitA = await git(governanceRoot, ["rev-parse", "HEAD"]);
    resumed = await resumeAdoption(projectRoot, { serve: false });
    assert.equal(resumed.session.status, "awaiting_final_commit", JSON.stringify(resumed.session));
    assert.equal(resumed.session.baselineRef, commitA);
    const inventory = await readVerificationInventory(path.join(governanceRoot, resumed.session.locator.inventoryPath));
    assert.equal(inventory.projectContext.headSha, productHead);
    await git(governanceRoot, ["add", "."]);
    await git(governanceRoot, ["commit", "-m", "commit B"]);
    resumed = await resumeAdoption(projectRoot, { serve: false });
    assert.equal(resumed.session.status, "finalized", JSON.stringify(resumed.session));
    assert.equal(await git(projectRoot, ["rev-parse", "HEAD"]), productHead);
    assert.equal(await git(projectRoot, ["status", "--porcelain"]), "");
    assert.equal((await evaluateRegistryFreshness(projectRoot)).status, "fresh");
    const { buildGovernanceFileIndex, tryHandleAdoptionApi } = await import("../src/interface/adoption-panel.mjs");
    const index = await buildGovernanceFileIndex(projectRoot);
    assert.equal(index.ledgers.every(item => item.exists && item.path.startsWith("governance/")), true);
    const response = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
    await tryHandleAdoptionApi({ method: "GET" }, response, new URL("http://localhost/api/adoption/file?path=governance/verification/registry.json"), projectRoot);
    assert.equal(response.code, 200);
    assert.equal(JSON.parse(response.body.file.content).kind, "verification_registry");
    await tryHandleAdoptionApi({ method: "GET" }, response, new URL("http://localhost/api/adoption/file?path=governance/../package.json"), projectRoot);
    assert.notEqual(response.code, 200);
    const { generateVerificationArtifacts } = await import("../src/capabilities/verification-governance.mjs");
    const registryPath = path.join(governanceRoot, "verification/registry.json");
    const registryBytes = await readFile(registryPath, "utf8");
    await assert.rejects(generateVerificationArtifacts(projectRoot, { cards: [], locator: resumed.session.locator, writeLocator: true }), /冲突/);
    assert.equal(await readFile(registryPath, "utf8"), registryBytes);
    await writeFile(path.join(projectRoot, "package.json"), '{"name":"changed"}');
    assert.equal((await evaluateRegistryFreshness(projectRoot)).status, "declared_input_drift");
  });
});

test("external onboarding: failed locator verifier restores governance and runs in product cwd", async () => {
  await withWorkspace(async ({ projectRoot, governanceRoot, stateHome }) => {
    const { applyVerificationCard } = await import("../src/capabilities/verification-governance.mjs");
    await attachGovernanceRepository(projectRoot, { governanceRoot, stateHome });
    await initRuntime(projectRoot);
    await writeFile(path.join(projectRoot, "verify.mjs"), 'console.log("PRODUCT_CWD");process.exit(1);');
    const original = '{"executionReadiness":{"timeoutMs":4321}}';
    const configPath = path.join(governanceRoot, "policy/wildarrange.config.json");
    await writeFile(configPath, original);
    await assert.rejects(applyVerificationCard(projectRoot, {
      sessionId: "adopt_rollback", card: { id: "locator", action: "adopt", asset: "config_locator",
        repositoryTarget: "governance", path: "policy/wildarrange.config.json",
        patch: { kind: "json_merge", path: "policy/wildarrange.config.json", value: { verificationGovernance: { registryPath: "verification/registry.json" } } },
        verify: ["node verify.mjs"] },
    }), error => error.recovered === true && error.verifyResults[0].stdout.includes("PRODUCT_CWD"));
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.equal(existsSync(path.join(projectRoot, "policy")), false);
  });
});
