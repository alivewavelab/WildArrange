// =============================================================================
// 文件名称：repository-binding.mjs
// 所属模块：infra
// 作用说明：复核并持久化项目 delivery SHA + 治理 SHA 的双仓验收绑定。
// =============================================================================
import path from "node:path";
import { digestCanonical } from "./verification-registry.mjs";
import { appendLedger } from "./ledger.mjs";
import { runCommandFile } from "./command-runner.mjs";
import { nowIso, resolveWildArrangePath, writeJsonAtomic } from "./runtime-store.mjs";
import { getBoundWorkspaceContext, loadGovernanceVerificationDefaults } from "./workspace-context.mjs";

/** 为任务 acceptance proof 生成当前双仓绑定；交付 commit 创建前允许 pending。 */
export async function inspectTaskRepositoryBinding(rootDir, task, evidence = {}) {
  const context = getBoundWorkspaceContext(rootDir);
  if (!context || context.mode !== "external") return null;
  const imported = task.governance_binding;
  if (!imported?.projectRevision || !imported?.governanceRevision) {
    return bindingFailure("plan has no imported dual-repository binding");
  }
  const current = await loadGovernanceVerificationDefaults(rootDir);
  const target = task.repositoryTarget || "project";
  const delivery = evidence.integrationCommit || evidence.deliveryBaseline || null;
  const deliverySha = delivery?.commitSha || delivery?.integrationSha || delivery?.actualSha || null;
  const pending = evidence.deliveryPending === true && !deliverySha;
  const projectSha = target === "project" ? deliverySha : current.projectRevision.sha;
  const governanceSha = target === "governance" ? deliverySha : current.governanceRevision.sha;
  const checks = {
    registryDigest: current.registryDigest === imported.registryDigest,
    projectFrozen: target === "project" || current.projectRevision.sha === imported.projectRevision.sha,
    governanceFrozen: target === "governance" || current.governanceRevision.sha === imported.governanceRevision.sha,
    deliveryPresent: Boolean(deliverySha) || pending,
    projectCommit: pending && target === "project"
      ? true
      : await commitExists(context.projectRoot, projectSha),
    governanceCommit: pending && target === "governance"
      ? true
      : await commitExists(context.governanceRoot, governanceSha),
  };
  return {
    kind: "dual_repository_binding",
    status: Object.values(checks).every(Boolean) ? (pending ? "pending_delivery" : "pass") : "fail",
    pass: Object.values(checks).every(Boolean),
    pending,
    repositoryTarget: target,
    projectSha: projectSha || null,
    governanceSha: governanceSha || null,
    registryDigest: current.registryDigest,
    importedProjectSha: imported.projectRevision.sha || null,
    importedGovernanceSha: imported.governanceRevision.sha || null,
    checks,
  };
}

/** 写入不修改任一仓库的 integration acceptance receipt。 */
export async function writeIntegrationAcceptance(rootDir, options = {}) {
  const context = getBoundWorkspaceContext(rootDir);
  if (!context || context.mode !== "external") throw new Error("integration acceptance requires an attached external governance workspace");
  const projectSha = requiredSha(options.projectSha, "project SHA");
  const governanceSha = requiredSha(options.governanceSha, "governance SHA");
  if (!(await commitExists(context.projectRoot, projectSha))) throw new Error(`project commit is unavailable: ${projectSha}`);
  if (!(await commitExists(context.governanceRoot, governanceSha))) throw new Error(`governance commit is unavailable: ${governanceSha}`);
  const registryPath = context.governanceContract.verificationRegistry;
  const registryAtCommit = await readJsonAtCommit(context.governanceRoot, governanceSha, registryPath);
  if (registryAtCommit.kind !== "verification_registry" || registryAtCommit.schemaVersion !== 1) {
    throw new Error("governance commit does not contain a valid verification registry");
  }
  const { digest, ...unsigned } = registryAtCommit;
  if (digest !== digestCanonical(unsigned)) throw new Error("governance commit verification registry digest mismatch");
  const id = String(options.id || `integration-${projectSha.slice(0, 12)}-${governanceSha.slice(0, 12)}`)
    .replace(/[^A-Za-z0-9._-]/g, "_");
  const receipt = {
    kind: "dual_repository_integration_acceptance",
    schemaVersion: 1,
    id,
    at: nowIso(),
    projectId: context.projectId,
    governanceId: context.governanceId,
    projectSha,
    governanceSha,
    registryPath,
    registryDigest: digest,
    reason: typeof options.reason === "string" ? options.reason : "",
    pass: true,
  };
  const receiptPath = resolveWildArrangePath(rootDir, "acceptance", "integrations", `${id}.json`);
  await writeJsonAtomic(receiptPath, receipt);
  await appendLedger(rootDir, {
    type: "dual_repository_integration_accepted",
    integrationId: id,
    projectSha,
    governanceSha,
    registryDigest: digest,
    receiptPath: path.relative(context.runtimeRoot, receiptPath),
  });
  return { ...receipt, receiptPath };
}

async function commitExists(repositoryRoot, sha) {
  if (!sha) return false;
  const result = await runCommandFile("git", ["-C", repositoryRoot, "cat-file", "-e", `${sha}^{commit}`], repositoryRoot, 15_000);
  return result.exitCode === 0;
}

async function readJsonAtCommit(repositoryRoot, sha, relativePath) {
  const gitPath = String(relativePath).split(path.sep).join("/");
  const result = await runCommandFile("git", ["-C", repositoryRoot, "show", `${sha}:${gitPath}`], repositoryRoot, 15_000);
  if (result.exitCode !== 0) throw new Error(`governance commit is missing ${gitPath}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`governance commit contains invalid JSON at ${gitPath}`);
  }
}

function requiredSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${label} must be a full 40-character commit SHA`);
  return value.toLowerCase();
}

function bindingFailure(reason) {
  return { kind: "dual_repository_binding", status: "fail", pass: false, pending: false, reason, checks: {} };
}
