import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { invokeCapability } from "../src/capabilities/gateway.mjs";
import { applyVerificationCard, generateVerificationArtifacts, scanVerificationGovernance } from "../src/capabilities/verification-governance.mjs";
import {
  buildRegistryFromCards,
  buildInventory,
  digestCanonical,
  digestGitComparableContent,
  evaluateRegistryFreshness,
  gitBlobDigestEquals,
  readVerificationInventory,
  readGitBlobDigest,
} from "../src/infra/verification-registry.mjs";
import { runCommandFile } from "../src/infra/command-runner.mjs";
import { createWorkId, hashContent, readJson } from "../src/infra/runtime-store.mjs";
import { adoptionTransactionDir } from "../src/infra/recovery-transaction.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-governance-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("capability scan envelope is read-only and registered", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --version" } }, null, 2));
    const envelope = await invokeCapability("verification-governance-scan", { rootDir: dir });
    assert.equal(envelope.capability, "verification-governance-scan");
    assert.equal(envelope.status, "pass");
    assert.equal(envelope.sideEffect, "none");
    assert.equal(envelope.evidence.businessWrites, 0);
    assert.deepEqual(envelope.evidence.commandsExecuted, []);
  });
});

test("apply-card rolls back a failing verifier and keeps kind distinct", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "target.txt"), "old\n");
    const sessionId = createWorkId("adopt");
    const card = {
      id: "card_001_deadbeef",
      action: "change",
      path: "target.txt",
      fingerprint: "abc",
      patch: { kind: "write_text", path: "target.txt", content: "new\n" },
      verify: ["node -e \"process.exit(2)\""],
      status: "approved",
    };
    await assert.rejects(() => applyVerificationCard(dir, { sessionId, card }), /approved verifier failed/);
    assert.equal(await readFile(path.join(dir, "target.txt"), "utf8"), "old\n");
  });
});

test("generate artifacts and freshness require matching commit inputs", async () => {
  await withTempDir(async (dir) => {
    const locator = {
      registryPath: "docs/verification-registry.json",
      bootstrapPath: "docs/verification-bootstrap.json",
      inventoryPath: "docs/verification-inventory.json",
    };
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({
      verificationGovernance: locator,
    }, null, 2));
    const cards = [{
      id: "card_001_loc",
      action: "adopt",
      asset: "config_locator",
      path: "wildarrange.config.json",
      status: "approved",
      patch: { kind: "json_merge", path: "wildarrange.config.json", value: { verificationGovernance: locator } },
    }];
    const registryResult = await generateVerificationArtifacts(dir, { cards, locator, phase: "registry", writeLocator: true });
    assert.equal(registryResult.phase, "registry");
    const registry = JSON.parse(await readFile(path.join(dir, locator.registryPath), "utf8"));
    assert.equal(registry.schemaVersion, 1);
    assert.equal(typeof registry.digest, "string");
    assert.ok(registry.digest.length > 16);
    const handoff = await generateVerificationArtifacts(dir, {
      cards,
      locator,
      phase: "handoff",
      baselineRef: "abc123",
      universeFingerprint: "uni",
    });
    assert.equal(handoff.bootstrap.baselineRef, "abc123");
    assert.equal(handoff.inventory.registryDigest, registry.digest);
    const fresh = await evaluateRegistryFreshness(dir);
    assert.equal(fresh.stale, false);
    await writeFile(path.join(dir, locator.registryPath), `${JSON.stringify({ ...registry, extra: true }, null, 2)}\n`);
    const drifted = await evaluateRegistryFreshness(dir);
    assert.equal(drifted.stale, true);
    const rebuilt = buildRegistryFromCards(cards, { locator });
    assert.ok(rebuilt.digest);
    const scan = await scanVerificationGovernance(dir);
    assert.equal(scan.kind, "verification_governance_scan");
  });
});

test("handoff artifacts are fresh immediately and runner edits yellow-light declared inputs", async () => {
  await withTempDir(async (dir) => {
    const locator = {
      registryPath: "docs/verification-registry.json",
      bootstrapPath: "docs/verification-bootstrap.json",
      inventoryPath: "docs/verification-inventory.json",
    };
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({
      name: "legacy",
      scripts: { test: "node --version" },
    }, null, 2));
    await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({
      verificationGovernance: locator,
    }, null, 2));
    const cards = [{
      id: "card_001_loc",
      action: "adopt",
      asset: "config_locator",
      path: "wildarrange.config.json",
      status: "approved",
      patch: { kind: "json_merge", path: "wildarrange.config.json", value: { verificationGovernance: locator } },
    }];
    await generateVerificationArtifacts(dir, { cards, locator, phase: "registry", writeLocator: true });
    await generateVerificationArtifacts(dir, {
      cards,
      locator,
      phase: "handoff",
      baselineRef: "abc123",
      universeFingerprint: "uni",
    });
    const fresh = await evaluateRegistryFreshness(dir);
    assert.equal(fresh.status, "fresh");
    assert.equal(fresh.stale, false);
    await writeFile(path.join(dir, "business.txt"), "unrelated\n");
    const stillFresh = await evaluateRegistryFreshness(dir);
    assert.equal(stillFresh.stale, false, "unrelated business files must not yellow-light");
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    pkg.scripts.test = "node --test";
    await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    const drifted = await evaluateRegistryFreshness(dir);
    assert.equal(drifted.stale, true);
    assert.equal(drifted.status, "declared_input_drift");
  });
});

