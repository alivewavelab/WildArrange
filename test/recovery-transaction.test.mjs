import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  prepareArchiveRecoveryPackage,
  updateArchiveRecoveryPackage,
  writeRuntimeStateBackup,
} from "../src/infra/security.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ADOPTION_RECOVERY_KIND,
  ARCHIVE_RECOVERY_KIND,
  assertRealpathInsideRoot,
  assertSafeId,
  capturePreimages,
  createAdoptionRecoveryManifest,
  digestPath,
  resolveInboundPath,
  restorePreimages,
} from "../src/infra/recovery-transaction.mjs";
import { readJson } from "../src/infra/runtime-store.mjs";

const execFileAsync = promisify(execFile);

async function createParentEscapeLink(linkDir, outsideDir) {
  try {
    await symlink(outsideDir, linkDir, "junction");
    return "junction";
  } catch {
    try {
      await symlink(outsideDir, linkDir, "dir");
      return "symlink";
    } catch (symlinkError) {
      if (process.platform === "win32") {
        await execFileAsync("cmd.exe", ["/c", "mklink", "/J", linkDir, outsideDir]);
        return "mklink";
      }
      throw symlinkError;
    }
  }
}

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-recovery-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("recovery-transaction: preimage restore returns files to original bytes", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "notes.txt");
    await writeFile(target, "before\n");
    const staging = path.join(dir, "staging");
    const preimage = await capturePreimages(dir, ["notes.txt"], staging);
    assert.equal(preimage[0].status, "copied");
    await writeFile(target, "after\n");
    await restorePreimages(dir, staging, preimage);
    assert.equal(await readFile(target, "utf8"), "before\n");
  });
});

test("recovery-transaction: missing preimage deletes a file created by apply", async () => {
  await withTempDir(async (dir) => {
    const staging = path.join(dir, "staging");
    const preimage = await capturePreimages(dir, ["created.txt"], staging);
    assert.equal(preimage[0].status, "missing");
    await writeFile(path.join(dir, "created.txt"), "new\n");
    await restorePreimages(dir, staging, preimage);
    await assert.rejects(() => readFile(path.join(dir, "created.txt")), /ENOENT/);
  });
});

