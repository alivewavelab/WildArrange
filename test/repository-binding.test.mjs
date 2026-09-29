import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildAcceptanceProof } from "../src/capabilities/acceptance-proof.mjs";
import { runCommandFile } from "../src/infra/command-runner.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { clearWildArrangeRuntimeRoot } from "../src/infra/runtime-store.mjs";
import {
  attachGovernanceRepository,
  clearWorkspaceContext,
  loadGovernanceVerificationDefaults,
} from "../src/infra/workspace-context.mjs";
import { buildRegistryFromCards } from "../src/infra/verification-registry.mjs";
import { ensureLinearDeliveryWorkspace } from "../src/orchestration/linear-delivery.mjs";
import { coordinateTaskClaim, taskContract } from "../src/orchestration/remote-ownership.mjs";
import {
  inspectTaskRepositoryBinding,
  writeIntegrationAcceptance,
} from "../src/infra/repository-binding.mjs";

async function git(root, args) {
  const result = await runCommandFile("git", ["-C", root, ...args], root, 15_000);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}

async function initializeRepository(root, files, message) {
  await mkdir(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "wildarrange-test@example.invalid"]);
  await git(root, ["config", "user.name", "WildArrange Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", message]);
}

async function withExternalRepositories(fn) {
  const tempRoot = await mkdtemp(path.join(process.cwd(), ".tmp", "repository-binding-"));
  const projectRoot = path.join(tempRoot, "project");
  const governanceRoot = path.join(tempRoot, "governance");
  const stateHome = path.join(tempRoot, "state-home");
  const registry = buildRegistryFromCards([]);
  await initializeRepository(projectRoot, { "README.md": "project baseline\n" }, "project baseline");
  await initializeRepository(governanceRoot, {
    "wildarrange-governance.json": JSON.stringify({
      schemaVersion: 1,
      project: { repository: "https://example.invalid/product.git", defaultBranch: "main" },
      policyRoot: "policy",
      verificationRegistry: "verification/registry.json",
    }, null, 2),
    "policy/AGENTS.md": "# Governance policy\n",
    "verification/registry.json": JSON.stringify(registry, null, 2),
  }, "governance baseline");
  const context = await attachGovernanceRepository(projectRoot, { governanceRoot, stateHome });
  await initRuntime(projectRoot);
  try {
    await fn({ tempRoot, projectRoot, governanceRoot, context, registry });
  } finally {
    clearWorkspaceContext(projectRoot);
    clearWildArrangeRuntimeRoot(projectRoot);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test("governance-target task claims and creates its isolated worktree from the governance repository", async () => {
  await withExternalRepositories(async ({ projectRoot, governanceRoot }) => {
    const binding = await loadGovernanceVerificationDefaults(projectRoot);
    const task = {
      id: "T-GOV",
      repositoryTarget: "governance",
      blockedBy: [],
      governance_binding: {
        registryDigest: binding.registryDigest,
        projectRevision: binding.projectRevision,
        governanceRevision: binding.governanceRevision,
      },
    };
    task.coordination = await coordinateTaskClaim(projectRoot, { planId: "P-DUAL", task });
    assert.equal(task.coordination.repositoryTarget, "governance");
    assert.equal(task.coordination.baseSha, await git(governanceRoot, ["rev-parse", "HEAD"]));

    const workspace = await ensureLinearDeliveryWorkspace(projectRoot, "P-DUAL", task, [task]);
    assert.equal(workspace.repositoryRoot, governanceRoot);
    assert.equal(workspace.repositoryTarget, "governance");
    assert.equal(await git(workspace.workDir, ["rev-parse", "HEAD"]), task.coordination.baseSha);
    const commonDir = path.resolve(workspace.workDir, await git(workspace.workDir, ["rev-parse", "--git-common-dir"]));
    assert.equal(commonDir, path.join(governanceRoot, ".git"));
    assert.equal(await git(projectRoot, ["status", "--porcelain"]), "");
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);

    const pending = await inspectTaskRepositoryBinding(projectRoot, task, { deliveryPending: true });
    assert.equal(pending.pass, true);
    assert.equal(pending.status, "pending_delivery");
    assert.equal(pending.projectSha, binding.projectRevision.sha);

    await writeFile(path.join(workspace.workDir, "policy", "QUALITY.md"), "# Updated quality policy\n");
    await git(workspace.workDir, ["add", "policy/QUALITY.md"]);
    await git(workspace.workDir, ["commit", "-m", "update governance quality policy"]);
    const governanceDeliverySha = await git(workspace.workDir, ["rev-parse", "HEAD"]);
    const delivered = await inspectTaskRepositoryBinding(projectRoot, task, {
      integrationCommit: { commitSha: governanceDeliverySha },
    });
    assert.equal(delivered.pass, true);
    assert.equal(delivered.governanceSha, governanceDeliverySha);
    assert.equal(delivered.projectSha, binding.projectRevision.sha);

    await writeFile(path.join(projectRoot, "README.md"), "project baseline changed outside the governance task\n");
    await git(projectRoot, ["add", "README.md"]);
    await git(projectRoot, ["commit", "-m", "advance project independently"]);
    const drifted = await inspectTaskRepositoryBinding(projectRoot, task, {
      integrationCommit: { commitSha: governanceDeliverySha },
    });
    assert.equal(drifted.pass, false);
    assert.equal(drifted.checks.projectFrozen, false);
  });
});

test("integration acceptance binds exact project and governance commits without changing either repository", async () => {
  await withExternalRepositories(async ({ projectRoot, governanceRoot, context, registry }) => {
    const projectSha = await git(projectRoot, ["rev-parse", "HEAD"]);
    const governanceSha = await git(governanceRoot, ["rev-parse", "HEAD"]);
    const projectStatus = await git(projectRoot, ["status", "--porcelain"]);
    const governanceStatus = await git(governanceRoot, ["status", "--porcelain"]);

    const receipt = await writeIntegrationAcceptance(projectRoot, {
      projectSha,
      governanceSha,
      id: "release-candidate-1",
      reason: "pair independently delivered code and governance",
    });
    assert.equal(receipt.pass, true);
    assert.equal(receipt.projectSha, projectSha);
    assert.equal(receipt.governanceSha, governanceSha);
    assert.equal(receipt.registryDigest, registry.digest);
    assert.equal(receipt.receiptPath.startsWith(context.runtimeRoot), true);
    assert.equal(existsSync(receipt.receiptPath), true);
    const persisted = JSON.parse(await readFile(receipt.receiptPath, "utf8"));
    assert.equal(persisted.kind, "dual_repository_integration_acceptance");
    assert.equal(await git(projectRoot, ["status", "--porcelain"]), projectStatus);
    assert.equal(await git(governanceRoot, ["status", "--porcelain"]), governanceStatus);
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);

    await assert.rejects(
      writeIntegrationAcceptance(projectRoot, { projectSha: "0".repeat(40), governanceSha }),
      /project commit is unavailable/,
    );
  });
});

