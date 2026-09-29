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
├── wildarrange.config.json      # 一份精简、可直接跑通的配置（复制到治理仓 policy/ 下生效）
└── plan.example.json      # 前后端各一个真实可跑通的最小任务
```

## 怎么用（把模板搬进你的项目）

1. 把 `AGENTS.md`、`.cursor/`（项目自有规则）、`plan.example.json` 复制到你**项目根目录**；把 `wildarrange.config.json` 复制为**治理仓库**的 `policy/wildarrange.config.json`（WildArrange 只读取这一份配置）。
2. 在你的项目中安装 WildArrange 并一步接入外置治理（不会向项目写入任何文件）：

   ```bash
   npm install --save-dev @alivewavelab/wildarrange
   npx wildarrange setup --governance-root ../my-project-governance --mode local
   ```

   `--target cursor|codex|kimi|all` 可选择宿主（默认 all）。宿主内的手工步骤（Cursor `adapter activate --target cursor`、Codex `/hooks` 审查并 trust、Kimi `/plugins install`）见命令输出的 `nextActions`。装完可直接用 `/wildarrange-config`、`/wildarrange-doctor`、`/wildarrange-plan`、`/wildarrange-run`。

   > 只有在 WildArrange 源码仓库内开发运行时，才把 `npx wildarrange` 换成 `node ./bin/wildarrange.mjs`。

3. **`.cursor/rules/*.md`**：把 `globs` 改成你项目真实的前后端路径/后缀，再填每条规范。
   - 验证命中：`npx wildarrange rules collect --target src/frontend/anyfile.tsx`，看命中的规范是否符合预期（改前端只应命中前端规范）。
4. **治理仓 `policy/wildarrange.config.json`**：需要时再按下面的"完整配置详解"逐块开启（如接入 typecheck 门、LLM 复核）。

---

## 完整配置详解（带注释的最佳示例）

> `wildarrange.config.json` 是纯 JSON，**不能写注释**。所以下面这份带注释的"完整结构"仅作讲解参考；本目录里的 `wildarrange.config.json` 是它的一个精简、非阻断子集，保证首次就能跑通。你只需要把想开启的块，去掉注释后并入自己的 `wildarrange.config.json` 即可（配置会与默认值深合并，只写你要改的块就行）。

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

  // 质量门。typecheck/lint 等命令请写进任务或计划默认的 standards_commands。
  "qualityGates": {
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
