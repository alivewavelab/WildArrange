import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  applyContractCardDecision,
  contractGovernancePaths,
  discoverTauriIpcContracts,
  findFrontendInvokes,
  findRegisteredCommands,
  findTauriCommands,
  inspectContractTask,
  persistContractScan,
  readContractRegistry,
  scanContractGovernanceUniverse,
} from "../src/infra/contract-governance.mjs";
import { listRegisteredCapabilities } from "../src/capabilities/gateway.mjs";
import { normalizeTask } from "../src/orchestration/plan-state.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { matchSkills } from "../src/ai/skill-matcher.mjs";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("bin/wildarrange.mjs");

test("Tauri IPC parser finds declarations, handler registrations and frontend invokes", () => {
  assert.deepEqual(findTauriCommands("#[tauri::command]\npub async fn launch_game(id: String) -> Result<(), String> { Ok(()) }"), [{
    name: "launch_game",
    signature: "launch_game(id: String) -> Result<(), String>",
    index: 0,
  }]);
  assert.equal(findRegisteredCommands("tauri::generate_handler![launch_game, gateway::dispatch]")[1].name, "dispatch");
  assert.equal(findFrontendInvokes("await invoke<Result>('launch_game', { id });")[0].name, "launch_game");
  assert.equal(findTauriCommands("// #[tauri::command]\n// fn fake() {}\nfn real() {} ").length, 0);
  assert.equal(findRegisteredCommands("/* tauri::generate_handler![fake] */").length, 0);
  assert.equal(findFrontendInvokes("// invoke('fake')\nconst note = \"invoke('not_code')\";").length, 0);
});

test("Tauri IPC discovery reports contracts and SQL that requires manual declaration", async () => {
  const rootDir = await fixtureProject();
  const result = await discoverTauriIpcContracts(rootDir);
  const contract = result.contracts.find((item) => item.id === "tauri:launch_game");
  assert.equal(contract.status, "observed");
  assert.equal(contract.callers[0].path, "client/src/game.ts");
  assert.deepEqual(result.unknown[0], { contractId: "tauri:launch_game", fields: ["semantic_input_output"] });
  assert.equal(result.manualRequired[0].kind, "database_sql_in_source");
});

test("Tauri IPC discovery ignores a local function named invoke", async () => {
  const rootDir = await fixtureProject();
  await writeFile(path.join(rootDir, "client", "src", "local.ts"), "const invoke = (name) => name;\ninvoke('not_tauri');\n", "utf8");
  const result = await discoverTauriIpcContracts(rootDir);
  assert.ok(!result.contracts.some((item) => item.id === "tauri:not_tauri"));
});

test("Tauri IPC discovery follows an aliased invoke import", async () => {
  const rootDir = await fixtureProject();
  await writeFile(path.join(rootDir, "client", "src", "alias.ts"), "import { invoke as tauriInvoke } from '@tauri-apps/api/core';\ntauriInvoke('aliased_command');\n", "utf8");
  const result = await discoverTauriIpcContracts(rootDir);
  assert.ok(result.contracts.some((item) => item.id === "tauri:aliased_command"));
});

test("scan persists cards, archives the previous snapshot, and approved cards update registry", async () => {
  const rootDir = await fixtureProject();
  const first = await scanContractGovernanceUniverse(rootDir, { at: "2026-01-01T00:00:00.000Z" });
  assert.equal(first.registryPresent, false);
  assert.ok(first.cards.some((item) => item.contractId === "tauri:launch_game"));
  await persistContractScan(rootDir, first);

  const second = await scanContractGovernanceUniverse(rootDir, { at: "2026-02-02T00:00:00.000Z" });
  await persistContractScan(rootDir, second);
  const paths = contractGovernancePaths(rootDir);
  const archived = await readFile(path.join(paths.archiveSnapshots, "2026-02-02T00-00-00-000Z.json"), "utf8");
  assert.match(archived, /contract_governance_scan/);
  const pending = second.cards.find((item) => item.contractId === "tauri:launch_game");
  const cardOnDisk = JSON.parse(await readFile(path.join(paths.cards, `${pending.id.replaceAll(":", "_")}.json`), "utf8"));
  assert.equal(cardOnDisk.status, "expired");

  const decision = await applyContractCardDecision(rootDir, {
    cardId: pending.id,
    decision: "approve",
    reason: "developer confirmed baseline",
    expectedFingerprint: pending.fingerprint,
  });
  assert.equal(decision.status, "approved");
  const registry = await readContractRegistry(rootDir);
  assert.ok(registry.contracts.some((item) => item.id === "tauri:launch_game"));
});

