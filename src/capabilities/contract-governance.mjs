import {
  applyContractCardDecision,
  generateContractArtifacts,
  inspectContractTask,
  persistContractScan,
  scanContractGovernanceUniverse,
} from "../infra/contract-governance.mjs";
import { nowIso } from "../infra/runtime-store.mjs";

export async function scanContractGovernance(rootDir, options = {}) {
  const startedAt = Date.now();
  const scan = await scanContractGovernanceUniverse(rootDir, options);
  const written = options.write === false ? null : await persistContractScan(rootDir, scan);
  return {
    ...scan,
    durationMs: Date.now() - startedAt,
    written,
  };
}

export async function applyContractGovernanceCard(rootDir, options = {}) {
  return applyContractCardDecision(rootDir, options);
}

export async function generateContractGovernanceArtifacts(rootDir) {
  return generateContractArtifacts(rootDir);
}

export async function runContractGovernanceReview(rootDir, task, evidence = {}) {
  const result = await inspectContractTask(rootDir, task, evidence);
  return {
    kind: "contract_governance_review",
    at: nowIso(),
    ...result,
  };
}
