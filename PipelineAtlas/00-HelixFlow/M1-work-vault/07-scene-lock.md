# 节点 07 · 不可合并文件硬锁 (R6 · 已拍板硬锁)
- 类型：GATE（commit/push 边界强制）
- 输入：待提交文件 + 引擎画像的 unmergeable_globs
- 输出：未持锁写入被拒
- 触发：编辑/提交命中 unmergeable 文件时
- 逻辑：基于 `git lfs lock`（行业标准，Unreal/Unity 团队通用），**远端 ref 做仲裁**；commit/push 边界 + Agent 编辑工具层强制拒绝未持锁写入；不做 OS 级写保护(引擎编辑器自身也写盘拦不住)
- 文件模式按引擎可追加：Unity `*.unity/*.prefab`；UE `*.uasset/*.umap`；其它引擎注册
- 工具/MCP：vault-server.lock + git-lfs；gates 边界 hook
