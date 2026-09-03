import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  applyApprovedCards,
  cancelAdoption,
  decideAdoptionCard,
  reconcileAdoption,
  recoverAdoption,
  resumeAdoption,
  startAdoption,
  statusAdoption,
} from "../src/orchestration/adoption.mjs";
import { withTaskStateLock } from "../src/infra/task-state-lock.mjs";
import {
  adoptionTransactionDir,
  createAdoptionRecoveryManifest,
  readMaintenanceMarker,
  writeMaintenanceMarker,
  writeRecoveryManifest,
} from "../src/infra/recovery-transaction.mjs";
import { runCommandFile } from "../src/infra/command-runner.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { hashContent, readJson, resolveWildArrangePath, writeJsonAtomic } from "../src/infra/runtime-store.mjs";
import { fingerprintCard } from "../src/infra/verification-discovery.mjs";
import { digestCanonical, gitBlobDigestEquals, readVerificationInventory } from "../src/infra/verification-registry.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-adoption-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function git(dir, args) {
  const result = await runCommandFile("git", ["-C", dir, ...args], dir, 15_000);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout || args.join(" "));
  return result;
}

async function seedProject(dir) {
  await initRuntime(dir);
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "legacy",
    scripts: { test: "node --version", lint: "node --version" },
  }, null, 2));
  await mkdir(path.join(dir, "test"), { recursive: true });
  await writeFile(path.join(dir, "test", "ok.test.mjs"), "export const ok = 1;\n");
  await writeFile(path.join(dir, "business.txt"), "keep\n");
}

async function decideAllCards(dir, sessionId, cards, approvedIds) {
  const approved = new Set(Array.isArray(approvedIds) ? approvedIds : [approvedIds]);
  for (const card of cards) {
    await decideAdoptionCard(dir, {
      sessionId,
      cardId: card.id,
      decision: approved.has(card.id) ? "approved" : "deferred",
      fingerprint: card.fingerprint,
    });
  }
}

async function initGitRepo(dir, extraPaths = []) {
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "wa@example.com"]);
  await git(dir, ["config", "user.name", "WildArrange"]);
  await git(dir, ["config", "core.autocrlf", "false"]);
  const addPaths = ["package.json", "business.txt", "test", ...extraPaths].filter((item) => existsSync(path.join(dir, item)));
  await git(dir, ["add", ...addPaths]);
  await git(dir, ["commit", "-m", "seed"]);
}

function locatorRegistryPath(locatorCard) {
  return locatorCard?.patch?.value?.verificationGovernance?.registryPath || "docs/verification-registry.json";
}

test("adoption start is read-only on business files and rejects a second start", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const first = await startAdoption(dir, { serve: false });
    assert.equal(first.ok, true);
    assert.equal(first.session.status, "reviewing");
    assert.ok(first.session.scannedAt);
    assert.ok(first.session.universeFingerprint);
    assert.equal(Array.isArray(first.session.scanWipPaths), true);
    assert.equal(await readFile(path.join(dir, "business.txt"), "utf8"), "keep\n");
    const second = await startAdoption(dir, { serve: false });
    assert.equal(second.ok, false);
    assert.equal(second.status, "session_exists");
  });
});

test("adoption decide and apply only touch approved locator, then wait for commit A", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator");
    assert.ok(locatorCard);
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id]);
    const applied = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.session.status, "awaiting_registry_commit");
    const config = JSON.parse(await readFile(path.join(dir, "wildarrange.config.json"), "utf8"));
    assert.ok(config.verificationGovernance.registryPath);
    assert.equal(await readFile(path.join(dir, "business.txt"), "utf8"), "keep\n");
  });
});