test("contract review warns before onboarding and fails an undeclared changed contract after baseline", async () => {
  const rootDir = await fixtureProject();
  const task = { id: "T001", contractChanges: { declared: false, items: [] } };
  assert.equal((await inspectContractTask(rootDir, task, {})).status, "warn");

  const initial = await scanContractGovernanceUniverse(rootDir);
  await persistContractScan(rootDir, initial);
  for (const card of initial.cards) {
    await applyContractCardDecision(rootDir, { cardId: card.id, decision: "approve", reason: "baseline", expectedFingerprint: card.fingerprint });
  }
  const rustPath = path.join(rootDir, "client", "src-tauri", "src", "lib.rs");
  await writeFile(rustPath, `${await readFile(rustPath, "utf8")}\n#[tauri::command]\nfn stop_game() {}\n`, "utf8");
  const reviewed = await inspectContractTask(rootDir, task, { scopeResult: { changedPaths: ["client/src-tauri/src/lib.rs"] } });
  assert.equal(reviewed.status, "fail");
  assert.ok(reviewed.findings.some((item) => item.code === "contract_declaration_missing"));
});

test("manual contracts survive later automatic scans and destructive changes fail before onboarding", async () => {
  const rootDir = await fixtureProject();
  const declared = await scanContractGovernanceUniverse(rootDir, {
    declarations: [{ contractId: "database:games", kind: "database", action: "add", summary: "游戏目录表" }],
  });
  await persistContractScan(rootDir, declared);
  const databaseCard = declared.cards.find((item) => item.contractId === "database:games");
  await applyContractCardDecision(rootDir, { cardId: databaseCard.id, decision: "approve", reason: "database baseline", expectedFingerprint: databaseCard.fingerprint });
  const later = await scanContractGovernanceUniverse(rootDir);
  assert.ok(later.contracts.some((item) => item.id === "database:games"));
  assert.ok(!later.cards.some((item) => item.contractId === "database:games" && item.action === "remove"));

  const uninitialized = await fixtureProject();
  const destructive = await inspectContractTask(uninitialized, {
    id: "T002",
    contractChanges: { declared: true, items: [{ contractId: "tauri:old", kind: "tauri_command", action: "remove", summary: "删除旧命令", compatibility: "不兼容" }] },
  });
  assert.equal(destructive.status, "fail");
  assert.ok(destructive.findings.some((item) => item.code === "contract_destructive_approval_missing"));
});

test("changed contract sources require an approved baseline and embedded SQL requires a database declaration", async () => {
  const rootDir = await fixtureProject();
  const changed = { scopeResult: { changedPaths: ["client/src-tauri/src/lib.rs"] } };
  const withoutBaseline = await inspectContractTask(rootDir, { id: "T003", contractChanges: { items: [] } }, changed);
  assert.ok(withoutBaseline.findings.some((item) => item.code === "contract_baseline_required"));

  const initial = await scanContractGovernanceUniverse(rootDir);
  await persistContractScan(rootDir, initial);
  for (const card of initial.cards) {
    await applyContractCardDecision(rootDir, { cardId: card.id, decision: "approve", reason: "baseline", expectedFingerprint: card.fingerprint });
  }
  const sqlReview = await inspectContractTask(rootDir, { id: "T003", contractChanges: { items: [] } }, changed);
  assert.ok(sqlReview.findings.some((item) => item.code === "contract_manual_declaration_required"));
});