test("recovery-transaction: missing target under junction/symlink parent cannot escape", async () => {
  await withTempDir(async (dir) => {
    const outsideDir = path.join(path.dirname(dir), `outside-parent-link-${process.pid}`);
    await mkdir(outsideDir, { recursive: true });
    const secretPath = path.join(outsideDir, "secret.txt");
    await writeFile(secretPath, "outside-secret\n");
    const linkPath = path.join(dir, "escaped-parent");
    let linkKind = null;
    try {
      if (process.platform === "win32") {
        try {
          await symlink(outsideDir, linkPath, "junction");
          linkKind = "junction";
        } catch (junctionError) {
          if (junctionError?.code !== "EPERM" && junctionError?.code !== "EACCES") throw junctionError;
        }
      }
      if (!linkKind) {
        try {
          await symlink(outsideDir, linkPath, "dir");
          linkKind = "symlink";
        } catch (symlinkError) {
          if (symlinkError?.code === "EPERM" || symlinkError?.code === "EACCES") {
            assert.fail("need at least one real parent-link escape probe (junction or symlink)");
          }
          throw symlinkError;
        }
      }
      await assert.rejects(
        () => capturePreimages(dir, ["escaped-parent/planted.txt"], path.join(dir, "staging")),
        /escapes project root/,
      );
      assert.equal(await readFile(secretPath, "utf8"), "outside-secret\n");
      await assert.rejects(() => readFile(path.join(outsideDir, "planted.txt")), /ENOENT/);
    } finally {
      await rm(linkPath, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
    assert.ok(linkKind, "parent link probe must actually run");
  });
});

test("recovery-transaction: inbound path and realpath refuse escape", async () => {
  await withTempDir(async (dir) => {
    assert.throws(() => resolveInboundPath(dir, "../outside.txt"), /escapes project root/);
    assert.throws(() => assertSafeId("../x", "id"), /safe single-segment/);
    const outside = path.join(path.dirname(dir), "outside-recovery.txt");
    await writeFile(outside, "no\n");
    try {
      await symlink(outside, path.join(dir, "link.txt"));
      await assert.rejects(() => capturePreimages(dir, ["link.txt"], path.join(dir, "staging")), /escapes project root/);
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        assert.ok(true, "symlink creation blocked by environment; not treated as assertion failure");
        return;
      }
      throw error;
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("CODE-005: parent junction/symlink escape is refused for a missing child path", async () => {
  await withTempDir(async (dir) => {
    const outside = path.join(path.dirname(dir), `outside-recovery-parent-${process.pid}`);
    await mkdir(outside, { recursive: true });
    const linkDir = path.join(dir, "link");
    try {
      const kind = await createParentEscapeLink(linkDir, outside);
      assert.ok(kind, "must create a real parent junction or symlink probe");
      await assert.rejects(
        () => capturePreimages(dir, ["link/new.txt"], path.join(dir, "staging")),
        /escapes project root/,
      );
      await assert.rejects(
        () => assertRealpathInsideRoot(dir, path.join(dir, "link", "new.txt"), "link/new.txt"),
        /escapes project root/,
      );
      await assert.rejects(() => readFile(path.join(outside, "new.txt")), /ENOENT/);
    } finally {
      await rm(linkDir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("recovery-transaction: adoption manifest kind is distinct from archive", () => {
  const manifest = createAdoptionRecoveryManifest({
    transactionId: "card_001",
    sessionId: "adopt_1",
    cardId: "card_001",
    paths: ["a.txt"],
    preimage: [],
  });
  assert.equal(manifest.kind, ADOPTION_RECOVERY_KIND);
  assert.notEqual(ADOPTION_RECOVERY_KIND, ARCHIVE_RECOVERY_KIND);
});

test("archive recovery public API remains field-equivalent", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, ".wildarrange", "team"), { recursive: true });
    await writeFile(path.join(dir, ".wildarrange", "ledger.jsonl"), "{}\n");
    await writeFile(path.join(dir, ".wildarrange", "work.json"), "{}\n");
    await writeFile(path.join(dir, "keep.txt"), "keep\n");
    const backup = await writeRuntimeStateBackup(dir, { reason: "archive-equiv" });
    const prepared = await prepareArchiveRecoveryPackage(dir, {
      backupId: backup.backupId,
      taskRef: "P1:T001",
      paths: ["keep.txt"],
    });
    assert.equal(prepared.backupId, backup.backupId);
    assert.ok(prepared.transactionId);
    assert.equal(prepared.archivePackage.kind, "task_archive_recovery");
    assert.equal(prepared.archivePackage.status, "prepared");
    assert.equal(prepared.archivePackage.taskRef, "P1:T001");
    assert.ok(Array.isArray(prepared.archivePackage.paths));
    assert.match(prepared.archivePackage.stagingPath, /archive-staging/);
    const updated = await updateArchiveRecoveryPackage(dir, {
      backupId: prepared.backupId,
      transactionId: prepared.transactionId,
      status: "committed",
    });
    assert.equal(updated.kind, "task_archive_recovery");
    assert.equal(updated.status, "committed");
    assert.equal(updated.transactionId, prepared.transactionId);
    assert.equal(updated.taskRef, "P1:T001");
    assert.ok(updated.stagingPath.includes("archive-staging"));
    const manifest = await readJson(path.join(dir, ".wildarrange", "backups", prepared.backupId, "manifest.json"));
    assert.equal(manifest.kind, "runtime_state_backup");
    assert.equal(manifest.archivePackages.length, 1);
    assert.equal(manifest.archivePackages[0].kind, "task_archive_recovery");
    assert.equal(manifest.archivePackages[0].status, "committed");
    const digest = await digestPath(path.join(dir, "keep.txt"));
    assert.equal(typeof digest, "string");
    assert.notEqual(digest, "missing");
  });
});
