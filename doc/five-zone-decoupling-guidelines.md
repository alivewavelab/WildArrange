# 五区受控解耦准则（可复用版）

> 适用于带 CLI、工作流编排、AI 策略、原子能力和本地基础设施的 Agent/自动化项目。本文只定义可复用的架构治理规则，不绑定 WildArrange 的具体业务名称。  
> 人与 AI 的分工、日常掌控流程与成熟度分级见 [low-code-project-governance.md](./low-code-project-governance.md)。

## 1. 一句话原则

解耦不是“把文件放进五个目录”，而是让每类代码只有一个清楚的职责，并用自动测试保证依赖只能沿批准方向流动。

准确名称应是：**五区受控依赖 + 无模块级循环**。它不承诺所有关系绝对单向；确有必要的跨区边必须只读、走网关或进入逐条白名单，不能整区放开。

## 2. 目标与非目标

### 目标

- 修改工作流顺序时，不需要进入具体能力实现。
- 修改某项检查能力时，不需要改写所有调用流程。
- 替换宿主、模型或存储方式时，不污染核心状态机。
- 旧调用方可以渐进迁移，不要求一次性改完。
- 依赖违规、循环依赖和绕过网关能被测试直接拦截。
- 发生失败或崩溃时，状态、文件和审计证据保持一致。

### 非目标

- 不追求每个文件都很小。
- 不为理论上的未来需求提前增加层级。
- 不把所有函数都包装成接口、类或依赖注入容器。
- 不为了“严格单向”复制状态读取、范围判断或质量门逻辑。
- 不追求覆盖无法合理恢复的全部极端情况；关键路径失败关闭、可诊断、可人工恢复即可。

## 3. 五区职责

| 区域 | 推荐目录 | 只负责什么 | 不应负责什么 |
| --- | --- | --- | --- |
| Interface（接口区） | `src/interface/` | CLI、HTTP、Dashboard、宿主 adapter、输入输出格式、人机交互 | 工作流状态机、具体检查逻辑、AI 策略 |
| Orchestration（编排区） | `src/orchestration/` | 任务顺序、重试、分支、claim、事务、质量门顺序、状态推进 | 具体 verifier 实现、底层文件/进程细节、prompt 内容 |
| AI（策略区） | `src/ai/` | 路由、prompt、上下文、技能匹配、语义判断、宿主生命周期策略 | 持久化事务、具体原子能力实现、通用底层设施 |
| Capabilities（能力区） | `src/capabilities/` | 可独立调用和验证的原子能力，以及统一能力网关 | 跨能力工作流顺序、界面协议、AI 策略 |
| Infra（基础设施区） | `src/infra/` | 文件、JSON、锁、命令执行、安全预检、Git、日志、配置、存储 | 用户交互、业务工作流决策、AI 路由 |

判断归属时只问三个问题：

1. **谁决定先后顺序？** 放 Orchestration。
2. **谁执行一个可独立验证的动作？** 放 Capabilities。
3. **谁提供与业务无关的技术手段？** 放 Infra。

如果代码直接面对人或宿主，放 Interface；如果核心价值是语义、prompt 或模型策略，放 AI。

## 4. 依赖方向

默认依赖关系如下：

```text
Interface
  -> Orchestration
  -> Infra

Orchestration
  -> AI                 # 仅逐条白名单
  -> Capabilities       # 仅经 gateway
  -> Infra

AI
  -> Orchestration      # 仅只读，确有需要时开放
  -> Capabilities       # 仅经 gateway
  -> Infra

Capabilities
  -> Infra

Infra
  -> 不依赖任何上层区
```

### 硬规则

1. Infra 不得依赖 Interface、Orchestration、AI 或 Capabilities。
2. Capabilities 只能依赖 Infra，不得知道工作流、界面或 AI 策略。
3. Orchestration 和 AI 调用能力时，只能进入 `capabilities/gateway.*`，不得直接 import 具体能力文件。
4. AI → Orchestration 只能读状态或报告，不得推进任务、提交事务或修改权威状态。
5. Orchestration → AI 必须逐文件、逐目标加入白名单；禁止放宽为整区自由依赖。
6. 所有区域都不得形成模块级 import 环。
7. 区内实现必须直接 import 目标实现文件，不能经过兼容 barrel/shim 绕路。

