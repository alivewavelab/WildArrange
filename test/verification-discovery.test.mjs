import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { captureCardLiveSnapshot, DANGEROUS_ACTIONS, fingerprintCard, scanVerificationUniverse } from "../src/infra/verification-discovery.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-discovery-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeFixture(dir) {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "test"), { recursive: true });
  await mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "legacy-app",
    scripts: {
      test: "node --test",
      verify: "node --test",
      lint: "node --version",
      boom: "node -e \"require('fs').writeFileSync('SCANNED.txt','ran')\"",
    },
  }, null, 2));
  await writeFile(path.join(dir, "src", "app.mjs"), "export const n = 1;\n");
  await writeFile(path.join(dir, "src", "loader.mjs"), "export async function load(name) { return import(name); }\n");
  await writeFile(path.join(dir, "test", "app.test.mjs"), "import { n } from '../src/app.mjs';\nexport const ok = n;\n");
  await writeFile(path.join(dir, ".github", "workflows", "ci.yml"), "name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n");
  await writeFile(path.join(dir, "docs", "TESTING.md"), "# old testing notes\n");
  await writeFile(path.join(dir, "marker-seed.txt"), "seed\n");
}

test("discovery: repeat scans are ordered, stable ids and digests", async () => {
  await withTempDir(async (dir) => {
    await writeFixture(dir);
    const first = await scanVerificationUniverse(dir);
    const second = await scanVerificationUniverse(dir);
    assert.deepEqual(first.cards.map((card) => card.id), second.cards.map((card) => card.id));
    assert.equal(first.scanDigest, second.scanDigest);
    assert.equal(first.universeFingerprint, second.universeFingerprint);
    assert.ok(first.cards.length > 0);
    assert.ok(first.cards.every((card) => card.fingerprint === fingerprintCard({ ...card, fingerprint: "" })));
  });
});

test("discovery: scan writes no business files and never runs discovered commands", async () => {
  await withTempDir(async (dir) => {
    await writeFixture(dir);
    const before = await readFile(path.join(dir, "marker-seed.txt"), "utf8");
    await scanVerificationUniverse(dir);
    assert.equal(await readFile(path.join(dir, "marker-seed.txt"), "utf8"), before);
    await assert.rejects(() => readFile(path.join(dir, "SCANNED.txt")), /ENOENT/);
    await assert.rejects(() => readFile(path.join(dir, "package.json.lock")), /ENOENT/);
  });
});

test("discovery: unknown consumers never get merge/delete actions", async () => {
  await withTempDir(async (dir) => {
    await writeFixture(dir);
    const { cards } = await scanVerificationUniverse(dir);
    const dangerous = cards.filter((card) => DANGEROUS_ACTIONS.includes(card.action));
    for (const card of dangerous) {
      const unknown = card.confidence === "unknown" || (card.consumers || []).some((item) => item.grade === "unknown");
      assert.equal(unknown, false, `${card.id} is dangerous but unknown`);
    }
    const loader = cards.find((card) => card.path.includes("loader.mjs"));
    if (loader) assert.notEqual(loader.action, "delete");
  });
});

test("discovery: cards answer the user-visible questions", async () => {
  await withTempDir(async (dir) => {
    await writeFixture(dir);
    const { cards } = await scanVerificationUniverse(dir);
    for (const card of cards) {
      for (const key of ["id", "action", "asset", "path", "owner", "purpose", "consumers", "evidence", "confidence", "reason", "afterState", "maxConsequence", "rollback", "fingerprint"]) {
        assert.notEqual(card[key], undefined, `${card.id} missing ${key}`);
      }
    }
    assert.ok(cards.some((card) => card.asset === "config_locator"));
    assert.ok(cards.some((card) => card.asset === "behavior_suite"));
    const locator = cards.find((card) => card.asset === "config_locator")?.patch?.value?.verificationGovernance;
    assert.match(locator?.inventoryPath || "", /verification-inventory\.html$/);
  });
});

