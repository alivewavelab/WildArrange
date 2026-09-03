import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRouteDecision } from "../src/infra/route-table.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACK = path.join(ROOT, "packs", "wildarrange-linear");

test("feature design clarification is registered and selected for new features", async () => {
  const manifest = JSON.parse(await readFile(path.join(PACK, "manifest.json"), "utf8"));
  const routes = JSON.parse(await readFile(path.join(PACK, "routes.json"), "utf8"));

  assert.equal(manifest.skills["clarify-feature-design"], "skills/clarify-feature-design/SKILL.md");
  const decision = resolveRouteDecision(routes, "新增一个从游戏详情页启动游戏的功能");
  assert.ok(decision.skills.includes("clarify-feature-design"));
  assert.ok(decision.planSkills.some((entry) => entry.name === "clarify-feature-design"));
});

test("feature design skill keeps confirmation in conversation and leaves quality design downstream", async () => {
  const skill = await readFile(path.join(PACK, "skills", "clarify-feature-design", "SKILL.md"), "utf8");

  for (const required of ["用户目标", "使用者", "功能入口", "交互输入", "用户可见结果"]) {
    assert.match(skill, new RegExp(required));
  }
  assert.match(skill, /始终在当前对话中完成问答和确认/);
  assert.match(skill, /不要创建 MD、HTML、表单文件或计划草稿/);
  assert.match(skill, /API 或数据没有变化时，明确写“无”/);
  assert.match(skill, /不要在本 Skill 设计门、自动化测试、日志或验收任务/);
  assert.match(skill, /明确回复\*\*`确认`\*\*/);
  assert.match(skill, /不要在本 Skill 内写文件或启动 Worker/);
});

test("feature design clarification does not attach to a plain bug fix", async () => {
  const routes = JSON.parse(await readFile(path.join(PACK, "routes.json"), "utf8"));
  const decision = resolveRouteDecision(routes, "修复启动按钮点击后报错的问题");

  assert.equal(decision.intent, "debug");
  assert.equal(decision.skills.includes("clarify-feature-design"), false);
});

test("feature design clarification does not attach to an ordinary architecture plan", async () => {
  const routes = JSON.parse(await readFile(path.join(PACK, "routes.json"), "utf8"));
  const decision = resolveRouteDecision(routes, "制定一个仓库架构调整计划");

  assert.equal(decision.skills.includes("clarify-feature-design"), false);
});
