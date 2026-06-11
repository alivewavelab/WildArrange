# wa-spec

## 用途

需求到规格。spec 是约束所有下游的合同，不是普通文档。

## 注入提示词

每条 requirement 用 RFC2119 关键词标强度，并配 Given / When / Then 场景。

修改已有 spec 一律走 delta：ADDED / MODIFIED / REMOVED，写入 `changes/`，不得直接改主 spec，避免多人和多 Agent 并行冲突。

校验是否违反 `principles/constitution.md` 这类宪法级元约束。

## 输入 / 输出

- 输入：`brief.md` + constitution.md。
- 输出：`.workflow/specs/{feature}/spec.md` + `.workflow/changes/{feature}/specs/*.md`。

## 工具 / MCP

- artifacts-server：delta 合并、frontmatter 校验、spec 一致性检查。

## 质量门

每条 SHALL/MUST 都有对应场景；constitution 合规；delta 无冲突。