test("discovery: an existing locator remains the source of truth on later scans", async () => {
  await withTempDir(async (dir) => {
    await writeFixture(dir);
    const existing = {
      registryPath: "governance/registry.json",
      bootstrapPath: "governance/bootstrap.json",
      inventoryPath: "governance/inventory.html",
      archiveRoot: "governance/archive",
    };
    await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({ verificationGovernance: existing }, null, 2));
    const { cards } = await scanVerificationUniverse(dir);
    const locator = cards.find((card) => card.asset === "config_locator")?.patch?.value?.verificationGovernance;
    assert.deepEqual(locator, existing);
  });
});

test("discovery: current AGENTS and live skills never get dangerous actions", async () => {
  await withTempDir(async (dir) => {
    await writeFixture(dir);
    await writeFile(path.join(dir, "AGENTS.md"), "# current agents\n");
    await writeFile(path.join(dir, "src", "AGENTS.md"), "# zone agents\n");
    await mkdir(path.join(dir, "packs", "x", "skills"), { recursive: true });
    await writeFile(path.join(dir, "packs", "x", "skills", "current.md"), "successor: docs/TESTING.md\n# live skill\n");
    const { cards } = await scanVerificationUniverse(dir);
    assert.ok(DANGEROUS_ACTIONS.includes("archive"));
    assert.ok(DANGEROUS_ACTIONS.includes("merge"));
    assert.ok(DANGEROUS_ACTIONS.includes("delete"));
    assert.equal(cards.filter((card) => card.action === "change" || card.action === "delete").length, 0);
    const protectedPaths = ["AGENTS.md", "src/AGENTS.md", "packs/x/skills/current.md"];
    for (const relativePath of protectedPaths) {
      const card = cards.find((item) => item.path === relativePath);
      assert.ok(card, `expected a card for ${relativePath}`);
      assert.ok(!["archive", "merge", "delete"].includes(card.action), `${relativePath} action=${card.action}`);
    }
  });
});

test("discovery: TESTING.md without successor or still referenced can only defer", async () => {
  await withTempDir(async (dir) => {
    await writeFixture(dir);
    await writeFile(path.join(dir, "README.md"), "See docs/TESTING.md\n");
    const { cards } = await scanVerificationUniverse(dir);
    const testing = cards.find((card) => card.path === "docs/TESTING.md");
    assert.ok(testing, "expected a card for docs/TESTING.md");
    assert.equal(testing.action, "defer");
    assert.equal(testing.patch, null);
    assert.match(String(testing.reason), /successor|后继|引用|消费者|缺少|暂缓/i);
    assert.doesNotMatch(String(testing.reason), /建议归档而不是删除/);
  });
});

test("discovery: explicit successor and no active consumers allows archive with commitable archiveRoot", async () => {
  await withTempDir(async (dir) => {
    await writeFixture(dir);
    await writeFile(path.join(dir, "README.md"), "# current readme\n");
    await writeFile(path.join(dir, "docs", "old-notes.md"), "successor: README.md\n\n# 历史方案\n");
    const { cards } = await scanVerificationUniverse(dir);
    const archive = cards.find((card) => card.path === "docs/old-notes.md");
    assert.ok(archive, "expected a card for docs/old-notes.md");
    assert.equal(archive.action, "archive");
    assert.ok(archive.patch);
    assert.equal(archive.patch.kind, "archive_move");
    assert.equal(archive.patch.path, "docs/old-notes.md");
    assert.equal(archive.patch.archiveRoot, "docs/verification-archive");
    assert.ok(!String(archive.patch.archiveRoot).includes(".wildarrange"));
    const snap = await captureCardLiveSnapshot(dir, archive);
    assert.equal(typeof snap.targetDigest, "string");
    assert.equal(typeof snap.evidenceDigest, "string");
    assert.equal(typeof snap.dependencyDigests, "object");
    assert.ok(snap.targetDigest.length > 10);
    assert.ok(snap.evidenceDigest.length > 10);
  });
});