### 例外原则

出现新跨区依赖时，按以下顺序处理：

1. 先确认职责是否放错区。
2. 能下沉为确定性、无 AI 的读取逻辑时，下沉到 Infra。
3. 能通过能力网关调用时，走 gateway。
4. 仍必须跨区时，只开放最窄的文件级白名单，并说明只读/读写属性。
5. 先更新规范与边界测试，再提交实现。

不得为了让测试变绿而扩大整张允许依赖表。

## 5. 能力网关准则

能力网关是编排层与原子能力之间唯一的门。它解决的是“调用契约统一”，不是增加一层没有价值的转发。

### 网关必须提供

- 静态注册表：能力名明确、可枚举、可测试。
- 单一调用入口，例如 `invokeCapability(name, context)`。
- 统一结果信封，至少包含：

```text
capability
status
evidence
sideEffect
duration_ms
cost
error
```

- 能力抛出的异常转换成明确的失败结果，避免编排层漏接异常。
- 未注册能力直接失败，不允许动态猜测模块路径。

### 两类变化必须区分

- **新增可调用能力**：新增能力实现，并在 gateway 注册。
- **新增强制质量门**：除注册外，只在共享交付流水线中加入一次。

不要在线性流程、并行流程、单步流程里各复制一套质量门顺序。

## 6. 质量门与完成判定

Worker 只能声明“我做完了”，不能自己证明完成。任务进入 `completed` 前至少满足：

```text
worker result
  -> verifier
  -> scope guard
  -> review
  -> success criteria
  -> acceptance proof
  -> checkpoint
```

### 不变量

- `verify_commands` 不得为空、被删除或被完成路径绕过。
- verifier、scope、review、success criteria 任一未通过，不得 checkpoint。
- 质量门证据必须绑定本轮 worker 结果；新一轮执行不能复用旧轮 PASS。
- checkpoint 写入失败必须返回失败/重试，不能把内存中的成功当作完成。
- 所有完成入口必须复用同一条 delivery pipeline 或它定义的完成段。
- 质量门顺序只能在一个文件中维护。

## 7. 状态、事务与恢复

解耦后的模块仍共享一个事实世界。必须避免“状态说成功，文件却失败”或“任务已释放，回滚还在进行”。

### 权威状态

- 每类状态只能有一个权威读取源。
- Markdown 摘要、镜像 JSON、Dashboard 数据都是派生产物，不得反向覆盖权威状态。
- 持久化时先写派生产物，最后写权威状态；权威状态是提交点。
- 完成审计事件先落账，再提交权威 `completed` 状态。

### 修改工作区的事务

按以下顺序执行：

```text
claim owner
  -> writable scope precheck
  -> persist rollback pre-image
  -> apply files/patch
  -> run gates
  -> commit OR rollback
  -> release owner
```

必须满足：

1. 任何工作区写入前，先持久化 owner/claim。
2. 第一笔文件写入前，先持久化可恢复的 pre-image 或 patch rollback plan。
3. apply、gates、commit/rollback 必须处于同一互斥临界区，不能让其他任务插入修改。
4. 真正写文件前重新读取权威 owner 与 phase，拒绝过期调用。
5. 门控失败时先回滚，回滚成功后才能释放 owner。
6. 回滚失败时保留 claim、rollback plan 和可诊断状态；禁止后继任务接管脏工作区。
7. 恢复时只信持久化的 pre-image，不得从已被修改的工作区重新生成并覆盖它。
8. 完成后的补释放必须由可信完成证据证明，不能只看 worker/admission 声明。

### 必备产物与便利产物

- 必备产物：缺失时任务不能完成，应放在事务提交点之前。
- 便利产物：例如快照、通知、摘要；提交后失败只记录 warning，不应反向撤销完成状态。

## 8. 兼容层准则

旧路径需要保留时，使用声明式兼容 shim：

```js
/** @deprecated Import the zoned implementation directly. */
export * from "./orchestration/example.mjs";
```

硬规则：

- shim 只允许 `export`/必要的声明式 `import`，不得包含业务逻辑。
- 新代码不得 import shim 或总 barrel。
- shim 只服务外部调用方和迁移期旧代码。
- 删除 shim 前先统计真实调用量，并绑定明确版本或迁移窗口。
- 一个旧模块拆成多个新区文件时，可以做多行具名 re-export；重点是“无逻辑”，不是“一行”。

