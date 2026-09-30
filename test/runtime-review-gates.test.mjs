// =============================================================================
// 文件名称：runtime-review-gates.test.mjs
// 所属模块：test
// 作用说明：
//   复核门：LLM review、comment checker、review/standards 失败阻断 checkpoint。
// =============================================================================

import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { runNextTask, runWorkflowNode } from "../src/orchestration/linear-runtime.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withExternalProject } from "./helpers/external-fixture.mjs";
import { withLlmServer, nodeEval, writePolicyConfig } from "./helpers/runtime-fixtures.mjs";

test("LLM review gate uses OpenAI-compatible provider when configured", async () => {
  await withExternalProject(async ({ projectRoot, root, governanceRoot }) => {
    await withLlmServer((request, response) => {
      assert.equal(request.url, "/chat/completions");
      assert.equal(request.method, "POST");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              decision: "PASS",
              summary: "evidence is sufficient",
              findings: [],
            }),
          },
        }],
        usage: { total_tokens: 42 },
      }));
    }, async (baseUrl) => {
      await writePolicyConfig(governanceRoot, JSON.stringify({
        modelProviders: {
          local: { apiKeyEnv: "WILDARRANGE_TEST_LLM_KEY", baseUrl },
        },
        agents: {
          BaiZe: { provider: "local", model: "test-reviewer" },
        },
        review: {
          llm: { enabled: true, required: true, agents: ["BaiZe"] },
        },
      }, null, 2));
      process.env.WILDARRANGE_TEST_LLM_KEY = "test-key";
      await initRuntime(projectRoot);
      const planPath = path.join(root, "llm-review-plan.json");
      await writeFile(planPath, JSON.stringify({
        title: "LLM review",
        tasks: [{
          id: "T001",
          subject: "Write reviewed artifact",
          writable_paths: ["artifacts/llm.txt"],
          worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('artifacts',{recursive:true}); fs.writeFileSync('artifacts/llm.txt','ok')\"",
          verify_commands: ["node -e \"const fs=require('fs'); if(fs.readFileSync('artifacts/llm.txt','utf8')!=='ok') process.exit(1)\""],
          review_commands: [nodeEval("const fs=require('fs');const stat=fs.statSync('artifacts/llm.txt');if(!stat.isFile()||stat.size!==2)process.exit(1)")],
        }],
      }));
      const plan = await importPlan(projectRoot, planPath);

      const result = await runNextTask(projectRoot);
      assert.equal(result.status, "completed");
      assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "llm_BaiZe" && lane.status === "pass"));
      assert.equal(result.reviewResult.llmReviews[0].model, "test-reviewer");

      const reviewReport = await readJson(resolveWildArrangePath(projectRoot, "reports", "reviews", plan.id, "T001.json"));
      assert.equal(reviewReport.llmReviews[0].summary, "evidence is sufficient");
    });
  }, { init: false });
});

test("comment checker can block checkpoint when configured", async () => {
  await withExternalProject(async ({ projectRoot, root, governanceRoot }) => {
    await writePolicyConfig(governanceRoot, JSON.stringify({
      qualityGates: {
        commentChecker: {
          enabled: true,
          blockOnFindings: true,
          patterns: [{ name: "todo", pattern: "\\bTODO\\b" }],
        },
      },
    }, null, 2));
    await initRuntime(projectRoot);
    const planPath = path.join(root, "comment-gate-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Comment gate",
      tasks: [{
        id: "T001",
        subject: "Write source without placeholder comments",
        writable_paths: ["src/app.js"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/app.js','// TODO remove placeholder\\nexport const ok = true;\\n')\"",
        verify_commands: ["node -e \"const fs=require('fs'); if(!fs.readFileSync('src/app.js','utf8').includes('ok')) process.exit(1)\""],
        review_commands: ["node --version"],
        maxAttempts: 2,
      }],
    }));
    const plan = await importPlan(projectRoot, planPath);

    const result = await runNextTask(projectRoot);
    assert.equal(result.status, "failed");
    assert.equal(result.task.last_failure.reason, "review_gate_failed");
    assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "comment_checker" && lane.status === "fail"));
    assert.ok(result.reviewResult.findings.some((finding) => finding.source === "comment_checker" && finding.validator.status === "validated"));

    const reviewReport = await readFile(resolveWildArrangePath(projectRoot, "reports", "reviews", plan.id, "T001.md"), "utf8");
    assert.match(reviewReport, /src\/app\.js:1 todo/);
    assert.match(reviewReport, /## Structured Findings/);
    assert.match(reviewReport, /Validator: validated/);

    const reviewJson = await readJson(resolveWildArrangePath(projectRoot, "reports", "reviews", plan.id, "T001.json"));
    assert.ok(reviewJson.findings.some((finding) => finding.source === "comment_checker"));
    assert.ok(Array.isArray(reviewJson.testingGaps));
    assert.ok(Array.isArray(reviewJson.residualRisks));
  }, { init: false });
});