test("CODE-009: commit A/B require the generated blob, not a same-name older file", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "wa@example.com"]);
    await git(dir, ["config", "user.name", "WildArrange"]);
    await git(dir, ["config", "core.autocrlf", "false"]);
    await git(dir, ["add", "package.json", "business.txt", "test"]);
    await git(dir, ["commit", "-m", "seed"]);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator");
    assert.ok(locatorCard);
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id]);
    const applied = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.session.status, "awaiting_registry_commit");
    const locator = JSON.parse(await readFile(path.join(dir, "wildarrange.config.json"), "utf8")).verificationGovernance;
    const registryPath = locator.registryPath;
    const generatedBytes = await readFile(path.join(dir, registryPath), "utf8");
    const generatedDigest = hashContent(generatedBytes);
    assert.equal(applied.session.registryDigest, generatedDigest);

    await writeFile(path.join(dir, registryPath), "{\"kind\":\"stale-same-name\"}\n");
    await git(dir, ["add", registryPath, "wildarrange.config.json"]);
    await git(dir, ["commit", "-m", "wrong registry blob"]);
    const wrongHead = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    assert.equal(await gitBlobDigestEquals(dir, registryPath, wrongHead, generatedDigest), false);
    const blocked = await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });
    assert.equal(blocked.session.status, "awaiting_registry_commit");
    assert.equal(blocked.session.commitDiagnostics.registry, "mismatch");
    assert.match(blocked.session.nextAction, /registry/);

    await writeFile(path.join(dir, registryPath), generatedBytes);
    await git(dir, ["add", registryPath]);
    await git(dir, ["commit", "-m", "commit A generated registry"]);
    const commitA = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    assert.equal(await gitBlobDigestEquals(dir, registryPath, commitA, generatedDigest), true);
    const afterA = await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });
    assert.equal(afterA.session.status, "awaiting_final_commit");
    assert.equal(afterA.session.baselineRef, commitA);
    assert.ok(existsSync(path.join(dir, locator.bootstrapPath)));
    assert.ok(existsSync(path.join(dir, locator.inventoryPath)));
  });
});

test("adoption resume is idempotent and cancel is allowed before recovery_required", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const first = await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });
    const second = await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });
    assert.equal(first.session.sessionId, second.session.sessionId);
    const cancelled = await cancelAdoption(dir, { sessionId: started.session.sessionId });
    assert.equal(cancelled.session.status, "cancelled");
    const status = await statusAdoption(dir, { sessionId: started.session.sessionId });
    assert.equal(status.session.status, "cancelled");
  });
});

test("maintenance marker blocks ordinary task lock immediately", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await writeMaintenanceMarker(dir, { sessionId: "adopt_lock", status: "applying" });
    await assert.rejects(() => withTaskStateLock(dir, "run-next-task", async () => "nope"), /接管维护中/);
    const result = await withTaskStateLock(dir, "adoption:adopt_lock", async () => "ok");
    assert.equal(result, "ok");
  });
});

test("stale fingerprint refuses apply", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const card = started.cards[0];
    await decideAllCards(dir, started.session.sessionId, started.cards, [card.id]);
    card.purpose = "mutated after approval";
    const filesDir = path.join(dir, ".wildarrange", "adoption", started.session.sessionId);
    const cardsPath = path.join(filesDir, "cards.json");
    const current = JSON.parse(await readFile(cardsPath, "utf8"));
    current.cards[0].purpose = "mutated after approval";
    await writeFile(cardsPath, JSON.stringify(current, null, 2));
    // live fingerprint in memory used by apply uses disk cards; mutate disk fingerprint mismatch via approval
    const approvalsPath = path.join(filesDir, "approvals.json");
    const approvals = JSON.parse(await readFile(approvalsPath, "utf8"));
    approvals.approvals[card.id].fingerprint = "not-the-live-fingerprint";
    await writeFile(approvalsPath, JSON.stringify(approvals, null, 2));
    const result = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: card.id,
    });
    assert.equal(result.ok, false);
  });
});

test("CODE-004: approve writes live snapshot and apply stales after the real target file changes", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const card = started.cards.find((item) => item.path && existsSync(path.join(dir, item.path)));
    assert.ok(card, "scan should emit at least one card with an existing target file");
    await decideAllCards(dir, started.session.sessionId, started.cards, [card.id]);
    const filesDir = path.join(dir, ".wildarrange", "adoption", started.session.sessionId);
    const approvals = JSON.parse(await readFile(path.join(filesDir, "approvals.json"), "utf8"));
    const snapshot = approvals.approvals[card.id].snapshot;
    assert.ok(snapshot, "approved card must persist a live snapshot");
    assert.equal(typeof snapshot.targetDigest, "string");
    assert.equal(typeof snapshot.evidenceDigest, "string");
    assert.ok(snapshot.dependencyDigests && typeof snapshot.dependencyDigests === "object");
    assert.ok("headSha" in snapshot);

    const targetPath = path.join(dir, card.path);
    await writeFile(targetPath, `${await readFile(targetPath, "utf8")}\n# mutated-after-approve\n`);
    const businessBefore = await readFile(path.join(dir, "business.txt"), "utf8");
    const result = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: card.id,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "stale");
    assert.equal(await readFile(path.join(dir, "business.txt"), "utf8"), businessBefore);
    const txnManifest = path.join(filesDir, "transactions", card.id, "manifest.json");
    assert.equal(existsSync(txnManifest), false, "stale apply must not invoke capability or write a transaction");
  });
});

