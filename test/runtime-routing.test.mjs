// =============================================================================
// 文件名称：runtime-routing.test.mjs
// 所属模块：test
// 作用说明：
//   请求路由：领域/Agent/类别判定与计划 Skill 组合。
// =============================================================================

import assert from "node:assert/strict";
import test from "node:test";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { withTempDir, routeRequest } from "./helpers/runtime-fixtures.mjs";

test("route decision loads product planning skills on demand", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const route = await routeRequest(dir, {
      text: "做一个网页版提醒事项 App，一期 MVP 要有清单流程、空状态、验收标准和失败恢复。",
    });

    assert.equal(route.domain, "visual");
    assert.equal(route.category, "visual-engineering");
    assert.ok(route.planSkills.some((skill) => skill.name === "review-product-intent"));
    assert.ok(route.planSkills.some((skill) => skill.name === "map-user-journey"));
    assert.ok(route.planSkills.some((skill) => skill.name === "design-acceptance"));
    assert.ok(route.planSkills.some((skill) => skill.name === "review-ux-interaction"));
    assert.ok(route.planSkills.some((skill) => skill.name === "review-scope-tradeoff"));
    assert.match(route.reason, /验收/);
  });
});

test("routeRequest maps high-risk domains to the right agents and categories", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const visual = await routeRequest(dir, "优化这个页面 CSS 布局和按钮动效");
    assert.equal(visual.domain, "visual");
    assert.equal(visual.category, "visual-engineering");
    assert.equal(visual.route, "execute");
    assert.ok(visual.skills.includes("frontend-ui-ux"));

    const dangerousDelete = await routeRequest(dir, "删除数据库里的生产数据");
    assert.equal(dangerousDelete.intent, "ask");
    assert.equal(dangerousDelete.route, "ask");
    assert.equal(dangerousDelete.needsUserInput, true);

    const governance = await routeRequest(dir, "检查仓库目录规范和 README 同步");
    assert.equal(governance.primaryAgent, "LuWu");
    assert.equal(governance.route, "verify");
    assert.ok(governance.skills.includes("repository-governance"));
    for (const request of ["检查 README 是否同步", "检查README是否同步", "检查代码注释是否合规"]) {
      const naturalGovernance = await routeRequest(dir, request);
      assert.equal(naturalGovernance.intent, "repository_governance", request);
      assert.equal(naturalGovernance.primaryAgent, "LuWu", request);
      assert.equal(naturalGovernance.route, "verify", request);
    }

    const review = await routeRequest(dir, "帮我 review 这次代码是否满足目标");
    assert.equal(review.intent, "review");
    assert.equal(review.primaryAgent, "BaiZe");
    assert.equal(review.category, null);
    assert.ok(review.skills.includes("review-work"));

    const routingReview = await routeRequest(dir, "复盘今天的路由误判");
    assert.equal(routingReview.intent, "routing_review");
    assert.equal(routingReview.primaryAgent, "BaiZe");
    assert.ok(routingReview.skills.includes("review-routing-decisions"));

    const reviewableArtifact = await routeRequest(dir, "write a reviewable artifact");
    assert.equal(reviewableArtifact.intent, "execute");
    assert.equal(reviewableArtifact.route, "execute");
    assert.ok(reviewableArtifact.confidence >= 0.5);

    const vagueExecute = await routeRequest(dir, "随便弄一下");
    assert.equal(vagueExecute.route, "plan");
    assert.equal(vagueExecute.routeAdjusted, true);
    assert.match(vagueExecute.adjustmentReason, /low route confidence/);

    const resume = await routeRequest(dir, "继续上次的工作，从断点恢复");
    assert.equal(resume.intent, "resume");
    assert.equal(resume.route, "recover");
    assert.equal(resume.nextCommand, "node ./bin/wildarrange.mjs resume");

    const architecture = await routeRequest(dir, "优化 Agent 路由和编排状态机，跑通完整 workflow");
    assert.equal(architecture.domain, "logic");
    assert.equal(architecture.route, "plan");
    assert.equal(architecture.primaryAgent, "DiJiang");
    assert.equal(architecture.category, "ultrabrain");

    // Feature requests start a persistent design gate, so keep them last in this
    // multi-case routing test; later utterances in the same session must remain gated.
    const scopeChange = await routeRequest(dir, "计划外新增一个支付功能");
    assert.equal(scopeChange.intent, "plan");
    assert.equal(scopeChange.route, "plan");

    const webTodo = await routeRequest(dir, "做一个网页版 TODO 工具，支持删除任务");
    assert.equal(webTodo.domain, "visual");
    assert.equal(webTodo.route, "plan");
    assert.equal(webTodo.category, "visual-engineering");
    assert.equal(webTodo.needsUserInput, true);
    assert.equal(webTodo.routeAdjusted, true);
    assert.match(webTodo.adjustmentReason, /require planning/);

    const normalAdd = await routeRequest(dir, "新增一个网页按钮");
    assert.equal(normalAdd.intent, "plan");
    assert.equal(normalAdd.route, "plan");
    assert.equal(normalAdd.category, "visual-engineering");
    assert.equal(normalAdd.needsUserInput, true);

    const plannedFeature = await routeRequest(dir, "实现计划筛选和已完成筛选");
    assert.equal(plannedFeature.intent, "plan");
    assert.equal(plannedFeature.route, "plan");
  });
});