test("new scans supersede stale cards and stale approvals are rejected", async () => {
  const rootDir = await fixtureProject();
  const first = await scanContractGovernanceUniverse(rootDir);
  await persistContractScan(rootDir, first);
  const oldCard = first.cards.find((item) => item.contractId === "tauri:launch_game");
  const rustPath = path.join(rootDir, "client", "src-tauri", "src", "lib.rs");
  const rustSource = await readFile(rustPath, "utf8");
  await writeFile(rustPath, rustSource.replace("launch_game(id: String)", "launch_game(id: String, safe: bool)"), "utf8");
  await persistContractScan(rootDir, await scanContractGovernanceUniverse(rootDir));
  await assert.rejects(
    applyContractCardDecision(rootDir, { cardId: oldCard.id, decision: "approve", reason: "stale", expectedFingerprint: oldCard.fingerprint }),
    (error) => error.code === "contract_card_missing" || error.code === "contract_card_superseded",
  );
});

test("a failed card retirement does not write the approval or registry", async () => {
  const rootDir = await fixtureProject();
  const scan = await scanContractGovernanceUniverse(rootDir);
  await persistContractScan(rootDir, scan);
  const card = scan.cards[0];
  await assert.rejects(
    applyContractCardDecision(rootDir, {
      cardId: card.id,
      decision: "approve",
      reason: "simulate Windows lock",
      expectedFingerprint: card.fingerprint,
      operations: { rename: async () => { throw new Error("EPERM"); } },
    }),
    (error) => error.code === "contract_card_retire_failed",
  );
  assert.equal((await readContractRegistry(rootDir)).contracts.length, 0);
  const pendingPath = path.join(contractGovernancePaths(rootDir).cards, `${card.id.replaceAll(":", "_")}.json`);
  assert.equal(JSON.parse(await readFile(pendingPath, "utf8")).status, "pending");
});

test("an uncleanable prepared decision requires recovery and is never accepted as approval", async () => {
  const rootDir = await fixtureProject();
  const scan = await scanContractGovernanceUniverse(rootDir);
  await persistContractScan(rootDir, scan);
  const card = scan.cards[0];
  await assert.rejects(
    applyContractCardDecision(rootDir, {
      cardId: card.id,
      decision: "approve",
      reason: "simulate double Windows lock",
      expectedFingerprint: card.fingerprint,
      operations: {
        rename: async () => { throw new Error("EPERM rename"); },
        rm: async () => { throw new Error("EPERM cleanup"); },
      },
    }),
    (error) => error.code === "recovery_required",
  );
  assert.equal((await readContractRegistry(rootDir)).contracts.length, 0);
  const archiveDir = contractGovernancePaths(rootDir).archiveCards;
  const preparedFiles = await readdir(archiveDir);
  const prepared = JSON.parse(await readFile(path.join(archiveDir, preparedFiles[0]), "utf8"));
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.committed, false);
});

test("post-commit cleanup failure reports a warning without turning success into failure", async () => {
  const rootDir = await fixtureProject();
  const scan = await scanContractGovernanceUniverse(rootDir);
  await persistContractScan(rootDir, scan);
  const card = scan.cards[0];
  const result = await applyContractCardDecision(rootDir, {
    cardId: card.id,
    decision: "approve",
    reason: "approved before cleanup",
    expectedFingerprint: card.fingerprint,
    operations: { rm: async () => { throw new Error("EPERM cleanup"); } },
  });
  assert.equal(result.status, "approved");
  assert.match(result.cleanupWarning, /decision committed/);
  assert.ok((await readContractRegistry(rootDir)).contracts.some((item) => item.id === card.contractId));
});

