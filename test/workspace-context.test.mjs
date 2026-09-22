import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  attachGovernanceRepository,
  clearWorkspaceContext,
  loadGovernanceContract,
  loadGovernanceVerificationDefaults,
  initializeGovernanceRepository,
  migrateLegacyWorkspace,
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

test("workspace context: legacy runtime is copied and verified before registry switches", async () => {
  await withWorkspace(async ({ projectRoot, governanceRoot, stateHome }) => {
    await resolveWorkspaceContext(projectRoot, { stateHome, legacy: true });
    await initRuntime(projectRoot);
    const sourceWork = await readFile(path.join(projectRoot, ".wildarrange", "work.json"), "utf8");

    await assert.rejects(
      attachGovernanceRepository(projectRoot, { governanceRoot, stateHome }),
      /state migrate --to external/,
    );
    const dryRun = await migrateLegacyWorkspace(projectRoot, { governanceRoot, stateHome, dryRun: true });
    assert.equal(dryRun.status, "planned");
    assert.equal(existsSync(path.join(stateHome, "registry.json")), false);

    const migrated = await migrateLegacyWorkspace(projectRoot, { governanceRoot, stateHome });
    assert.equal(migrated.status, "migrated");
    assert.equal(migrated.sourcePreserved, true);
    assert.equal(await readFile(path.join(migrated.context.runtimeRoot, "work.json"), "utf8"), sourceWork);
    assert.equal(await readFile(path.join(projectRoot, ".wildarrange", "work.json"), "utf8"), sourceWork);
    const resolved = await resolveWorkspaceContext(projectRoot, { stateHome });
    assert.equal(resolved.mode, "external");
    assert.equal(resolveWildArrangePath(projectRoot, "work.json"), migrated.context.runtimeRoot + path.sep + "work.json");
  });
});

test("workspace context: corrupted legacy ledger cannot switch registry", async () => {
  await withWorkspace(async ({ projectRoot, governanceRoot, stateHome }) => {
    await resolveWorkspaceContext(projectRoot, { stateHome, legacy: true });
    await initRuntime(projectRoot);
    await writeFile(path.join(projectRoot, ".wildarrange", "ledger.jsonl"), "{broken-json}\n", { flag: "a" });
    await assert.rejects(
      migrateLegacyWorkspace(projectRoot, { governanceRoot, stateHome }),
      /ledger verification failed/,
    );
    assert.equal(existsSync(path.join(stateHome, "registry.json")), false);
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange", "work.json")), true);
  });
});

test("workspace context: governance verification defaults are additive and bound into imported tasks", async () => {
  await withWorkspace(async ({ projectRoot, governanceRoot, stateHome }) => {
    const registry = buildRegistryFromCards([
      { id: "verify-1", path: "package.json", status: "approved", action: "adopt", patch: { kind: "registry_plan_default", field: "verify_commands", command: "node --version" } },
      { id: "review-1", path: "package.json", status: "approved", action: "adopt", patch: { kind: "registry_plan_default", field: "review_commands", command: "node --version" } },
    ]);
    await writeFile(path.join(governanceRoot, "verification", "registry.json"), JSON.stringify(registry, null, 2));
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
