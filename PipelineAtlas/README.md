# PipelineAtlas · 工作流节点源文件图谱

12 个 Agent 工作流框架的**真实源文件**，按 `项目 → 节点 → 提示词/工具/skill 源文件` 组织。配套可视化：`../doc/plans/2026-06-09-参考产品工作流图谱.html`（每节点的类型/输入/输出/触发/注入说明）。

## 目录约定
```
PipelineAtlas/
  NN-<项目>/
    NN-<节点>/        ← 每个工作流节点一个目录
      <真实源文件>     ← 该节点的注入提示词 / 工具 / skill 源文件
    _shared/ _docs/ _config/ ...  ← 跨节点共享的模板/文档/配置
    README.md         ← 节点→文件→注入要点 映射表
```

## 项目清单
| # | 项目 | 来源 | 节点源文件性质 |
|---|---|---|---|
| 00 | **HelixFlow**（我们的框架·DRAFT） | 自研设计 | SKILL.md 注入提示词草稿 + M1 工具规格 |
| 01 | claude-flow | git clone | SPARC 命令 .md / hooks / 工作流模板 |
| 02 | spec-workflow-mcp | git clone | MCP 工具 .ts（提示词/状态机内嵌）+ docs |
| 03 | BMAD-METHOD | git clone (24601 port) | agent .md + task .md + 模板 yaml + checklist |
| 04 | spec-kit | git clone | 命令模板 .md + CommandRegistrar(跨产品编译器) |
| 05 | OpenSpec | git clone | opsx 命令模板 .ts（getOpsx*Template）+ schema |
| 06 | Agent OS | git clone | 命令 .md + config |
| 07 | compound-engineering | 本机插件真实拷贝 | SKILL.md + references/(schema/persona/validator) + agents |
| 08 | oh-my-claudecode | git clone | skill .md + 关键词/持久化 hooks |
| 09 | oh-my-openagent | git clone | 神话角色 agent .md + 模型类别路由 |
| 10 | claude-forge | git clone (含submodule) | 命令 .md + agent .md + symlink 安装脚本 |
| 11 | SuperClaude | git clone | /sc: 命令 .md + MODE_*.md + persona |

## 怎么用
1. 想看某节点到底注入什么 → 进 `NN-项目/NN-节点/` 读真实源文件。
2. 想横向对比 → 看可视化 HTML 图谱（点节点展开）。
3. 想抄某个机制到 HelixFlow → 在 `00-HelixFlow/` 对应节点已标注"偷自"哪个项目，去那个项目目录读原文。

## 真实性说明
01–11 是开源项目的真实源文件（git clone / 本地插件拷贝）。少数节点的提示词不是独立文件而是内嵌在更大文件里（如 OpenSpec 在 `*.ts` 的 template 字符串、claude-flow 部分在 CLAUDE.md、BMAD 的 create-doc 是运行时解析）——这些已按各项目 README 注明 provenance。00-HelixFlow 是我们的设计草稿，非既有源码。