test("approved metadata overlays survive discovery and approved removals retire contracts", async () => {
  const rootDir = await fixtureProject();
  const initial = await scanContractGovernanceUniverse(rootDir);
  await persistContractScan(rootDir, initial);
  for (const card of initial.cards) {
    await applyContractCardDecision(rootDir, { cardId: card.id, decision: "approve", reason: "baseline", expectedFingerprint: card.fingerprint });
  }

  const overlay = await scanContractGovernanceUniverse(rootDir, { declarations: [{ contractId: "tauri:launch_game", kind: "tauri_command", action: "modify", summary: "启动指定游戏", compatibility: "兼容现有调用" }] });
  await persistContractScan(rootDir, overlay);
  const overlayCard = overlay.cards.find((item) => item.contractId === "tauri:launch_game");
  await applyContractCardDecision(rootDir, { cardId: overlayCard.id, decision: "approve", reason: "metadata confirmed", expectedFingerprint: overlayCard.fingerprint });
  const carried = await scanContractGovernanceUniverse(rootDir);
  assert.equal(carried.contracts.find((item) => item.id === "tauri:launch_game").summary, "启动指定游戏");
  assert.equal(carried.cards.filter((item) => item.contractId === "tauri:launch_game").length, 0);

  const removal = await scanContractGovernanceUniverse(rootDir, { declarations: [{ contractId: "tauri:launch_game", kind: "tauri_command", action: "remove", summary: "删除启动命令", compatibility: "调用方同步删除" }] });
  await persistContractScan(rootDir, removal);
  const removalCard = removal.cards.find((item) => item.contractId === "tauri:launch_game");
  await applyContractCardDecision(rootDir, { cardId: removalCard.id, decision: "approve", reason: "developer approved removal", expectedFingerprint: removalCard.fingerprint });
  assert.equal((await readContractRegistry(rootDir)).contracts.find((item) => item.id === "tauri:launch_game").lifecycle, "retired");

  const task = { id: "T004", contractChanges: { items: [{ contractId: "tauri:launch_game", kind: "tauri_command", action: "remove", summary: "删除启动命令", compatibility: "调用方同步删除", approvalRef: removalCard.id }] } };
  assert.equal((await inspectContractTask(rootDir, task, {})).status, "pass");
});

test("task normalization preserves contractChanges and binds the governance Skill", () => {
  const task = normalizeTask({
    id: "T001",
    subject: "新增启动命令",
    owner: "ZhuRong",
    verify_commands: ["node --test test/example.test.mjs"],
    writable_paths: ["client/"],
    contractChanges: {
      declared: true,
      items: [{ contractId: "tauri:launch_game", kind: "tauri_command", action: "add", summary: "启动游戏" }],
    },
  }, 0);
  assert.equal(task.contractChanges.items[0].ownerRef, "ZhuRong");
  assert.ok(task.skills.includes("contract-governance"));
});

test("contract governance capabilities are statically registered", () => {
  const names = listRegisteredCapabilities();
  assert.ok(names.includes("contract-governance-scan"));
  assert.ok(names.includes("contract-governance-apply-card"));
  assert.ok(names.includes("contract-governance-generate-artifacts"));
});

test("contract governance Skill is installed and selected for interface or database changes", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-contract-skill-"));
  await initRuntime(rootDir);
  const matched = await matchSkills(rootDir, { text: "新增 Tauri 接口并增加数据库字段", stage: "clarify" });
  assert.ok(matched.matched.some((item) => item.name === "contract-governance"));
});

test("contracts CLI scans and generates the human-readable map", async () => {
  const rootDir = await fixtureProject();
  const scanned = await execFileAsync(process.execPath, [cliPath, "contracts", "scan"], { cwd: rootDir });
  assert.equal(JSON.parse(scanned.stdout).status, "pass");
  const generated = await execFileAsync(process.execPath, [cliPath, "contracts", "generate"], { cwd: rootDir });
  assert.equal(JSON.parse(generated.stdout).status, "pass");
  assert.match(await readFile(path.join(rootDir, "docs", "contracts", "contract-map.html"), "utf8"), /接口与数据库契约总图/);
});

async function fixtureProject() {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-contract-"));
  const rustDir = path.join(rootDir, "client", "src-tauri", "src");
  const frontendDir = path.join(rootDir, "client", "src");
  await mkdir(rustDir, { recursive: true });
  await mkdir(frontendDir, { recursive: true });
  await writeFile(path.join(rustDir, "lib.rs"), `
#[tauri::command]
pub async fn launch_game(id: String) -> Result<(), String> { Ok(()) }

fn main() {
  tauri::Builder::default().invoke_handler(tauri::generate_handler![launch_game]);
}

const SCHEMA: &str = "CREATE TABLE games (id TEXT PRIMARY KEY)";
`, "utf8");
  await writeFile(path.join(frontendDir, "game.ts"), `import { invoke } from "@tauri-apps/api/core";\nexport const launch = () => invoke("launch_game", { id: "g1" });\n`, "utf8");
  return rootDir;
}