test("apply stales with zero writes after package, CI, hook or test consumer bytes change", async () => {
  const mutations = [
    {
      name: "package",
      mutate: async (dir) => {
        const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
        pkg.scripts.extra = "echo mutated";
        await writeFile(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
      },
      unchanged: ["package.json"],
    },
    {
      name: "ci",
      mutate: async (dir) => {
        await writeFile(path.join(dir, ".github", "workflows", "ci.yml"), "name: ci\njobs:\n  check:\n    steps:\n      - run: npm run verify\n");
      },
      unchanged: [".github/workflows/ci.yml"],
    },
    {
      name: "hook",
      mutate: async (dir) => {
        await writeFile(path.join(dir, ".cursor", "hooks.json"), JSON.stringify({ version: 2, hooks: { sessionStart: [{ command: "node test/ok.test.mjs" }] } }, null, 2));
      },
      unchanged: [".cursor/hooks.json"],
    },
    {
      name: "test",
      mutate: async (dir) => {
        await writeFile(path.join(dir, "test", "ok.test.mjs"), "export const ok = 2;\n");
      },
      unchanged: ["test/ok.test.mjs"],
    },
  ];

  for (const mutation of mutations) {
    await withTempDir(async (dir) => {
      await seedProject(dir);
      await mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
      await mkdir(path.join(dir, ".cursor"), { recursive: true });
      await writeFile(path.join(dir, "package.json"), JSON.stringify({
        name: "legacy",
        scripts: { test: "node --test test/ok.test.mjs", verify: "node --test test/ok.test.mjs" },
      }, null, 2));
      await writeFile(path.join(dir, ".github", "workflows", "ci.yml"), "name: ci\njobs:\n  check:\n    steps:\n      - run: npm test\n");
      await writeFile(path.join(dir, ".cursor", "hooks.json"), JSON.stringify({
        version: 1,
        hooks: { sessionStart: [{ command: "node --test test/ok.test.mjs" }] },
      }, null, 2));
      const started = await startAdoption(dir, { serve: false });
      const mergeCard = started.cards.find((card) => card.action === "merge" && card.patch?.kind === "json_script_merge");
      assert.ok(mergeCard, `${mutation.name}: expected a merge card`);
      await decideAllCards(dir, started.session.sessionId, started.cards, [mergeCard.id]);
      const before = Object.fromEntries(await Promise.all(
        ["package.json", ".github/workflows/ci.yml", ".cursor/hooks.json", "test/ok.test.mjs", "business.txt"].map(async (rel) => [rel, await readFile(path.join(dir, rel), "utf8")]),
      ));
      await mutation.mutate(dir);
      const result = await applyApprovedCards(dir, {
        sessionId: started.session.sessionId,
        cardId: mergeCard.id,
      });
      assert.equal(result.ok, false, `${mutation.name} must refuse apply`);
      assert.equal(result.status, "stale", `${mutation.name} must be stale`);
      assert.equal(await readFile(path.join(dir, "business.txt"), "utf8"), before["business.txt"]);
      assert.match(JSON.stringify(JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")).scripts), /verify/, `${mutation.name} must not drop scripts`);
      const txnManifest = path.join(dir, ".wildarrange", "adoption", started.session.sessionId, "transactions", mergeCard.id, "manifest.json");
      assert.equal(existsSync(txnManifest), false, `${mutation.name} must not write a transaction`);
      for (const rel of mutation.unchanged) {
        assert.notEqual(await readFile(path.join(dir, rel), "utf8"), before[rel], `${mutation.name} fixture must actually change ${rel}`);
      }
    });
  }
});

test("CODE-006: resumeAdoption completes a prepared card and keeps the original preimage", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator") || started.cards[0];
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id]);
    const sessionDir = path.join(dir, ".wildarrange", "adoption", started.session.sessionId);
    const txnDir = adoptionTransactionDir(dir, started.session.sessionId, locatorCard.id);
    const preimagePath = path.join(txnDir, "preimage", "notes.txt");
    await mkdir(path.dirname(preimagePath), { recursive: true });
    await writeFile(preimagePath, "original-preimage\n");
    await writeRecoveryManifest(path.join(txnDir, "manifest.json"), createAdoptionRecoveryManifest({
      transactionId: locatorCard.id,
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
      paths: ["wildarrange.config.json"],
      preimage: [{ path: "wildarrange.config.json", status: "missing" }],
    }));
    const beforeSession = await readFile(path.join(sessionDir, "session.json"), "utf8");
    const resumed = await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });
    assert.notEqual(resumed.session.status, "applying");
    assert.ok(["awaiting_registry_commit", "ready", "needs_review", "recovery_required"].includes(resumed.session.status));
    assert.equal(await readFile(preimagePath, "utf8"), "original-preimage\n");
    assert.notEqual(beforeSession, await readFile(path.join(sessionDir, "session.json"), "utf8"));
  });
});

