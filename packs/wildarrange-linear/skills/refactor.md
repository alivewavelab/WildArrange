# refactor

## 目的

做有边界的重构，同时不破坏行为：先映射影响面，窄范围编辑，每个单元后验证，外部验证通过前不 checkpoint。

## 必要计划字段

- 目标文件/符号/模式。
- 必须保持不变的现有行为。
- 影响面和 callers。
- Writable paths。
- Forbidden paths。
- 重构前验证。
- 重构后验证。
- 回滚或 retry hint。

## 重构前 Gate

worker 编辑前：

1. 探索引用和 callers。
2. 识别测试或可执行 QA。
3. 记录行为保持标准。
4. 定义精确 writable paths。
5. 没有 scope 的“cleanup”必须拒绝。

## Worker 规则

worker 必须：

- 保持行为。
- 每个任务只做一个 refactor unit。
- 避免机会主义 cleanup。
- 计划没写时，不新增抽象。
- 报告 changed files 和 commands run。

worker 不得：

- 混合 behavior change 和 refactor。
- 触碰无关 call sites。
- 因为“看起来等价”而跳过验证。

## 验证循环

1. YingLong 读取 changed files。
2. YingLong 运行重构前/后验证命令。
3. 高风险时 BaiZe/reviewer 检查行为保持。
4. PASS -> checkpoint。
5. FAIL -> 用确切失败证据 retry 原任务。

## 升级

连续失败后：

- 停止编辑。
- 记录失败方案。
- 咨询 BaiZe。
- 只有需要产品/设计决策时才问用户。
