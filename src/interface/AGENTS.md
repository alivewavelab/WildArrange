# Interface 区规范

本目录是人、宿主 IDE 与 WildArrange 核心之间的边界。

## 负责

- Dashboard HTTP API 与安全边界。
- Codex、Cursor、Kimi Code adapter 的生成、安装、卸载、恢复和说明。
- `doctor` 等面向用户的诊断汇总。
- 输入解析、输出渲染和宿主协议翻译。

## 不负责

- 不实现任务状态机、重试或质量门顺序。
- 不实现 verifier、scope、review 等原子能力。
- 不承载 AI 路由、prompt 或 Skill 匹配策略。

## 依赖

- 只允许依赖 `orchestration/` 与 `infra/`。
- 不得直接依赖 `ai/` 或 `capabilities/`。
- 不得通过旧 `src/helix-*.mjs` shim 绕过边界。

## 本区不变量

- Dashboard 默认只绑定 `127.0.0.1`；非 loopback 必须配置 token。
- Dashboard 写操作必须保留 token、Host、Origin / Sec-Fetch-Site 防护。
- Adapter 不得静默改写用户级配置；Kimi 用户级 plugin 必须由用户显式安装。
- 安装、覆盖、卸载 adapter 文件必须保留报告与可恢复备份。
- 宿主 Hook 只能增强早期拦截，不能被宣传为最终完成或唯一安全边界。

## 交付证据

- 更新对应 adapter / dashboard / doctor 测试。
- 用户命令变化同步更新 `README.md`、`README.en.md` 和 CLI help。
- Kimi 变更至少覆盖 plugin 生成、Hook bridge、非目标项目静默退出和卸载恢复。
