# wa-review

## 用途

代码 review 四段管线。机器交接 JSON / 人看 Markdown 双轨。

## 注入提示词

### 1. 扇出

always-on reviewer：

- 正确性。
- 测试。
- 可维护性。
- 项目规范。

按 diff 条件追加：

- security。
- performance。
- migration。
- 前端竞态。

每个 reviewer 写全量 JSON 到 `/tmp/wildarrange/{run_id}/{reviewer}.json`，只回 compact JSON 省上下文。高风险三项 correctness / security / adversarial 使用顶配模型，其余中配。

### 2. 去重

指纹 = 文件 + 行桶 ±3 + 标题。两个以上 reviewer 命中时，置信锚点升级。

### 3. 置信门控

抑制锚点小于 75 的非 P0 finding。但 P0 在锚点 50+ 时仍保留，critical-but-uncertain 绝不静默丢。

### 4. 独立验证波

每个幸存 finding 派独立 validator 复核，绝不 batch。batch 会重现 persona 偏置。返回 `{validated, reason}`，false 即丢。

对照 spec 做 Requirements Completeness 和 regression 影响分析。

## 输入 / 输出

- 输入：diff + plan/REQ-ID。
- 输出：agent mode 下 findings JSON；default mode 下 report.md；残留 finding 写 PR body 或 `docs/residual-review-findings/`。

## 工具 / MCP

- gates-server.review_gate。
- reviewer personas。

## 质量门

无未解决 P0/P1；交互模式可应用已验证安全修复并 commit，但永不 push。