## 9. 文件拆分尺度

建议阈值：

- 700 行以内：通常无需讨论。
- 700–1000 行：必须评估职责是否混杂，但不强制拆。
- 超过 1000 行：默认按职责拆分，除非有明确书面理由。

### 应该拆的信号

- 文件有两个以上互不相关的变化原因。
- 上半部分和下半部分几乎不共享状态或私有 helper。
- 修改一种能力经常误伤另一种能力。
- 测试只能通过大量内部 mock 才能覆盖不同职责。
- 文件同时包含界面、编排、能力实现或基础设施中的两类以上职责。

### 不应该拆的信号

- 只是超过了行数阈值。
- 拆出后新文件只有转发和参数搬运。
- 一个事务的 phase、rollback 和恢复 helper 被迫跨多个模块来回跳转。
- 拆分会新增双向依赖、共享可变状态或更多公开 API。

原则：**按独立变化原因拆，不按函数数量拆；高内聚的大文件优于低内聚的小文件群。**

## 10. 自动化边界测试

架构图只能解释规则，测试才负责执行规则。至少覆盖：

1. 每个区域只能 import 允许的目标区域。
2. Orchestration/AI 只能通过 gateway 进入 Capabilities。
3. Capabilities 不得反向依赖 AI 或 Orchestration。
4. Orchestration → AI 只允许钉死的白名单边。
5. 五区文件不得 import 兼容 shim/barrel。
6. 全源码无模块级 import 环。
7. shim 只包含声明式转发。

需要可靠静态扫描时，再增加：

- 禁止非字面量动态 `import()`。
- 禁止 `file:`、`data:` 和绝对路径 specifier 绕过相对路径分析。
- 扫描器正确忽略注释、字符串、模板文本和正则中的伪 import。

不要一开始实现复杂解析器。先用能覆盖项目语法的最小扫描；出现真实绕过样例后，再把样例固化为回归测试。

## 11. 重构实施顺序

1. **盘点**：列出文件、真实 import 图、循环依赖、公共导出和运行时入口。
2. **写规则**：先确定五区职责、允许依赖表、例外白名单和兼容承诺。
3. **先建边界测试**：让违规依赖可见，但迁移期可按 Phase 逐步收紧。
4. **从底向上移动**：Infra → Capabilities → AI → Orchestration → Interface。
5. **建立 gateway**：先统一能力调用契约，再迁移编排调用方。
6. **收口 delivery pipeline**：删除多份门控顺序。
7. **留下 shim**：保持旧外部调用可用，内部全部直连新区实现。
8. **清理循环与绕路**：钉死白名单、禁止 shim laundering（借壳绕过）。
9. **对抗测试**：覆盖并发、崩溃、回滚失败、证据复用和持久化失败。
10. **全量验证**：测试、包体、CLI 冒烟、文档链接和工作区状态。

每个 Phase 都应保持可运行，不要把“移动文件”和“大规模行为修改”塞进同一次提交。

## 12. Review 检查清单

### 新文件

- [ ] 文件归属能用一句话解释。
- [ ] 没有更合适的现有模块。
- [ ] import 只指向允许区域。
- [ ] 没有通过 shim/barrel 绕过边界。

### 新能力或质量门

- [ ] 能力实现位于 Capabilities。
- [ ] 调用经 gateway，结果使用统一信封。
- [ ] 强制门只在共享 delivery pipeline 加一次。
- [ ] 失败路径不能 checkpoint。
- [ ] 有自动测试证明 PASS 与 FAIL。

### 状态与工作区修改

- [ ] 权威状态源唯一。
- [ ] claim 发生在第一笔写入前。
- [ ] rollback plan 发生在第一笔写入前。
- [ ] owner 在写入前再次校验。
- [ ] rollback 成功前不释放所有权。
- [ ] 崩溃后能由原 owner 恢复或明确进入人工恢复状态。

### 兼容与交付

- [ ] 旧路径只保留声明式 shim。
- [ ] 新代码不依赖 shim。
- [ ] 依赖边界测试、循环检测和全量测试通过。
- [ ] 包内容变化时执行打包预检。
- [ ] 架构文档和目录职责同步更新。