test("CODE-006: reconcile recovery_required keeps the maintenance marker", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const card = started.cards[0];
    const sessionDir = path.join(dir, ".wildarrange", "adoption", started.session.sessionId);
    const session = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
    session.status = "applying";
    await writeFile(path.join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
    const txnDir = path.join(sessionDir, "transactions", card.id);
    await mkdir(txnDir, { recursive: true });
    await writeFile(path.join(txnDir, "manifest.json"), `${JSON.stringify({
      status: "recovery_required",
      cardId: card.id,
    }, null, 2)}\n`);
    await writeMaintenanceMarker(dir, { sessionId: started.session.sessionId, status: "applying" });
    const reconciled = await reconcileAdoption(dir, { sessionId: started.session.sessionId });
    assert.equal(reconciled.session.status, "recovery_required");
    const marker = await readMaintenanceMarker(dir);
    assert.ok(marker);
    assert.equal(marker.kind, "adoption_maintenance");
    assert.equal(marker.sessionId, started.session.sessionId);
  });
});

test("CODE-007: concurrent startAdoption creates only one session", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const [first, second] = await Promise.all([
      startAdoption(dir, { serve: false }),
      startAdoption(dir, { serve: false }),
    ]);
    const winners = [first, second].filter((item) => item.ok);
    const blocked = [first, second].filter((item) => item.status === "session_exists");
    assert.equal(winners.length, 1);
    assert.equal(blocked.length, 1);
    const entries = await readdir(path.join(dir, ".wildarrange", "adoption"), { withFileTypes: true });
    const sessionDirs = entries.filter((entry) => entry.isDirectory());
    assert.equal(sessionDirs.length, 1);
  });
});

test("CODE-007: cancel during applying fails and keeps the maintenance marker", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const sessionDir = path.join(dir, ".wildarrange", "adoption", started.session.sessionId);
    const session = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
    session.status = "applying";
    await writeFile(path.join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
    await writeMaintenanceMarker(dir, { sessionId: started.session.sessionId, status: "applying" });
    await assert.rejects(
      () => cancelAdoption(dir, { sessionId: started.session.sessionId }),
      (error) => error?.code === "session_busy" || error?.code === "applying" || /applying|不能/.test(error?.message || ""),
    );
    const marker = await readMaintenanceMarker(dir);
    assert.ok(marker);
    assert.equal(marker.kind, "adoption_maintenance");
    const after = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
    assert.equal(after.status, "applying");
  });
});

test("CODE-007: ordinary task lock rechecks maintenance marker after acquiring lock", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    let entered = false;
    const lockPath = resolveWildArrangePath(dir, "team", "tasks.lock");
    const holder = withTaskStateLock(dir, "adoption:writer", async () => {
      const startedAt = Date.now();
      while (!existsSync(lockPath) && Date.now() - startedAt < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      await writeMaintenanceMarker(dir, { sessionId: "adopt_toctou", status: "applying" });
    });
    const startedAt = Date.now();
    while (!existsSync(lockPath) && Date.now() - startedAt < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(
      () => withTaskStateLock(dir, "run-next-task", async () => {
        entered = true;
        return "entered";
      }),
      (error) => error?.code === "adoption_maintenance" || /接管维护中/.test(error?.message || ""),
    );
    assert.equal(entered, false);
    await holder;
  });
});

test("apply marks stale when approved target file changes and writes nothing", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator") || started.cards[0];
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id]);
    const targetPath = path.join(dir, locatorCard.path || "wildarrange.config.json");
    await writeFile(targetPath, JSON.stringify({ mutatedAfterApproval: true, keep: "original-target" }, null, 2));
    const result = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "stale");
    assert.equal(await readFile(path.join(dir, "business.txt"), "utf8"), "keep\n");
    assert.match(await readFile(targetPath, "utf8"), /mutatedAfterApproval/);
    assert.doesNotMatch(await readFile(targetPath, "utf8"), /verificationGovernance/);
  });
});

