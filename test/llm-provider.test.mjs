// =============================================================================
// 文件名称：llm-provider.test.mjs
// 所属模块：test
// 作用说明：
//   验证 runLlmReview：stub fetch 下 decision 映射、
//   非法 JSON/空 content 降级、provider 配置路由。
//   不测：真实 LLM API 延迟、计费或模型质量。
//
// 【运行原理速读】
//   临时替换 globalThis.fetch 返回固定 choices，
//   调用 runLlmReview 断言 verdict 字段与 hallucination 过滤。
// =============================================================================

import assert from "node:assert/strict";
import test from "node:test";
import { runLlmReview } from "../src/infra/llm-provider.mjs";

const TEST_CONFIG = {
  review: { llm: { enabled: true } },
  agents: { BaiZe: { provider: "fake", model: "fake-model" } },
  modelProviders: { fake: { apiKey: "fake-key", baseUrl: "http://127.0.0.1:9" } },
};

const TEST_TASK = { id: "T001", subject: "decision mapping", writable_paths: ["src/**"] };

async function withStubbedFetch(content, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content } }], usage: null }),
  });
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function reviewWithDecision(content) {
  return withStubbedFetch(content, () => runLlmReview(null, "BaiZe", TEST_TASK, {}, { config: TEST_CONFIG }));
}

test("llm review: unknown decision strings never map to pass", async () => {
  for (const decision of ["MAYBE", "OK", "PASSSS", "1", "null"]) {
    const result = await reviewWithDecision(JSON.stringify({ decision, summary: "garbage" }));
    assert.equal(result.status, "warn", `decision=${decision} must downgrade to warn`);
    assert.equal(result.pass, false, `decision=${decision} must not pass`);
    assert.equal(result.decision, decision.toUpperCase());
  }
});

test("llm review: empty or missing decision never maps to pass", async () => {
  for (const payload of [{ decision: "", summary: "empty" }, { summary: "no decision field" }, { status: "", summary: "empty status" }]) {
    const result = await reviewWithDecision(JSON.stringify(payload));
    assert.equal(result.status, "warn", `payload=${JSON.stringify(payload)} must downgrade to warn`);
    assert.equal(result.pass, false);
    assert.notEqual(result.decision, "PASS", "empty decision must not be recorded as PASS");
  }
});

test("llm review: only PASS yields pass=true; FAIL and WARN keep their semantics", async () => {
  const pass = await reviewWithDecision(JSON.stringify({ decision: "PASS", summary: "ok" }));
  assert.equal(pass.status, "pass");
  assert.equal(pass.pass, true);

  const fail = await reviewWithDecision(JSON.stringify({ decision: "FAIL", summary: "bad" }));
  assert.equal(fail.status, "fail");
  assert.equal(fail.pass, false);

  const warn = await reviewWithDecision(JSON.stringify({ decision: "WARN", summary: "meh" }));
  assert.equal(warn.status, "warn");
  assert.equal(warn.pass, true);
});

test("llm review: decision matching is case-normalized", async () => {
  const lowerPass = await reviewWithDecision(JSON.stringify({ decision: "pass", summary: "ok" }));
  assert.equal(lowerPass.status, "pass");
  assert.equal(lowerPass.pass, true);

  const mixedFail = await reviewWithDecision(JSON.stringify({ decision: "Fail", summary: "bad" }));
  assert.equal(mixedFail.status, "fail");
  assert.equal(mixedFail.pass, false);
});
