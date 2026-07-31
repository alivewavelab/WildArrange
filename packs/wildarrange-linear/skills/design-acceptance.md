# design-acceptance

## 用途

把产品意图转成 verifier 可以消费的验收场景。

## 检查

- 每个用户可见行为至少有一个 Given/When/Then。
- 每个高风险行为包含反例或失败路径。
- `successCriteria` 绑定具体命令、可观察输出或人工证据。

输出不可测试项、缺失边界、证据缺口及应新增的验证命令。
