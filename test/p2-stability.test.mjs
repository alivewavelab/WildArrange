import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { inspectRepositoryGovernance } from "../src/infra/repository-layout.mjs";
import { readJson, resolveHelixPath } from "../src/infra/runtime-store.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { runNextTask } from "../src/orchestration/linear-runtime.mjs";
import { runWorkflow } from "../src/orchestration/workflow.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-p2-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function nodeEval(source) {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
}

async function writeMinimalPromptPack(rootDir, toolContent = "{\"tools\":[]}") {
  const packDir = path.join(rootDir, "source-pack");
  await mkdir(path.join(packDir, "tools"), { recursive: true });
  await writeFile(path.join(packDir, "tools", "tool-contract.json"), toolContent, "utf8");
  await writeFile(path.join(packDir, "manifest.json"), JSON.stringify({
    name: "p2-test-pack",
    description: "P2 stability test pack",
    source: { project: "test" },
    agents: {},
    skills: {},
    tools: "tools/tool-contract.json",
  }, null, 2), "utf8");
  return packDir;
}

async function ledgerEntries(rootDir) {
  const content = await readFile(resolveHelixPath(rootDir, "ledger.jsonl"), "utf8");
  return content.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test("initRuntime is quiet when state and Prompt Pack are unchanged, but reinstalls changed Pack content", async () => {
  await withTempDir(async (dir) => {
    const packDir = await writeMinimalPromptPack(dir);
    await initRuntime(dir, { promptPackDir: packDir });
    await initRuntime(dir, { promptPackDir: packDir });

    let ledger = await ledgerEntries(dir);
    assert.equal(ledger.filter((entry) => entry.type === "runtime_initialized").length, 1);
    assert.equal(ledger.filter((entry) => entry.type === "snapshot_written" && entry.stage === "initialized").length, 1);

    const changedTools = "{\"tools\":[{\"name\":\"changed\"}]}";
    await writeFile(path.join(packDir, "tools", "tool-contract.json"), changedTools, "utf8");
    await initRuntime(dir, { promptPackDir: packDir });

    ledger = await ledgerEntries(dir);
    assert.equal(ledger.filter((entry) => entry.type === "runtime_initialized").length, 2);
    assert.equal(
      await readFile(resolveHelixPath(dir, "prompt-pack", "installed", "tools", "tool-contract.json"), "utf8"),
      changedTools,
    );
  });
});

test("runNextTask reports a throwing gate without dereferencing null evidence", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "gate-error-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Gate error regression",
      tasks: [{
        id: "T001",
        subject: "Corrupt runtime config after worker startup",
        writable_paths: ["src/**"],
        worker_command: nodeEval("require('fs').writeFileSync('.helix/config.json', '{ broken', 'utf8')"),
        verify_commands: [nodeEval("process.exit(0)")],
        review_commands: [nodeEval("process.exit(0)")],
      }],
    }, null, 2), "utf8");
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "retry");
    assert.equal(result.task.status, "pending");
    assert.equal(result.task.last_failure.reason, "verifier_failed");
    assert.ok(result.task.evidence.every((entry) => entry !== null));
    assert.match(result.task.last_failure.observed, /JSON|Unexpected|position/i);
  });
});

test("runWorkflow stops after the first state that requires an external decision", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const configPath = resolveHelixPath(dir, "config.json");
    const config = await readJson(configPath);
    await writeFile(configPath, JSON.stringify({
      ...config,
      planApproval: { ...config.planApproval, required: true },
    }, null, 2), "utf8");
    const planPath = path.join(dir, "approval-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Approval wait regression",
      tasks: [{
        id: "T001",
        subject: "Wait for approval",
        verify_commands: [nodeEval("process.exit(0)")],
      }],
    }, null, 2), "utf8");
    await importPlan(dir, planPath);

    const result = await runWorkflow(dir, { maxSteps: 5 });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, "awaiting_plan_approval");
  });
});

test("repository governance turns a broken Prompt Pack manifest into an auditable finding", async () => {
  await withTempDir(async (dir) => {
    const packDir = path.join(dir, "packs", "wildarrange-linear");
    await mkdir(packDir, { recursive: true });
    await writeFile(path.join(packDir, "manifest.json"), "{ broken", "utf8");

    const result = await inspectRepositoryGovernance(dir, {
      enabled: true,
      governedRoots: [],
      requiredAgentBoundaries: [],
      documentationPairs: [],
    });
    assert.equal(result.status, "fail");
    const finding = result.findings.find((entry) => entry.ruleId === "prompt_manifest_invalid_json");
    assert.ok(finding);
    assert.equal(finding.path, "packs/wildarrange-linear/manifest.json");
  });
});
