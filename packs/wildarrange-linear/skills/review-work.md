# review-work

## 目的

有意义的实现完成后做后置 review。M1 可以线性执行各 lane；未来 adapter 可以并行 fan-out。

## 必要上下文

review 前收集：

- 原始目标。
- 约束和范围。
- Changed files。
- git 可用时收集 diff。
- 必要时收集 changed files 全文。
- Verification command output。
- Run command 或 surface QA path。
- 相关项目规范。

## Review Lanes

### 1. 目标验证器

问题：实现是否满足用户真实目标和约束？

检查：

- 明确需求。
- 合理隐含需求。
- 约束合规。
- 范围蔓延。
- 缺失验收标准。

### 2. QA 执行器

问题：它是否通过真实表面工作？

检查：

- Happy path。
- Boundary condition。
- Error path。
- Regression scenario。
- Evidence file/command/screenshot/log。

### 3. 代码审查器

问题：资深工程师会批准这个 diff 吗？

检查：

- Correctness。
- 项目模式一致性。
- Error handling。
- Type safety。
- 性能热点。
- 抽象层级。
- 测试质量。

### 4. 安全审计器

相关时运行：

- Inputs。
- Auth/authz。
- Secrets。
- Data exposure。
- File/path/network operations。
- Dependencies。
- Error leakage。

critical/high finding 会阻塞完成。

### 5. 上下文挖掘器

问题：是否遗漏了会改变决策的背景？

检查：

- touched files 的 git history。
- 现有 docs。
- 可用时相关 issues/PRs。
- TODO/FIXME warnings。
- 相邻 feature contracts。

## Verdict 规则

- 主 lane 必须 PASS。
- Security high/critical 阻塞。
- 证据缺失是 INCONCLUSIVE，不是 PASS。
- 任一 FAIL 返回 YingLong retry 或 Jiuwei 升级。

## 输出格式

```json
{
  "verdict": "PASS|FAIL|INCONCLUSIVE",
  "lanes": {
    "goal": "PASS|FAIL|INCONCLUSIVE",
    "qa": "PASS|FAIL|INCONCLUSIVE",
    "code": "PASS|FAIL|INCONCLUSIVE",
    "security": "PASS|FAIL|SKIPPED|INCONCLUSIVE",
    "context": "PASS|FAIL|INCONCLUSIVE"
  },
  "blockingIssues": [],
  "evidence": [],
  "retryHint": ""
}
```
