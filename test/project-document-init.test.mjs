// =============================================================================
// 文件名称：project-document-init.test.mjs
// 所属模块：test
// 作用说明：
//   验证 initProjectDocuments：最小文档集、等待人类确认、
//   已有文件 preserve、architecture 仅显式请求创建、设计 review 路由与 Skill。
//   不测：architecture 内容质量或自动合并冲突。
//
// 【运行原理速读】
//   临时目录 initRuntime 后调用 initProjectDocuments，
//   断言 created/preserved/awaitingHumanConfirmation 与文件正文关键字。
// =============================================================================

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
  assert.equal(result.architectureDesign.status, "review_required");
  assert.equal(result.architectureDesign.scope, "design_only");
  assert.equal(result.architectureDesign.templateIsApproval, false);
  assert.ok(result.awaitingHumanConfirmation.some(item => item.includes("review-architecture-design")));

  const agents = await readFile(path.join(rootDir, "AGENTS.md"), "utf8");
  const testing = await readFile(path.join(rootDir, "doc", "testing-and-acceptance.md"), "utf8");
  const progress = await readFile(path.join(rootDir, "doc", "progress.md"), "utf8");
  assert.match(agents, /doc\/progress\.md/);
  assert.match(testing, /未经人类明确确认/);
  assert.match(testing, /Fuzz/);
  assert.match(testing, /高风险行为，只允许 AI 提出加强测试建议/);
  assert.match(progress, /\.wildarrange\/team\/tasks\.json.*唯一工单总账/);
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
  assert.match(await readFile(path.join(rootDir, "doc", "architecture.md"), "utf8"), /待设计审查与人工确认/);
});

test("existing architecture is preserved and still routed to design review", async t => {
  const rootDir = await withProject(t);
  await initProjectDocuments(rootDir, { architecture: true });
  const file = path.join(rootDir, "doc/architecture.md");
  const old = "# Existing design\nCatalog owns game identity.\n";
  await writeFile(file, old);
  const result = await initProjectDocuments(rootDir, { architecture: true });
  assert.ok(result.preserved.includes("doc/architecture.md"));
  assert.equal(await readFile(file, "utf8"), old);
  assert.equal(result.architectureDesign.status, "review_required");
  assert.equal(result.architectureDesign.templateIsApproval, false);
});

test("architecture design review is loadable through initialization, routing and installed Skill", async t => {
  const rootDir = await withProject(t);
  const { renderPromptPackEntry } = await import("../src/infra/prompt-pack.mjs");
  const { loadRoutesConfig, resolveRouteDecision } = await import("../src/infra/route-table.mjs");
  const { installAdapter } = await import("../src/interface/adapters.mjs");
  const result = await initProjectDocuments(rootDir);
  const body = await renderPromptPackEntry(rootDir, { skill: result.architectureDesign.skill });
  assert.match(body, /name: review-architecture-design/);
  const routes = await loadRoutesConfig(rootDir);
  for (const prompt of ["审查旧架构图", "默认架构方案", "architecture design review"]) {
    const route = resolveRouteDecision(routes, prompt);
    assert.ok(route.skills.includes("review-architecture-design"), JSON.stringify(route));
    assert.equal(route.needsPlan, false);
    assert.equal(route.primaryAgent, "BaiZe");
  }
  await installAdapter(rootDir, "codex");
  const entry = await readFile(path.join(rootDir, ".agents/skills/wildarrange-architecture/SKILL.md"), "utf8");
  assert.match(entry, /prompts show --skill review-architecture-design/);
  await assert.rejects(readFile(path.join(rootDir, "doc/architecture.md")), { code: "ENOENT" });
});
