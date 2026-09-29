// =============================================================================
// 文件名称：runtime-review-gates.test.mjs
// 所属模块：test
// 作用说明：
//   复核门：LLM review、comment checker、review/standards 失败阻断 checkpoint。
// =============================================================================

import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { runNextTask, runWorkflowNode } from "../src/orchestration/linear-runtime.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withTempDir, withLlmServer, nodeEval } from "./helpers/runtime-fixtures.mjs";

test("LLM review gate uses OpenAI-compatible provider when configured", async () => {
  await withTempDir(async (dir) => {
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
      await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({
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
      await initRuntime(dir);
      const planPath = path.join(dir, "llm-review-plan.json");
      await writeFile(planPath, JSON.stringify({
        title: "LLM review",
        tasks: [{
          id: "T001",
          subject: "Write reviewed artifact",
          writable_paths: [".wildarrange/artifacts/llm.txt"],
          worker_command: "node -e \"const fs=require('fs'); fs.writeFileSync('.wildarrange/artifacts/llm.txt','ok')\"",
          verify_commands: ["node -e \"const fs=require('fs'); if(fs.readFileSync('.wildarrange/artifacts/llm.txt','utf8')!=='ok') process.exit(1)\""],
          review_commands: [nodeEval("const fs=require('fs');const stat=fs.statSync('.wildarrange/artifacts/llm.txt');if(!stat.isFile()||stat.size!==2)process.exit(1)")],
        }],
      }));
      const plan = await importPlan(dir, planPath);

      const result = await runNextTask(dir);
      assert.equal(result.status, "completed");
      assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "llm_BaiZe" && lane.status === "pass"));
      assert.equal(result.reviewResult.llmReviews[0].model, "test-reviewer");

      const reviewReport = await readJson(resolveWildArrangePath(dir, "reports", "reviews", plan.id, "T001.json"));
      assert.equal(reviewReport.llmReviews[0].summary, "evidence is sufficient");
    });
  });
});

test("comment checker can block checkpoint when configured", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({
      qualityGates: {
        commentChecker: {
          enabled: true,
          blockOnFindings: true,
          patterns: [{ name: "todo", pattern: "\\bTODO\\b" }],
        },
      },
    }, null, 2));
    await initRuntime(dir);
    await mkdir(path.join(dir, "src"), { recursive: true });
    const planPath = path.join(dir, "comment-gate-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Comment gate",
      tasks: [{
        id: "T001",
        subject: "Write source without placeholder comments",
        writable_paths: ["src/app.js"],
        worker_command: "node -e \"const fs=require('fs'); fs.writeFileSync('src/app.js','// TODO remove placeholder\\nexport const ok = true;\\n')\"",
        verify_commands: ["node -e \"const fs=require('fs'); if(!fs.readFileSync('src/app.js','utf8').includes('ok')) process.exit(1)\""],
        review_commands: ["node --version"],
        maxAttempts: 2,
      }],
    }));
    const plan = await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.equal(result.task.last_failure.reason, "review_gate_failed");
    assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "comment_checker" && lane.status === "fail"));
    assert.ok(result.reviewResult.findings.some((finding) => finding.source === "comment_checker" && finding.validator.status === "validated"));

    const reviewReport = await readFile(resolveWildArrangePath(dir, "reports", "reviews", plan.id, "T001.md"), "utf8");
    assert.match(reviewReport, /src\/app\.js:1 todo/);
    assert.match(reviewReport, /## Structured Findings/);
    assert.match(reviewReport, /Validator: validated/);

    const reviewJson = await readJson(resolveWildArrangePath(dir, "reports", "reviews", plan.id, "T001.json"));
    assert.ok(reviewJson.findings.some((finding) => finding.source === "comment_checker"));
    assert.ok(Array.isArray(reviewJson.testingGaps));
    assert.ok(Array.isArray(reviewJson.residualRisks));
  });
});

