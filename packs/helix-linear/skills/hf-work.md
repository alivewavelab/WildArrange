# hf-work

## 用途

执行单任务。纯执行角色。强调 worktree 隔离和持续 checkpoint。

## 注入提示词

task 的 context_package 已包含全部必要信息，不得主动加载外部文档。

只能修改 task 指派的区段，即 `writable_by`。

完成后 SendMessage 或流转到 review 阶段。

并行任务各自在独立 git worktree 或独立分支写，物理隔离，避免互相覆盖。持续自动 checkpoint 到 shadow ref。

always_load：

- coding-standards。
- tech-stack。
- source-tree。

## 输入 / 输出

- 输入：tasks.md 中某个 Implementation Unit。
- 输出：代码 + 更新 task 的 execution_record 区段 + 增量 commit。

## 工具 / MCP

- vault-server：worktree 隔离、checkpoint、merge 收口。
- Bash：测试命令。

## 质量门

有文件改动；本任务 DoD 自检通过。