test("concurrent start allows only one reviewing session", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const results = await Promise.all([
      startAdoption(dir, { serve: false }),
      startAdoption(dir, { serve: false }),
    ]);
    const succeeded = results.filter((item) => item.ok);
    const rejected = results.filter((item) => !item.ok);
    assert.equal(succeeded.length, 1);
    assert.equal(succeeded[0].session.status, "reviewing");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].status, "session_exists");
    const adoptionRoot = path.join(dir, ".wildarrange", "adoption");
    const dirs = (await readdir(adoptionRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    const reviewing = [];
    for (const entry of dirs) {
      const session = JSON.parse(await readFile(path.join(adoptionRoot, entry.name, "session.json"), "utf8"));
      if (session.status === "reviewing") reviewing.push(session.sessionId);
    }
    assert.equal(reviewing.length, 1);
  });
});

test("cancel during applying fails and keeps the maintenance marker", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const sessionPath = path.join(dir, ".wildarrange", "adoption", started.session.sessionId, "session.json");
    const session = JSON.parse(await readFile(sessionPath, "utf8"));
    session.status = "applying";
    session.nextAction = "逐卡施工中";
    await writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
    await writeMaintenanceMarker(dir, { sessionId: started.session.sessionId, status: "applying" });
    await assert.rejects(
      () => cancelAdoption(dir, { sessionId: started.session.sessionId }),
      /applying|recovery_required|不能.*取消/,
    );
    const marker = await readMaintenanceMarker(dir);
    assert.equal(marker?.kind, "adoption_maintenance");
    assert.equal(marker.sessionId, started.session.sessionId);
    const after = JSON.parse(await readFile(sessionPath, "utf8"));
    assert.equal(after.status, "applying");
  });
});

test("prepared transaction resume/apply does not recapture the original preimage", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator") || started.cards[0];
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id]);
    await writeMaintenanceMarker(dir, { sessionId: started.session.sessionId, status: "applying" });
    const txnDir = adoptionTransactionDir(dir, started.session.sessionId, locatorCard.id);
    const guardPath = path.join(txnDir, "preimage", "guard.txt");
    await mkdir(path.dirname(guardPath), { recursive: true });
    await writeFile(guardPath, "ORIGINAL_PREIMAGE\n");
    await writeRecoveryManifest(path.join(txnDir, "manifest.json"), createAdoptionRecoveryManifest({
      transactionId: locatorCard.id,
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
      paths: ["wildarrange.config.json"],
      preimage: [{ path: "wildarrange.config.json", status: "missing" }],
    }));
    const resumed = await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });
    assert.notEqual(resumed.session.status, "applying");
    assert.ok(["awaiting_registry_commit", "ready", "needs_review", "recovery_required"].includes(resumed.session.status));
    assert.equal(await readFile(guardPath, "utf8"), "ORIGINAL_PREIMAGE\n");
    assert.equal(await readFile(path.join(dir, "business.txt"), "utf8"), "keep\n");
    const again = await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });
    assert.equal(again.session.sessionId, started.session.sessionId);
    assert.equal(await readFile(guardPath, "utf8"), "ORIGINAL_PREIMAGE\n");
    const committed = JSON.parse(await readFile(path.join(txnDir, "manifest.json"), "utf8"));
    if (committed.status === "committed") {
      const before = JSON.stringify(committed);
      await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });
      const after = await readFile(path.join(txnDir, "manifest.json"), "utf8");
      assert.equal(JSON.parse(after).status, "committed");
      assert.equal(JSON.parse(after).preparedAt, committed.preparedAt);
      assert.ok(JSON.parse(after).postimage);
      assert.equal(JSON.stringify(JSON.parse(after).preimage), JSON.stringify(committed.preimage));
      assert.notEqual(before.length, 0);
    }
  });
});

test("task lock re-checks maintenance marker after lock acquire", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await writeMaintenanceMarker(dir, { sessionId: "adopt_lock_after", status: "applying" });
    await assert.rejects(() => withTaskStateLock(dir, "run-next", async () => "nope"), /接管维护中/);
  });
});

test("apply rejects pending cards with zero business writes", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator");
    assert.ok(locatorCard);
    const registryPath = locatorRegistryPath(locatorCard);
    const result = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "pending_decisions");
    assert.ok(Array.isArray(result.pending));
    assert.ok(result.pending.length > 0);
    assert.match(String(result.nextAction || ""), /先判完/);
    assert.equal(existsSync(path.join(dir, registryPath)), false);
    assert.equal(existsSync(path.join(dir, "wildarrange.config.json")), false);
    assert.equal(await readMaintenanceMarker(dir), null);
    assert.equal(await readFile(path.join(dir, "business.txt"), "utf8"), "keep\n");
  });
});

