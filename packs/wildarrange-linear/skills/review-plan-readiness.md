# review-plan-readiness

## 用途

以 blocker-only 模式判断 worker 能否按计划开工。

## 检查

- 引用路径存在或有明确发现路径。
- 每个任务有 expected outcome、依赖和 `writable_paths`。
- 每个写入任务至少有一个能证明行为的 `verify_command`。
- 任务之间没有矛盾或无人产出的依赖。

返回 `[OKAY]`，或最多三个带 task/path 和修复要求的 `[REJECT]` blocker。命名偏好和可选优化不得阻断。
