# Infra 区规范

本目录是最低层技术底座。代码应尽量确定性、可复用、与具体业务流程无关。

## 负责

- 文件、路径、JSON、锁、配置、快照与持久化原语。
- 命令执行与高风险命令预检。
- Git diff/worktree、ledger、安全基线、LLM provider、规则扫描、仓库布局检查与记忆摘要等基础设施。

## 不负责

- 不决定任务何时完成、失败后是否重试或选择哪个 Agent。
- 不实现界面协议、宿主 adapter 或 prompt 策略。
- 不引用任何上层分区。

## 依赖

- 不得依赖 `interface/`、`orchestration/`、`ai/`、`capabilities/` 或旧 shim。

## 本区不变量

- 文件写入优先使用原子替换或明确提交点，避免半写状态。
- 锁必须可诊断并能恢复死进程、空文件和损坏 owner 信息。
- Ledger 进入 hash 链后，无 hash 行必须视为篡改。
- 命令安全内置规则是不可削弱底线；项目扩展规则只能追加。
- 路径范围判断必须归一化并考虑 realpath、符号链接和平台差异。
- Glob 语义必须稳定：`**/` 可匹配零层或多层目录，`*` 不跨越路径分隔符。
- 长期 Agent 固定白名单是机器约束；Prompt manifest、根配置和确定性路由不能仅靠相互引用形成自洽的第六角色。
- README 命令事实从真实 CLI `--help` 读取，不能扫描源码字符串代替；JavaScript 注释词法检查必须进入模板表达式并跳过字符串/正则正文。
- Provider 缺失或网络失败不能越权改变确定性质量门结果。
- Git 协调命令必须使用参数数组调用 Git，不拼接用户输入到 shell；所有远端写入只允许普通 push，禁止提供 force push 原语。
- Git 路径比较必须处理 macOS `/var` 与 `/private/var` 等 realpath 别名；`.helix/` 永远不进入 handoff 工作树变更清单。
- Infra 可以返回事实和证据，不能把“完成任务”作为自己的业务结论。
- `foundation.mjs` 仅为外部旧调用保留声明式 re-export；五区实现必须直接 import `runtime-store.mjs`、`runtime-config.mjs`、`task-state-lock.mjs`、`runtime-snapshot.mjs`、`prompt-pack.mjs`、`runtime-bootstrap.mjs`、`agent-registry.mjs` 或 `ledger.mjs` 的真实 owner。
- 恢复上下文的确定性文件读取和 Markdown/JSON 渲染只允许存在于 `runtime-snapshot.mjs`；`ai/context.mjs` 可保留公开薄封装，但不得维护第二份渲染实现。
- `TASK_STATUSES` 本轮作为持久化格式枚举归 `runtime-store.mjs`；若未来迁往 Orchestration，必须单独设计兼容边界，禁止 Infra 反向依赖上层。

## 交付证据

- 文件/锁/ledger 变化必须覆盖并发、部分失败和恢复。
- 命令执行变化必须覆盖超时、截断、退出码与安全拦截。
- Git/path 变化必须覆盖新增、修改、删除、glob、符号链接和越界路径。
- 远端 Git 变化必须使用本地 bare remote 测试，不依赖公网。
