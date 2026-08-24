# git-master

## 用途

Git 历史调查、提交、rebase、fixup、bisect、blame、log -S/-G 等。普通代码编辑不触发，除非用户要求 git 工作。

## 模式门控

先分类：

- `COMMIT`：stage 并 commit 本地变更。
- `REBASE`：rebase、squash、fixup、autosquash、改写历史。
- `HISTORY`：回答谁、何时、哪个 commit、为什么改。
- `STATUS`：只查看 branch/diff/worktree 状态。

没有明确要求，不 commit、不 rebase、不 push、不 force-push、不 reset、不 stash-pop、不删除。

## 事实基线

先收集：

- `git status --short`
- `git diff --stat`
- `git diff --staged --stat`
- 当前 branch。
- 最近 commit message 风格。
- upstream 和 merge-base。

查询失败不是事实，只能说明信息缺失。

## 提交规则

- 只提交用户要求范围。
- 保护无关 dirty work。
- 先看完整 diff，不只看文件名。
- 按行为、模块、可回滚性分组。
- message 跟随仓库现有风格。
- commit 后验证 `git log -1 --oneline`。

## 历史规则

- 精确字符串变化：`git log -S`。
- 正则匹配变化：`git log -G`。
- 指定行责任：`git blame -L`。
- 单文件跨 rename：`git log --follow`。
- 相关 commit：`git show`。

## 安全

改写历史和 destructive git 命令必须明确授权。