test("comment checker object patterns default to case-insensitive matching", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({
      qualityGates: {
        commentChecker: {
          enabled: true,
          blockOnFindings: true,
          patterns: [{ name: "todo", pattern: "\\btodo\\b" }],
        },
      },
    }, null, 2));
    await initRuntime(dir);
    await mkdir(path.join(dir, "src"), { recursive: true });
    const planPath = path.join(dir, "comment-case-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Comment case gate",
      tasks: [{
        id: "T001",
        subject: "Block uppercase placeholder comments",
        writable_paths: ["src/app.js"],
        worker_command: "node -e \"const fs=require('fs'); fs.writeFileSync('src/app.js','// TODO uppercase placeholder\\nexport const ok = true;\\n')\"",
        verify_commands: ["node -e \"const fs=require('fs'); if(!fs.readFileSync('src/app.js','utf8').includes('ok')) process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "comment_checker" && lane.status === "fail"));
  });
});

test("review gate failure blocks checkpoint and writes actionable failure report", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "review-fail-plan.json");
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
    const plan = await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.equal(result.reviewResult.pass, false);
    assert.equal(result.task.last_failure.reason, "review_gate_failed");
    assert.match(result.task.last_failure.retryHint, /review says no/);

    const reviewReport = await readJson(resolveWildArrangePath(dir, "reports", "reviews", plan.id, "T001.json"));
    assert.equal(reviewReport.status, "fail");
    assert.ok(reviewReport.lanes.some((lane) => lane.name === "explicit_review_commands" && lane.status === "fail"));

    const failureReport = await readFile(resolveWildArrangePath(dir, "reports", "failures", plan.id, "T001.md"), "utf8");
    assert.match(failureReport, /review_gate_failed/);
  });
});

test("review gate fails when verifier evidence is missing", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "review-missing-evidence-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Missing evidence review",
      tasks: [{
        id: "T001",
        subject: "Do not review without verifier evidence",
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    const plan = await importPlan(dir, planPath);

    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    const reviewed = await runWorkflowNode(dir, "review", { taskId: "T001" });
    assert.equal(reviewed.status, "review_failed");
    assert.ok(reviewed.reviewResult.lanes.some((lane) => lane.name === "evidence_integrity" && lane.status === "fail"));

    const reviewReport = await readJson(resolveWildArrangePath(dir, "reports", "reviews", plan.id, "T001.json"));
    assert.equal(reviewReport.status, "fail");
    assert.ok(reviewReport.lanes.some((lane) => lane.name === "evidence_integrity" && /verifyResult/.test(lane.summary)));
  });
});

test("standards command failure blocks checkpoint through review gate", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "standards-fail-plan.json");
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
    const plan = await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.equal(result.reviewResult.pass, false);
    assert.equal(result.task.last_failure.reason, "review_gate_failed");
    assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "project_standards" && lane.status === "fail"));

    const reviewReport = await readFile(resolveWildArrangePath(dir, "reports", "reviews", plan.id, "T001.md"), "utf8");
    assert.match(reviewReport, /standards says no/);
    const failureReport = await readFile(resolveWildArrangePath(dir, "reports", "failures", plan.id, "T001.md"), "utf8");
    assert.match(failureReport, /project_standards/);
  });
});

test("checkpoint node rejects tasks before review gate passes", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "missing-review-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Missing review",
      tasks: [{
        id: "T001",
        subject: "Need review before checkpoint",
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importPlan(dir, planPath);

    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    await runWorkflowNode(dir, "verify", { taskId: "T001" });
    await runWorkflowNode(dir, "scope", { taskId: "T001" });

    const checkpointed = await runWorkflowNode(dir, "checkpoint", { taskId: "T001" });
    assert.equal(checkpointed.status, "retry");
    assert.equal(checkpointed.task.status, "pending");
    assert.equal(checkpointed.task.last_failure.reason, "review_gate_failed");
  });
});