test("generated artifacts refuse occupied file names without overwriting legacy bytes", async () => {
  await withTempDir(async (dir) => {
    const locator = {
      registryPath: "verification-registry.json",
      bootstrapPath: "verification-bootstrap.json",
      inventoryPath: "verification-inventory.json",
    };
    const legacyBytes = "{\"owner\":\"legacy-project\"}\n";
    await writeFile(path.join(dir, locator.registryPath), legacyBytes);

    await assert.rejects(
      () => generateVerificationArtifacts(dir, { cards: [], locator, phase: "registry" }),
      (error) => {
        assert.equal(error.code, "artifact_conflict");
        assert.match(error.message, /verification-registry\.json/);
        assert.match(error.nextAction, /移走或改名/);
        return true;
      },
    );
    assert.equal(await readFile(path.join(dir, locator.registryPath), "utf8"), legacyBytes);

    const envelope = await invokeCapability("verification-governance-generate-artifacts", {
      rootDir: dir,
      options: { cards: [], locator, phase: "registry" },
    });
    assert.equal(envelope.status, "fail");
    assert.equal(envelope.error.code, "artifact_conflict");
    assert.equal(envelope.sideEffect, "none");
    assert.equal(await readFile(path.join(dir, locator.registryPath), "utf8"), legacyBytes);
  });
});

test("Inventory is a browser-readable HTML report with an embedded machine record", async () => {
  await withTempDir(async (dir) => {
    const locator = {
      registryPath: "docs/verification-registry.json",
      bootstrapPath: "docs/verification-bootstrap.json",
      inventoryPath: "docs/verification-inventory.html",
    };
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "legacy", scripts: { test: "node --test" } }, null, 2));
    await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({ verificationGovernance: locator }, null, 2));
    const cards = [{
      id: "card_001_suite",
      action: "adopt",
      asset: "behavior_suite",
      path: "test/a.test.mjs",
      owner: "planDefaults.verify_commands",
      purpose: "保护核心行为",
      reason: "现有测试尚未进入统一目录",
      afterState: "未来计划会使用这条验证命令",
      maxConsequence: "配置错误会让未来任务验证失败",
      rollback: "从 Registry 移除该命令",
      confidence: "high",
      consumers: [{ grade: "runner", by: "package.json#test", evidence: "node --test" }],
      evidence: ["package.json#test"],
      status: "approved",
      patch: { kind: "registry_plan_default", field: "verify_commands", command: "node --test", sourcePath: "test/a.test.mjs" },
    }];
    await generateVerificationArtifacts(dir, { cards, locator, phase: "registry" });
    const handoff = await generateVerificationArtifacts(dir, {
      cards,
      locator,
      phase: "handoff",
      baselineRef: "abc123",
      universeFingerprint: "uni",
    });

    const html = await readFile(path.join(dir, locator.inventoryPath), "utf8");
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /输入\s*→\s*处理\s*→\s*输出/);
    assert.match(html, /当前真源/);
    assert.match(html, /Git 基线/);
    assert.match(html, /当前分支/);
    assert.match(html, /未提交改动/);
    assert.match(html, /历史档案/);
    assert.match(html, /已删除墓碑/);
    assert.match(html, /暂缓确认/);
    assert.match(html, /保护核心行为/);
    const parsed = await readVerificationInventory(path.join(dir, locator.inventoryPath));
    assert.deepEqual(parsed, handoff.inventory);
    assert.equal(parsed.views.currentSources[0].path, "test/a.test.mjs");
    assert.equal((await evaluateRegistryFreshness(dir)).status, "fresh");
    const repeated = await generateVerificationArtifacts(dir, {
      cards,
      locator,
      phase: "handoff",
      baselineRef: "abc123",
      universeFingerprint: "uni",
    });
    assert.equal(repeated.written.every((item) => item.reused === true), true);
  });
});