test("discovery: duplicate scripts still named in CI defer without migration patch", async () => {
  await withTempDir(async (dir) => {
    await writeFixture(dir);
    await writeFile(
      path.join(dir, ".github", "workflows", "ci.yml"),
      "name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run verify\n",
    );
    const { cards } = await scanVerificationUniverse(dir);
    const scriptCard = cards.find((card) => card.asset === "package_script");
    assert.ok(scriptCard, "expected a package_script card");
    assert.equal(scriptCard.action, "defer");
    assert.equal(scriptCard.patch, null);
    const blob = JSON.stringify(scriptCard);
    assert.match(blob, /verify/);
    assert.ok(
      (scriptCard.consumers || []).some((item) => /verify/.test(`${item.by} ${item.evidence}`)),
      "card must list verify consumers",
    );
    assert.match(String(scriptCard.reason), /verify|消费者|迁移|引用/i);
  });
});

test("discovery: duplicate scripts with no drop-key consumers allow merge", async () => {
  await withTempDir(async (dir) => {
    await writeFixture(dir);
    const { cards } = await scanVerificationUniverse(dir);
    const scriptCard = cards.find((card) => card.asset === "package_script");
    assert.ok(scriptCard, "expected a package_script card");
    assert.equal(scriptCard.action, "merge");
    assert.ok(scriptCard.patch);
    assert.equal(scriptCard.patch.kind, "json_script_merge");
    assert.equal(scriptCard.patch.keep, "test");
    assert.deepEqual(scriptCard.patch.drop, ["verify"]);
  });
});

