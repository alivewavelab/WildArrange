# Fullstack Starter（前后端规范填充模板）

这是一个**空架子模板**：本身没有真实业务规范，但每个该填的地方都标注了"填什么、为什么、填了怎么生效"。你照着填，就能让 WildArrange 在你自己的前后端项目里稳定跑起来。

> 一句话记住分工：
> - **编码规范 / 前后端约束** → 放规则文件（`AGENTS.md` + `.cursor/rules/*.md`），按路径 `globs` 命中，按需注入。
> - **工作流 / 作业指导** → 放 prompt 包的 skills（见主仓库《使用说明书》第 4 节）。
> - 你的编码规范放规则文件，**不是 skills**。

## 目录内容

```text
fullstack-starter/
├── README.md              # 本文件：导览 + 带注释的完整配置 + 自检清单
├── AGENTS.md              # 全局红线空架子（永远生效，与文件类型无关）
├── .cursor/rules/
│   ├── frontend.md        # 前端规范空架子（globs 命中前端路径/后缀才注入）
│   ├── backend.md         # 后端规范空架子
│   └── database.md        # 数据库/迁移规范空架子
├── wildarrange.config.json      # 一份精简、可直接跑通的配置（真正生效的文件）
└── plan.example.json      # 前后端各一个真实可跑通的最小任务
```

## 怎么用（把模板搬进你的项目）

1. 把本目录的文件复制到你**项目根目录**（`AGENTS.md`、`.cursor/`、`wildarrange.config.json`、`plan.example.json`）。
2. 先在你的项目中安装 WildArrange，再按宿主安装适配器：

   ```bash
   npm install --save-dev @alivewavelab/wildarrange
   ```

   然后二选一：

   **Cursor：**
   ```bash
   npx wildarrange init
   npx wildarrange adapter install --target cursor --mode local
   ```
   装完在 Cursor 聊天里可直接用 `/wildarrange-config`、`/wildarrange-doctor`、`/wildarrange-plan`、`/wildarrange-run`。

   **Codex：**
   ```bash
   npx wildarrange init
   npx wildarrange adapter install --target codex --mode local
   ```
   适配器会写 `.codex/hooks.json`（在 Codex 里执行 `/hooks` review 并 trust 后成为硬拦截）和 `.agents/skills/wildarrange-*/SKILL.md`。用 `/skills` 或 `$wildarrange-doctor` 触发。

   > 两端都要：`--target all`。只有在 WildArrange 源码仓库内开发运行时，才把 `npx wildarrange` 换成 `node ./bin/wildarrange.mjs`。

3. 先跑通一次冒烟（见下"自检清单"），确认架子是通的，再开始填规范。

## 先跑通一次（自检清单）

按顺序做，每一步都应通过；任一步失败就停下来看它报的原因：

- [ ] 1. 导入示例计划：`npx wildarrange plan --from plan.example.json`（应报 `taskCount: 2`）
- [ ] 2. 跑第一个任务：`npx wildarrange run`（前端任务，走完 worker→verify→scope→review→验收→checkpoint）
- [ ] 3. 再跑一次：`npx wildarrange run`（后端任务）
- [ ] 4. 再跑一次：`npx wildarrange run`（应返回 `status: complete`，无剩余任务）
- [ ] 5. 确认产物：`src/frontend/hello.js` 与 `src/backend/health.js` 已生成
- [ ] 6. 体检：`npx wildarrange doctor`（或 `/wildarrange-doctor`），应无严重异常
- [ ] 7. 校验配置：`npx wildarrange config verify`

跑通后，删掉 `plan.example.json` 里的示例任务，换成你真实的任务即可。

## 填规范的顺序建议

1. **`AGENTS.md`**：先填红线和命令表（install/dev/test/lint/typecheck）。
2. **`.cursor/rules/*.md`**：把 `globs` 改成你项目真实的前后端路径/后缀，再填每条规范。
   - 验证命中：`npx wildarrange rules collect --target src/frontend/anyfile.tsx`，看命中的规范是否符合预期（改前端只应命中前端规范）。
3. **`wildarrange.config.json`**：需要时再按下面的"完整配置详解"逐块开启（如接入 typecheck 门、LLM 复核）。

