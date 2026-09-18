// =============================================================================
// 文件名称：source-hygiene.test.mjs
// 所属模块：test
// 作用说明：
//   源码卫生：ai/skill-matcher.mjs 与 ai/suspicion-review.mjs 必须 LF-only（无 CR）。
//   不测：全仓库 EOL 策略或其他文件编码。
//
// 【运行原理速读】
//   读取两文件 utf8 内容，断言不包含 \r 字节。
// =============================================================================

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("source hygiene: ai/skill-matcher.mjs and ai/suspicion-review.mjs are LF-only", async () => {
  // 第 2 期整改将这两个文件从 CRLF 统一为 LF；CR 字节不得回流。
  for (const relativePath of ["src/ai/skill-matcher.mjs", "src/ai/suspicion-review.mjs"]) {
    const content = await readFile(path.join(REPO_ROOT, relativePath), "utf8");
    assert.ok(!content.includes("\r"), `${relativePath} must use LF line endings only`);
  }
});