test("discovery: live snapshot digests package, CI, hook and referenced test bytes", async () => {
  await withTempDir(async (dir) => {
    await writeFixture(dir);
    await mkdir(path.join(dir, ".cursor"), { recursive: true });
    const packageBody = JSON.stringify({
      name: "legacy-app",
      scripts: { test: "node --test test/app.test.mjs", lint: "node --version" },
    }, null, 2);
    const ciBody = "name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --test test/app.test.mjs\n";
    const hookBody = JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "node test/app.test.mjs" }] } }, null, 2);
    const extraTestBody = "import { ok } from './app.test.mjs';\nexport const extra = ok;\n";
    await writeFile(path.join(dir, "package.json"), packageBody);
    await writeFile(path.join(dir, ".github", "workflows", "ci.yml"), ciBody);
    await writeFile(path.join(dir, ".cursor", "hooks.json"), hookBody);
    await writeFile(path.join(dir, "test", "extra.test.mjs"), extraTestBody);
    await writeFile(path.join(dir, "business.txt"), "unrelated\n");

    const card = {
      action: "adopt",
      path: "test/app.test.mjs",
      evidence: ["behavior suite"],
      consumers: [
        { grade: "runner", by: "package.json#test", evidence: "node --test test/app.test.mjs" },
        { grade: "registered", by: ".github/workflows/ci.yml", evidence: "CI/Hook 入口文本命中" },
        { grade: "registered", by: ".cursor/hooks.json", evidence: "CI/Hook 入口文本命中" },
        { grade: "direct", by: "test/extra.test.mjs", evidence: "static import ./app.test.mjs" },
      ],
      patch: { kind: "registry_plan_default", field: "verify_commands", command: "npm test", sourcePath: "test/app.test.mjs" },
    };

    const baseline = await captureCardLiveSnapshot(dir, card);
    assert.ok(baseline.dependencyDigests["package.json"]);
    assert.ok(baseline.dependencyDigests[".github/workflows/ci.yml"]);
    assert.ok(baseline.dependencyDigests[".cursor/hooks.json"]);
    assert.ok(baseline.dependencyDigests["test/extra.test.mjs"]);
    assert.notEqual(baseline.dependencyDigests["package.json"], "missing");
    assert.notEqual(baseline.dependencyDigests[".github/workflows/ci.yml"], "missing");
    assert.notEqual(baseline.dependencyDigests[".cursor/hooks.json"], "missing");
    assert.notEqual(baseline.dependencyDigests["test/extra.test.mjs"], "missing");

    await writeFile(path.join(dir, "business.txt"), "unrelated-mutated\n");
    const afterBusiness = await captureCardLiveSnapshot(dir, card);
    assert.deepEqual(afterBusiness, baseline);
    assert.equal(afterBusiness.dependencyDigests["package.json"], baseline.dependencyDigests["package.json"]);
    assert.equal(afterBusiness.dependencyDigests[".github/workflows/ci.yml"], baseline.dependencyDigests[".github/workflows/ci.yml"]);
    assert.equal(afterBusiness.dependencyDigests["test/extra.test.mjs"], baseline.dependencyDigests["test/extra.test.mjs"]);

    await writeFile(path.join(dir, ".github", "workflows", "ci.yml"), `${ciBody}# mutated-ci\n`);
    const afterCi = await captureCardLiveSnapshot(dir, card);
    assert.notDeepEqual(afterCi, baseline);
    assert.equal(afterCi.evidenceDigest, baseline.evidenceDigest);
    assert.notEqual(afterCi.dependencyDigests[".github/workflows/ci.yml"], baseline.dependencyDigests[".github/workflows/ci.yml"]);
    await writeFile(path.join(dir, ".github", "workflows", "ci.yml"), ciBody);

    await writeFile(path.join(dir, "package.json"), JSON.stringify({
      name: "legacy-app",
      scripts: { test: "node --test test/app.test.mjs", lint: "node --version", extra: "echo mutated" },
    }, null, 2));
    const afterPackage = await captureCardLiveSnapshot(dir, card);
    assert.notDeepEqual(afterPackage, baseline);
    assert.equal(afterPackage.evidenceDigest, baseline.evidenceDigest);
    assert.notEqual(afterPackage.dependencyDigests["package.json"], baseline.dependencyDigests["package.json"]);
    await writeFile(path.join(dir, "package.json"), packageBody);

    await writeFile(path.join(dir, ".cursor", "hooks.json"), JSON.stringify({ version: 2, hooks: { sessionStart: [{ command: "node test/app.test.mjs" }] } }, null, 2));
    const afterHook = await captureCardLiveSnapshot(dir, card);
    assert.notDeepEqual(afterHook, baseline);
    assert.equal(afterHook.evidenceDigest, baseline.evidenceDigest);
    assert.notEqual(afterHook.dependencyDigests[".cursor/hooks.json"], baseline.dependencyDigests[".cursor/hooks.json"]);
    await writeFile(path.join(dir, ".cursor", "hooks.json"), hookBody);

    await writeFile(path.join(dir, "test", "extra.test.mjs"), `${extraTestBody}export const mutated = 1;\n`);
    const afterTest = await captureCardLiveSnapshot(dir, card);
    assert.notDeepEqual(afterTest, baseline);
    assert.equal(afterTest.evidenceDigest, baseline.evidenceDigest);
    assert.notEqual(afterTest.dependencyDigests["test/extra.test.mjs"], baseline.dependencyDigests["test/extra.test.mjs"]);

    const mergeLike = { action: "merge", path: "package.json", consumers: [], patch: { kind: "json_script_merge", path: "package.json" } };
    const beforeUnknownCi = await captureCardLiveSnapshot(dir, mergeLike);
    await writeFile(path.join(dir, ".github", "workflows", "ci.yml"), `${ciBody}# later-consumer\n`);
    const afterUnknownCi = await captureCardLiveSnapshot(dir, mergeLike);
    assert.notEqual(afterUnknownCi.dependencyDigests[".github/workflows/ci.yml"], beforeUnknownCi.dependencyDigests[".github/workflows/ci.yml"]);
  });
});