## 13. 常见反模式

- **目录换皮**：文件搬进五区，但内部仍经总 barrel 相互调用。
- **万能 gateway**：所有函数都经过 gateway，导致普通内部调用也失去静态类型和可追踪性。
- **编排复制**：线性、并行、CLI 各维护一份质量门顺序。
- **能力自编排**：verifier 内部决定重试、checkpoint 或任务状态。
- **Infra 业务化**：基础设施模块开始判断任务是否完成、该走哪个 Agent。
- **AI 直接写状态**：prompt/hook 模块直接推进任务或落盘完成状态。
- **为了单向而复制**：复制 scope、路由表或状态判断，只为避免一条受控只读边。
- **按行数机械拆分**：产生大量只有几十行的转发文件和跨文件跳转。
- **放宽测试求绿**：遇到违规 import 就扩大整区许可，而不是修正职责或加精确白名单。

## 14. 最小落地模板

```text
src/
  interface/
  orchestration/
    delivery-pipeline.*
  ai/
  capabilities/
    gateway.*
  infra/
  legacy-entry.*          # 仅声明式兼容导出

test/
  dependency-boundary.*
  delivery-pipeline.*
  recovery-integrity.*
```

第一版只需要四道强制约束：

1. Infra 不反向依赖。
2. Capabilities 不知道编排。
3. Orchestration/AI 只经 gateway 调能力。
4. 全源码无 import 环。

等真实项目出现 shim、动态 import 或双向只读边，再增加相应规则。不要一次性复制所有防护。

## 15. 放行标准

满足以下证据，才能声称“解耦完成”：

- 真实 import 图符合允许依赖表，而不只是目录名正确。
- 所有例外边都有文件级白名单和原因。
- 具体能力只通过 gateway 暴露给编排/AI。
- 所有完成入口复用同一门控定义。
- 无模块级循环，兼容 shim 无业务逻辑。
- 并发、失败、回滚和恢复测试证明状态与文件一致。
- 全量测试、打包预检和主要入口冒烟通过。
- 维护者能根据“改 X 去哪改”在一个区域内找到主要修改点。

如果只能证明测试通过，却不能证明测试覆盖上述每项要求，就不能据此宣称解耦完成。

## 16. WildArrange 映射示例

| 通用角色 | WildArrange 对应实现 |
| --- | --- |
| Interface | `src/interface/` |
| Orchestration | `src/orchestration/` |
| AI | `src/ai/` |
| Capabilities + gateway | `src/capabilities/`、`src/capabilities/gateway.mjs` |
| Infra | `src/infra/` |
| Shared delivery pipeline | `src/orchestration/delivery-pipeline.mjs` |
| Dependency enforcement | `test/dependency-boundary.test.mjs` |
| Recovery/adversarial tests | `test/checkpoint-integrity.test.mjs` |
| Legacy compatibility shims | `src/helix-*.mjs`、`src/helix-core.mjs` |

项目实现细节以 [`project-architecture.md`](./project-architecture.md) 为准；本文负责可复制的原则与检查清单。

## 17. 用目录级 AGENTS.md 做渐进式披露

大型仓库不应把所有实现细节都塞进根规则。推荐把规范分成两层：

```text
AGENTS.md                 # 全局目标、依赖图、安全不变量、总体验收
src/AGENTS.md             # 源码区共同规则与归属判断
src/<zone>/AGENTS.md      # 单区职责、允许依赖、局部不变量、测试证据
test/AGENTS.md            # 测试不得削弱的边界
doc/AGENTS.md             # 文档事实源与同步要求
```

目录级规范应遵守五条规则：

1. **只写差异**：子目录不复制整份根规范，只补本目录特有职责。
2. **只收紧不放宽**：子目录可以增加限制，不能取消根级安全、质量门或发布约束。
3. **离代码最近**：规则放在它治理的最小稳定目录，避免维护者跨仓库寻找。
4. **说明验收证据**：每份局部规范都写清变化后必须运行的测试或核对项。
5. **保持短而可扫读**：详细背景仍放架构文档；AGENTS.md 负责行动边界和入口。

当目录职责发生变化时，先更新最近的 `AGENTS.md` 和架构图，再修改实现。这样 Agent 进入某一区时获得足够上下文，同时不会在每次任务中加载整套仓库细节。