test("comment checker object patterns default to case-insensitive matching", async () => {
  await withExternalProject(async ({ projectRoot, root, governanceRoot }) => {
    await writePolicyConfig(governanceRoot, JSON.stringify({
      qualityGates: {
        commentChecker: {
          enabled: true,
          blockOnFindings: true,
          patterns: [{ name: "todo", pattern: "\\btodo\\b" }],
        },
      },
    }, null, 2));
    await initRuntime(projectRoot);
    const planPath = path.join(root, "comment-case-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Comment case gate",
      tasks: [{
        id: "T001",
        subject: "Block uppercase placeholder comments",
        writable_paths: ["src/app.js"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/app.js','// TODO uppercase placeholder\\nexport const ok = true;\\n')\"",
        verify_commands: ["node -e \"const fs=require('fs'); if(!fs.readFileSync('src/app.js','utf8').includes('ok')) process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importPlan(projectRoot, planPath);

    const result = await runNextTask(projectRoot);
    assert.equal(result.status, "failed");
    assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "comment_checker" && lane.status === "fail"));
  }, { init: false });
});

test("review gate failure blocks checkpoint and writes actionable failure report", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "review-fail-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Review fail",
      tasks: [{
        id: "T001",
        subject: "Pass verifier but fail review command",
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node -e \"console.error('review says no'); process.exit(4)\""],
        maxAttempts: 2,
      }],
    }));
    const plan = await importPlan(projectRoot, planPath);

    const result = await runNextTask(projectRoot);
    assert.equal(result.status, "failed");
    assert.equal(result.reviewResult.pass, false);
    assert.equal(result.task.last_failure.reason, "review_gate_failed");
    assert.match(result.task.last_failure.retryHint, /review says no/);

    const reviewReport = await readJson(resolveWildArrangePath(projectRoot, "reports", "reviews", plan.id, "T001.json"));
    assert.equal(reviewReport.status, "fail");
    assert.ok(reviewReport.lanes.some((lane) => lane.name === "explicit_review_commands" && lane.status === "fail"));

    const failureReport = await readFile(resolveWildArrangePath(projectRoot, "reports", "failures", plan.id, "T001.md"), "utf8");
    assert.match(failureReport, /review_gate_failed/);
  });
});

test("standards command failure blocks checkpoint through review gate", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "standards-fail-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Standards fail",
      defaults: {
        standards_commands: ["node -e \"console.error('standards says no'); process.exit(6)\""],
      },
      tasks: [{
        id: "T001",
        subject: "Pass verifier but fail standards",
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
        maxAttempts: 2,
      }],
    }));
    const plan = await importPlan(projectRoot, planPath);

    const result = await runNextTask(projectRoot);
    assert.equal(result.status, "failed");
    assert.equal(result.reviewResult.pass, false);
    assert.equal(result.task.last_failure.reason, "review_gate_failed");
    assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "project_standards" && lane.status === "fail"));

    const reviewReport = await readFile(resolveWildArrangePath(projectRoot, "reports", "reviews", plan.id, "T001.md"), "utf8");
    assert.match(reviewReport, /standards says no/);
    const failureReport = await readFile(resolveWildArrangePath(projectRoot, "reports", "failures", plan.id, "T001.md"), "utf8");
    assert.match(failureReport, /project_standards/);
  });
});

test("checkpoint node rejects tasks whose review gate does not pass", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "missing-review-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Failing review",
      tasks: [{
        id: "T001",
        subject: "Need passing review before checkpoint",
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node -e \"process.exit(5)\""],
        maxAttempts: 2,
      }],
    }));
    const plan = await importPlan(projectRoot, planPath);

    await runWorkflowNode(projectRoot, "execute", { taskId: "T001" });
    const checkpointed = await runWorkflowNode(projectRoot, "checkpoint", { taskId: "T001" });
    assert.notEqual(checkpointed.status, "completed");
    assert.notEqual(checkpointed.task.status, "completed");
    assert.equal(checkpointed.task.last_failure.reason, "review_gate_failed");
    await assert.rejects(() => readJson(resolveWildArrangePath(projectRoot, "checkpoints", plan.id, "T001.json")));
  });
});