test("apply rejects cardIds that are not exactly one", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator") || started.cards[0];
    const other = started.cards.find((card) => card.id !== locatorCard.id) || started.cards[0];
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id]);
    const result = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardIds: [locatorCard.id, other.id],
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "single_card_required");
    assert.equal(existsSync(path.join(dir, locatorRegistryPath(locatorCard))), false);
    assert.equal(await readMaintenanceMarker(dir), null);
  });
});

test("apply one approved card does not generate; last card generates registry", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator");
    const second = started.cards.find((card) => card.id !== locatorCard?.id && card.action !== "delete");
    assert.ok(locatorCard && second);
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id, second.id]);
    const first = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
    });
    assert.equal(first.ok, true);
    assert.equal(first.session.status, "ready");
    assert.match(String(first.session.nextAction || first.nextAction || ""), new RegExp(second.id));
    assert.equal(existsSync(path.join(dir, locatorRegistryPath(locatorCard))), false);
    const locatorApplied = JSON.parse(await readFile(path.join(dir, ".wildarrange", "adoption", started.session.sessionId, "cards.json"), "utf8"));
    const appliedLocator = locatorApplied.cards.find((card) => card.id === locatorCard.id);
    const pendingSecond = locatorApplied.cards.find((card) => card.id === second.id);
    assert.ok(appliedLocator.appliedAt);
    assert.equal(pendingSecond.appliedAt, undefined);
    const last = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: second.id,
    });
    assert.equal(last.ok, true);
    assert.equal(last.session.status, "awaiting_registry_commit");
    assert.ok(existsSync(path.join(dir, locatorRegistryPath(locatorCard))));
  });
});

test("resumeAdoption completes a prepared transaction without rewriting session.json first", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator") || started.cards[0];
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id]);
    const sessionPath = path.join(dir, ".wildarrange", "adoption", started.session.sessionId, "session.json");
    const sessionBefore = await readFile(sessionPath, "utf8");
    const txnDir = adoptionTransactionDir(dir, started.session.sessionId, locatorCard.id);
    const guardPath = path.join(txnDir, "preimage", "guard.txt");
    await mkdir(path.dirname(guardPath), { recursive: true });
    await writeFile(guardPath, "ORIGINAL_PREIMAGE\n");
    await writeRecoveryManifest(path.join(txnDir, "manifest.json"), createAdoptionRecoveryManifest({
      transactionId: locatorCard.id,
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
      paths: ["wildarrange.config.json"],
      preimage: [{ path: "wildarrange.config.json", status: "missing" }],
    }));
    assert.equal(await readFile(sessionPath, "utf8"), sessionBefore);
    const resumed = await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });
    assert.notEqual(resumed.session.status, "applying");
    assert.ok(["awaiting_registry_commit", "ready", "needs_review", "recovery_required"].includes(resumed.session.status));
    assert.equal(await readFile(guardPath, "utf8"), "ORIGINAL_PREIMAGE\n");
  });
});

test("commit A stays awaiting_registry_commit when locator is not in HEAD", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await initGitRepo(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator");
    assert.ok(locatorCard);
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id]);
    const applied = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
    });
    assert.equal(applied.session.status, "awaiting_registry_commit");
    const locator = JSON.parse(await readFile(path.join(dir, "wildarrange.config.json"), "utf8")).verificationGovernance;
    await git(dir, ["add", locator.registryPath]);
    await git(dir, ["commit", "-m", "registry only"]);
    const blocked = await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });
    assert.equal(blocked.session.status, "awaiting_registry_commit");
    assert.equal(blocked.session.commitDiagnostics.locator, "mismatch");
    assert.match(blocked.session.nextAction, /locator/);
  });
});

test("approved archive missing from HEAD cannot finalize", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "README.md"), "# current readme\n");
    await writeFile(path.join(dir, "docs", "old-notes.md"), "successor: README.md\n\n# 历史方案\n");
    await initGitRepo(dir, ["README.md", "docs"]);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator");
    const archiveCard = started.cards.find((card) => card.action === "archive" && card.path === "docs/old-notes.md");
    assert.ok(locatorCard && archiveCard, "scan should emit locator and archive cards");
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id, archiveCard.id]);
    const first = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
    });
    assert.equal(first.ok, true);
    assert.equal(first.session.status, "ready");
    const second = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: archiveCard.id,
    });
    assert.equal(second.ok, true);
    assert.equal(second.session.status, "awaiting_registry_commit");
    const locator = JSON.parse(await readFile(path.join(dir, "wildarrange.config.json"), "utf8")).verificationGovernance;
    await git(dir, ["add", locator.registryPath, "wildarrange.config.json"]);
    await git(dir, ["commit", "-m", "commit A without archive"]);
    const afterA = await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });
    assert.equal(afterA.session.status, "awaiting_registry_commit");
    assert.equal(afterA.session.commitDiagnostics.appliedEffects, "mismatch");
    assert.notEqual(afterA.session.status, "finalized");
    if (existsSync(path.join(dir, locator.bootstrapPath))) {
      await git(dir, ["add", locator.bootstrapPath, locator.inventoryPath]);
      await git(dir, ["commit", "-m", "commit B without archive"]);
      const afterB = await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });
      assert.notEqual(afterB.session.status, "finalized");
      assert.equal(afterB.session.status, "awaiting_registry_commit");
    }
  });
});