test("handoff preflights every destination and reports a directory conflict with zero writes", async () => {
  await withTempDir(async (dir) => {
    const locator = {
      registryPath: "docs/verification-registry.json",
      bootstrapPath: "docs/verification-bootstrap.json",
      inventoryPath: "docs/verification-inventory.json",
    };
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await generateVerificationArtifacts(dir, { cards: [], locator, phase: "registry" });
    await mkdir(path.join(dir, locator.bootstrapPath));

    const envelope = await invokeCapability("verification-governance-generate-artifacts", {
      rootDir: dir,
      options: {
        cards: [],
        locator,
        phase: "handoff",
        baselineRef: "abc123",
        universeFingerprint: "uni",
      },
    });

    assert.equal(envelope.status, "fail");
    assert.equal(envelope.error.code, "artifact_conflict");
    assert.match(envelope.error.message, /verification-bootstrap\.json/);
    await assert.rejects(() => readFile(path.join(dir, locator.inventoryPath)), /ENOENT/);
  });
});

test("generating the same artifact twice is an idempotent reuse, not an overwrite", async () => {
  await withTempDir(async (dir) => {
    const locator = {
      registryPath: "verification-registry.json",
      bootstrapPath: "verification-bootstrap.json",
      inventoryPath: "verification-inventory.json",
    };
    const first = await generateVerificationArtifacts(dir, { cards: [], locator, phase: "registry" });
    const before = await readFile(path.join(dir, locator.registryPath), "utf8");
    const second = await generateVerificationArtifacts(dir, { cards: [], locator, phase: "registry" });
    const after = await readFile(path.join(dir, locator.registryPath), "utf8");
    assert.equal(after, before);
    assert.equal(first.registry.digest, second.registry.digest);
    assert.equal(second.written[0].reused, true);
  });
});