test("acceptance proof exposes the dual-repository binding as a mandatory check", () => {
  const task = {
    id: "T-DUAL",
    subject: "Bound delivery",
    governance_binding: { registryDigest: "digest" },
    verify_commands: [],
  };
  const failed = buildAcceptanceProof("P-DUAL", task, {
    repositoryBinding: { kind: "dual_repository_binding", pass: false, reason: "project baseline moved" },
  });
  const failedCheck = failed.checks.find((check) => check.name === "dual_repository_binding");
  assert.equal(failedCheck.status, "fail");
  assert.match(failedCheck.evidence, /project baseline moved/);

  const passing = buildAcceptanceProof("P-DUAL", task, {
    repositoryBinding: {
      kind: "dual_repository_binding",
      pass: true,
      repositoryTarget: "project",
      projectSha: "a".repeat(40),
      governanceSha: "b".repeat(40),
    },
  });
  assert.equal(passing.checks.find((check) => check.name === "dual_repository_binding").status, "pass");
});

test("handoff task contract preserves the external repository target and imported binding", () => {
  const binding = {
    registryDigest: "registry-digest",
    projectRevision: { sha: "a".repeat(40) },
    governanceRevision: { sha: "b".repeat(40) },
  };
  const contract = taskContract({
    id: "T-PROJECT",
    subject: "Project delivery",
    repositoryTarget: "project",
    governance_binding: binding,
    internalOnly: "not serialized",
  });
  assert.equal(contract.repositoryTarget, "project");
  assert.deepEqual(contract.governance_binding, binding);
  assert.equal(contract.internalOnly, undefined);
});