test("generated Inventory digest matches digestCanonical without digest", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await initGitRepo(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator");
    assert.ok(locatorCard);
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id]);
    const applied = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
    });
    assert.equal(applied.session.status, "awaiting_registry_commit");
    const locator = JSON.parse(await readFile(path.join(dir, "wildarrange.config.json"), "utf8")).verificationGovernance;
    await git(dir, ["add", locator.registryPath, "wildarrange.config.json"]);
    await git(dir, ["commit", "-m", "commit A"]);
    const afterA = await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });
    assert.equal(afterA.session.status, "awaiting_final_commit");
    const inventory = await readVerificationInventory(path.join(dir, locator.inventoryPath));
    const { digest, ...withoutDigest } = inventory;
    assert.equal(digest, digestCanonical(withoutDigest));
    assert.ok(inventory.declaredInputFingerprint);
  });
});

test("artifact name collision pauses adoption, preserves legacy bytes and releases maintenance", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const legacyBytes = "{\"owner\":\"legacy-project\"}\n";
    await writeFile(path.join(dir, "verification-registry.json"), legacyBytes);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator");
    assert.ok(locatorCard);
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id]);

    const result = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "generate_failed");
    assert.equal(result.error.code, "artifact_conflict");
    assert.match(result.nextAction, /verification-registry\.json/);
    assert.equal(result.session.status, "needs_review");
    assert.equal(await readFile(path.join(dir, "verification-registry.json"), "utf8"), legacyBytes);
    assert.equal(await readMaintenanceMarker(dir), null);
  });
});

test("handoff directory conflict stays retryable and never throws raw EISDIR", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    await initGitRepo(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator");
    assert.ok(locatorCard);
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id]);
    const applied = await applyApprovedCards(dir, {
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
    });
    const locator = JSON.parse(await readFile(path.join(dir, "wildarrange.config.json"), "utf8")).verificationGovernance;
    await git(dir, ["add", locator.registryPath, "wildarrange.config.json"]);
    await git(dir, ["commit", "-m", "commit A"]);
    await mkdir(path.join(dir, locator.bootstrapPath));

    const result = await resumeAdoption(dir, { serve: false, sessionId: started.session.sessionId });

    assert.equal(result.session.status, "awaiting_registry_commit");
    assert.match(result.session.nextAction, /verification-bootstrap\.json/);
    assert.match(result.session.nextAction, /移走或改名/);
    assert.equal(existsSync(path.join(dir, locator.inventoryPath)), false);
    assert.equal(applied.session.status, "awaiting_registry_commit");
  });
});

test("all deferred cards stay reviewable and explain how to finish or cancel", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    await decideAllCards(dir, started.session.sessionId, started.cards, []);
    const status = await statusAdoption(dir, { sessionId: started.session.sessionId });
    assert.equal(status.session.status, "needs_review");
    assert.match(status.session.nextAction, /批准 locator/);
    assert.match(status.session.nextAction, /取消接管/);
  });
});

test("cancel refuses to pretend applied project changes were restored", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator");
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id]);
    await applyApprovedCards(dir, { sessionId: started.session.sessionId, cardId: locatorCard.id });
    await assert.rejects(
      cancelAdoption(dir, { sessionId: started.session.sessionId }),
      (error) => error?.code === "applied_changes_exist",
    );
    assert.equal(existsSync(path.join(dir, "wildarrange.config.json")), true);
  });
});

test("terminal adoption sessions reject decide and apply writes", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    await cancelAdoption(dir, { sessionId: started.session.sessionId });
    await assert.rejects(
      decideAdoptionCard(dir, {
        sessionId: started.session.sessionId,
        cardId: started.cards[0].id,
        decision: "deferred",
        fingerprint: started.cards[0].fingerprint,
      }),
      (error) => error?.code === "session_not_reviewable",
    );
    const applied = await applyApprovedCards(dir, { sessionId: started.session.sessionId, cardId: started.cards[0].id });
    assert.equal(applied.status, "session_not_applicable");
  });
});