test("generated artifacts refuse a symlink destination without touching its target", async (t) => {
  await withTempDir(async (dir) => {
    const locator = {
      registryPath: "verification-registry.json",
      bootstrapPath: "verification-bootstrap.json",
      inventoryPath: "verification-inventory.json",
    };
    const target = path.join(dir, "legacy-registry.json");
    await writeFile(target, "{\"owner\":\"legacy-project\"}\n");
    try {
      await symlink(target, path.join(dir, locator.registryPath), "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) {
        t.skip(`symlink unavailable in this Windows environment: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => generateVerificationArtifacts(dir, { cards: [], locator, phase: "registry" }),
      (error) => error?.code === "artifact_conflict" && /符号链接/.test(error.message),
    );
    assert.equal(await readFile(target, "utf8"), "{\"owner\":\"legacy-project\"}\n");
  });
});

test("archive_move uses a committable root, backs up source and dest, and refuses collisions", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "docs", "old-notes.md"), "history\n");
    const sessionId = createWorkId("adopt");
    const card = {
      id: "card_002_archive",
      action: "archive",
      path: "docs/old-notes.md",
      fingerprint: "archive-fp",
      status: "approved",
      patch: { kind: "archive_move", path: "docs/old-notes.md", archiveRoot: "docs/verification-archive" },
      verify: [],
    };
    const first = await applyVerificationCard(dir, { sessionId, card });
    assert.equal(first.status, "committed");
    const dest = path.join(dir, "docs", "verification-archive", "docs", "old-notes.md");
    assert.equal(await readFile(dest, "utf8"), "history\n");
    await assert.rejects(() => readFile(path.join(dir, "docs", "old-notes.md")), /ENOENT/);
    const paths = first.paths || first.manifest?.paths || [];
    assert.ok(paths.includes("docs/old-notes.md"));
    assert.ok(paths.some((item) => item.replaceAll("\\", "/").includes("verification-archive")));
    assert.ok(!paths.some((item) => item.replaceAll("\\", "/").startsWith(".wildarrange/")));
    const collide = {
      ...card,
      id: "card_003_collide",
    };
    await writeFile(path.join(dir, "docs", "old-notes.md"), "again\n");
    await assert.rejects(() => applyVerificationCard(dir, { sessionId, card: collide }), /exists|conflict|closed/i);
    assert.equal(await readFile(path.join(dir, "docs", "old-notes.md"), "utf8"), "again\n");
    assert.equal(await readFile(dest, "utf8"), "history\n");
  });
});

test("apply-card reuses a prepared preimage instead of recapturing", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "target.txt"), "original\n");
    const sessionId = createWorkId("adopt");
    const card = {
      id: "card_004_prepared",
      action: "change",
      path: "target.txt",
      fingerprint: "prep",
      status: "approved",
      patch: { kind: "write_text", path: "target.txt", content: "new\n" },
      verify: [],
    };
    const txnDir = adoptionTransactionDir(dir, sessionId, card.id);
    const staging = path.join(txnDir, "preimage");
    await mkdir(path.join(staging), { recursive: true });
    await writeFile(path.join(staging, "target.txt"), "original\n");
    await writeFile(path.join(txnDir, "manifest.json"), JSON.stringify({
      kind: "adoption_change_recovery",
      schemaVersion: 1,
      transactionId: card.id,
      sessionId,
      cardId: card.id,
      status: "prepared",
      paths: ["target.txt"],
      preimage: [{ path: "target.txt", status: "copied", type: "file", digest: "keep-me" }],
    }, null, 2));
    await writeFile(path.join(dir, "target.txt"), "mutated-after-prepare\n");
    const result = await applyVerificationCard(dir, { sessionId, card });
    assert.equal(result.status, "committed");
    const manifest = await readJson(path.join(txnDir, "manifest.json"));
    assert.equal(manifest.preimage[0].digest, "keep-me");
    assert.equal(await readFile(path.join(staging, "target.txt"), "utf8"), "original\n");
  });
});

test("git blob digest matches committed content, not the working tree or a same-name older blob", async () => {
  await withTempDir(async (dir) => {
    await runCommandFile("git", ["-C", dir, "init"], dir, 15_000);
    await runCommandFile("git", ["-C", dir, "config", "user.email", "wa@example.com"], dir, 15_000);
    await runCommandFile("git", ["-C", dir, "config", "user.name", "WildArrange"], dir, 15_000);
    await runCommandFile("git", ["-C", dir, "config", "core.autocrlf", "false"], dir, 15_000);
    await writeFile(path.join(dir, "docs-registry.json"), "{\"v\":1}\n");
    await runCommandFile("git", ["-C", dir, "add", "docs-registry.json"], dir, 15_000);
    await runCommandFile("git", ["-C", dir, "commit", "-m", "old"], dir, 15_000);
    const old = await runCommandFile("git", ["-C", dir, "rev-parse", "HEAD"], dir, 15_000);
    const oldSha = old.stdout.trim();
    await writeFile(path.join(dir, "docs-registry.json"), "{\"v\":2}\n");
    await runCommandFile("git", ["-C", dir, "add", "docs-registry.json"], dir, 15_000);
    await runCommandFile("git", ["-C", dir, "commit", "-m", "new"], dir, 15_000);
    const head = await runCommandFile("git", ["-C", dir, "rev-parse", "HEAD"], dir, 15_000);
    const headSha = head.stdout.trim();
    await writeFile(path.join(dir, "docs-registry.json"), "{\"v\":dirty}\n");
    const expected = hashContent("{\"v\":2}\n");
    const blob = await readGitBlobDigest(dir, "docs-registry.json", headSha);
    assert.equal(blob.available, true);
    assert.equal(blob.digest, expected);
    assert.equal(await gitBlobDigestEquals(dir, "docs-registry.json", headSha, expected), true);
    assert.equal(await gitBlobDigestEquals(dir, "docs-registry.json", oldSha, expected), false);
    assert.equal(await gitBlobDigestEquals(dir, "docs-registry.json", headSha, hashContent("{\"v\":dirty}\n")), false);
  });
});

test("Inventory archive and tombstone views use appliedAt as the persisted execution fact", () => {
  const inventory = buildInventory({
    registryDigest: "registry",
    bootstrapDigest: "bootstrap",
    cards: [
      { id: "archive-1", action: "archive", status: "approved", appliedAt: "2026-09-03T00:00:00.000Z", path: "old.md" },
      { id: "delete-1", action: "delete", status: "approved", appliedAt: "2026-09-03T00:00:00.000Z", path: "gone.md" },
      { id: "archive-pending", action: "archive", status: "approved", path: "keep.md" },
    ],
  });
  assert.deepEqual(inventory.views.historicalArchives.map((item) => item.id), ["archive-1"]);
  assert.deepEqual(inventory.views.deletedTombstones.map((item) => item.id), ["delete-1"]);
});

test("git blob comparison tolerates core.autocrlf normalization", async () => {
  await withTempDir(async (dir) => {
    await runCommandFile("git", ["-C", dir, "init"], dir, 15_000);
    await runCommandFile("git", ["-C", dir, "config", "user.email", "wa@example.com"], dir, 15_000);
    await runCommandFile("git", ["-C", dir, "config", "user.name", "WildArrange"], dir, 15_000);
    await runCommandFile("git", ["-C", dir, "config", "core.autocrlf", "true"], dir, 15_000);
    const content = "{\r\n  \"v\": 2\r\n}\r\n";
    await writeFile(path.join(dir, "registry.json"), content, "utf8");
    const expected = digestGitComparableContent(content);
    await runCommandFile("git", ["-C", dir, "add", "registry.json"], dir, 15_000);
    await runCommandFile("git", ["-C", dir, "commit", "-m", "registry"], dir, 15_000);
    const head = await runCommandFile("git", ["-C", dir, "rev-parse", "HEAD"], dir, 15_000);
    assert.equal(await gitBlobDigestEquals(dir, "registry.json", head.stdout.trim(), expected), true);
  });
});
