# Capabilities 区规范

本目录实现可单独调用、单独验证的原子能力；`gateway.mjs` 是上层唯一入口。

## 负责

- Worker、verifier、scope guard、review gate、code intelligence、repository governance、acceptance proof、checkpoint。
- 静态能力注册表与统一调用结果信封。gateway 当前注册名：`worker`、`verify`、`scope`、`review`、`acceptance-proof`、`checkpoint`、`command`、`command-safety`、`repository-governance`、`contract-governance-scan`、`contract-governance-apply-card`、`contract-governance-generate-artifacts`。`code-intel` 只被 `review-gate.mjs` 区内调用，不是 `invokeCapability` 名。

## 不负责

- 不决定质量门先后顺序、重试或任务状态推进。
- 不处理 Dashboard、宿主 adapter 或 AI prompt。
- 不直接管理跨能力事务。

## 依赖

- 只能依赖 `infra/`。
- 不得依赖 `interface/`、`orchestration/`、`ai/` 或旧 shim。

## 本区不变量

- 新可调用能力必须在 `gateway.mjs` 静态注册；禁止动态猜测模块路径。
- 网关结果必须保持 `capability`、`status`、`evidence`、`sideEffect`、`duration_ms`、`cost`、`error` 字段。
- 能力抛错必须被网关转换为明确失败，不得形成未处理 rejection。
- 新“强制质量门”除注册能力外，还必须由 `orchestration/delivery-pipeline.mjs` 接入；不要在多个运行时复制顺序。
- `inconclusive` 不是完成证据。
- Scope 判断必须覆盖 realpath 和符号链接逃逸。
- Repository governance 只写报告与 ledger 证据，不直接移动、重命名或删除受检文件。

## 交付证据

- 每项能力至少有 PASS、FAIL 和异常路径测试。
- 影响完成判定时，必须增加“不得 checkpoint”的回归测试。
- 新能力必须有稳定、可审计的 evidence，不接受只有自然语言“成功”的返回。