test("recover restores the saved preimage and releases maintenance", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const cardId = started.cards[0].id;
    const transactionDir = adoptionTransactionDir(dir, started.session.sessionId, cardId);
    await mkdir(path.join(transactionDir, "preimage"), { recursive: true });
    await writeFile(path.join(transactionDir, "preimage", "business.txt"), "keep\n");
    await writeFile(path.join(dir, "business.txt"), "changed\n");
    const manifest = {
      ...createAdoptionRecoveryManifest({
        transactionId: cardId,
        sessionId: started.session.sessionId,
        cardId,
        paths: ["business.txt"],
        preimage: [{ path: "business.txt", status: "copied", type: "file", digest: hashContent("keep\n") }],
      }),
      status: "recovery_required",
    };
    await writeRecoveryManifest(path.join(transactionDir, "manifest.json"), manifest);
    const sessionPath = path.join(resolveWildArrangePath(dir, "adoption", started.session.sessionId), "session.json");
    const session = await readJson(sessionPath, null);
    session.status = "recovery_required";
    await writeJsonAtomic(sessionPath, session);
    await writeMaintenanceMarker(dir, { sessionId: started.session.sessionId, status: "recovery_required" });

    const result = await recoverAdoption(dir, { sessionId: started.session.sessionId });
    assert.equal(result.status, "recovered");
    assert.equal(await readFile(path.join(dir, "business.txt"), "utf8"), "keep\n");
    assert.equal(await readMaintenanceMarker(dir), null);
    assert.equal((await statusAdoption(dir, { sessionId: started.session.sessionId })).session.status, "needs_review");
  });
});

test("failed verifier rollback releases maintenance marker", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator");
    const cardsPath = path.join(resolveWildArrangePath(dir, "adoption", started.session.sessionId), "cards.json");
    const stored = await readJson(cardsPath, { cards: [] });
    const storedCard = stored.cards.find((card) => card.id === locatorCard.id);
    storedCard.verify = [`"${process.execPath}" -e "process.exit(9)"`];
    storedCard.fingerprint = fingerprintCard({ ...storedCard, fingerprint: "" });
    await writeJsonAtomic(cardsPath, stored);
    await decideAllCards(dir, started.session.sessionId, stored.cards, [storedCard.id]);
    const result = await applyApprovedCards(dir, { sessionId: started.session.sessionId, cardId: storedCard.id });
    assert.equal(result.status, "rolled_back");
    assert.equal(await readMaintenanceMarker(dir), null);
  });
});

test("resume reconciles a committed card after a crash before session advancement", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator");
    await decideAllCards(dir, started.session.sessionId, started.cards, [locatorCard.id]);
    await applyApprovedCards(dir, { sessionId: started.session.sessionId, cardId: locatorCard.id });

    const sessionDir = resolveWildArrangePath(dir, "adoption", started.session.sessionId);
    const session = await readJson(path.join(sessionDir, "session.json"), null);
    session.status = "applying";
    await writeJsonAtomic(path.join(sessionDir, "session.json"), session);
    const stored = await readJson(path.join(sessionDir, "cards.json"), { cards: [] });
    delete stored.cards.find((card) => card.id === locatorCard.id).appliedAt;
    await writeJsonAtomic(path.join(sessionDir, "cards.json"), stored);
    await writeMaintenanceMarker(dir, { sessionId: started.session.sessionId, status: "applying" });

    const resumed = await resumeAdoption(dir, { sessionId: started.session.sessionId, serve: false });
    assert.equal(resumed.session.status, "awaiting_registry_commit");
    assert.equal(await readMaintenanceMarker(dir), null);
  });
});

test("cards that execute verifier commands cannot be batch-approved", async () => {
  await withTempDir(async (dir) => {
    await seedProject(dir);
    const started = await startAdoption(dir, { serve: false });
    const verifierCard = started.cards.find((card) => Array.isArray(card.verify) && card.verify.length > 0);
    const otherCard = started.cards.find((card) => card.id !== verifierCard.id);
    await assert.rejects(
      decideAdoptionCard(dir, {
        sessionId: started.session.sessionId,
        decisions: [
          { cardId: verifierCard.id, decision: "approved", fingerprint: verifierCard.fingerprint },
          { cardId: otherCard.id, decision: "deferred", fingerprint: otherCard.fingerprint },
        ],
      }),
      (error) => error?.code === "sensitive_card",
    );
  });
});