---

## 完整配置详解（带注释的最佳示例）

> `wildarrange.config.json` 是纯 JSON，**不能写注释**。所以下面这份带注释的"完整结构"仅作讲解参考；本目录里真正生效的 `wildarrange.config.json` 是它的一个精简、非阻断子集，保证首次就能跑通。你只需要把想开启的块，去掉注释后并入自己的 `wildarrange.config.json` 即可（配置会与默认值深合并，只写你要改的块就行）。

```jsonc
{
  "version": 1,

  // 各角色 Agent 用哪个 provider / model。provider=host 表示交给宿主（Cursor/Codex）当前主模型。
  "agents": {
    "Jiuwei": { "role": "workflow_orchestrator", "provider": "host", "model": "host-default", "reasoning": "high" },
    "BaiZe":    { "role": "goal_verifier",    "provider": "host", "model": "host-default", "reasoning": "high" }
  },

  // 外部模型走 OpenAI 兼容配置。apiKeyEnv 填【环境变量名】，不要把密钥写进文件。
  "modelProviders": {
    "deepseek": { "type": "openai-compatible", "apiKeyEnv": "DEEPSEEK_API_KEY", "defaultBaseUrl": "https://api.deepseek.com" }
  },

  // 是否启用 LLM 复核。required=false 时：没配 key 只告警，不阻断流水线。想要强制复核再设 true。
  "review": {
    "llm": {
      "enabled": false,
      "required": false,
      "agents": ["BaiZe"]
    }
  },

  // 计划确认门。true 时导入的计划要开发者确认（/wildarrange-approve 或 plan approve）后才能 run。默认 false。
  "planApproval": { "required": false },

  // 命令安全：内置高危正则不可关闭；这里只“加”项目专属危险命令拦截。
  "commandSafety": {
    "extraPatterns": [
      { "id": "no_prod_deploy", "pattern": "deploy\\s+--env\\s+prod", "flags": "i", "reason": "生产部署必须走人工流程" }
    ]
  },

  // 质量门。enabled 打开某个门，required 决定失败是否阻断（false=只告警）。
  // 接入你自己的命令后再打开，比如把 typecheck 挂到 lspDiagnostics。
  "qualityGates": {
    "lspDiagnostics": { "enabled": false, "required": false, "commands": ["npm run typecheck --silent"] },
    "astStructure":   { "enabled": false, "required": false, "commands": [] },
    // commentChecker 扫 AI 痕迹/占位注释；blockOnFindings=false 时只提示不拦截。
    "commentChecker": { "enabled": true,  "blockOnFindings": false }
  },

  // 技能按需挂载：只把和本次请求匹配的候选技能注入全文，其余降级为一行引用。
  "skillMatcher": {
    "dynamicInjection": {
      "enabled": true,
      "maxSkills": 4,
      "alwaysMount": ["wildarrange-injection-runtime"]
    }
  },

  // 规则扫描范围。默认已包含 AGENTS.md / CLAUDE.md 和 .cursor/rules 等，一般不用改。
  "ruleInjection": {
    "projectSingleFiles": ["AGENTS.md", "CLAUDE.md", "CONTEXT.md", ".github/copilot-instructions.md"],
    "projectRuleDirs": [".claude/rules", ".cursor/rules", ".github/instructions"]
  }

  // 高级：injectionPoints 可细调每个注入点挂哪些 tools/markdown/skills/rules。
  // 不确定就别动，用默认；要改先看主仓库《使用说明书》第 7 节。
}
```

## 常见问题

- **改了规范要不要重新 init？** 改**已存在**规则文件的正文 → 立即生效，不用刷新。**新增**规则文件 → 也会被自动扫描到，不用特意 init。`init` 是幂等的，不会清任务和账本。
- **为什么我的前端规范没生效？** 检查该规则文件的 `globs` 是否命中了本次任务的 `writable_paths` 或实际改动路径。用 `rules collect --target <文件路径>` 验证。
- **Codex 里 slash 命令不出现？** 确认已 `adapter install --target codex`，并在 Codex 里 `/hooks` trust 过本项目；skill 变更后重启一下 Codex 会话。
