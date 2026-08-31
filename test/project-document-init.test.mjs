import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { initProjectDocuments } from "../src/interface/project-init.mjs";

async function withProject(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-project-docs-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await initRuntime(rootDir);
  return rootDir;
}

test("project document init creates the minimum set and waits for human confirmation", async (t) => {
  const rootDir = await withProject(t);
  const result = await initProjectDocuments(rootDir);

  assert.deepEqual(result.created, [
    "AGENTS.md",
    "doc/standards/code-and-interface-conventions.md",
    "doc/testing-and-acceptance.md",
    "doc/progress.md",
  ]);
  assert.deepEqual(result.preserved, []);
  assert.equal(result.architectureIncluded, false);
  assert.equal(result.awaitingHumanConfirmation.length, 4);

  const agents = await readFile(path.join(rootDir, "AGENTS.md"), "utf8");
  const testing = await readFile(path.join(rootDir, "doc", "testing-and-acceptance.md"), "utf8");
  const progress = await readFile(path.join(rootDir, "doc", "progress.md"), "utf8");
  assert.match(agents, /doc\/progress\.md/);
  assert.match(testing, /未经人类明确确认/);
  assert.match(testing, /Fuzz/);
  assert.match(testing, /高风险行为，只允许 AI 提出加强测试建议/);
  assert.match(progress, /\.helix\/team\/tasks\.json.*唯一工单总账/);
  await assert.rejects(readFile(path.join(rootDir, "doc", "architecture.md"), "utf8"), { code: "ENOENT" });
});

test("project document init preserves existing files instead of merging or overwriting", async (t) => {
  const rootDir = await withProject(t);
  await writeFile(path.join(rootDir, "AGENTS.md"), "# existing project rules\n", "utf8");

  const first = await initProjectDocuments(rootDir);
  const second = await initProjectDocuments(rootDir);

  assert.deepEqual(first.preserved, ["AGENTS.md"]);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.preserved, [
    "AGENTS.md",
    "doc/standards/code-and-interface-conventions.md",
    "doc/testing-and-acceptance.md",
    "doc/progress.md",
  ]);
  assert.equal(await readFile(path.join(rootDir, "AGENTS.md"), "utf8"), "# existing project rules\n");
});

test("architecture template is created only when explicitly requested", async (t) => {
  const rootDir = await withProject(t);
  const result = await initProjectDocuments(rootDir, { architecture: true });

  assert.equal(result.architectureIncluded, true);
  assert.ok(result.created.includes("doc/architecture.md"));
  assert.match(await readFile(path.join(rootDir, "doc", "architecture.md"), "utf8"), /本文件按需创建/);
});
