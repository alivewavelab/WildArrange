// =============================================================================
// 文件名称：project-init.mjs
// 所属模块：interface
// 作用说明：
//   从 linear pack 模板初始化项目文档（AGENTS、规范、架构占位等）。
//   已存在文件不覆盖；结果写入 ledger 并返回待人工确认清单。
//
// 【运行原理速读】
//   可以把它想成「项目文档的首次铺底」：
//
//   · 谁调用？
//     wildarrange init --project-docs（及可选 --architecture）时触发。
//
//   · 它做了什么？
//     ① 从 packs/wildarrange-linear/project-init 读模板 ② flag=wx 仅创建新文件
//     ③ appendLedger project_documents_initialized 并提示架构审查 Skill。
//
//   · 缺了它会怎样？
//     新项目无 AGENTS/测试策略占位，治理 Skill 与规范挂载缺少依据文件。
// =============================================================================
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendLedger } from "../infra/ledger.mjs";

const PROJECT_DOCUMENT_TEMPLATE_DIR = fileURLToPath(new URL("../../packs/wildarrange-linear/project-init/", import.meta.url));
const PROJECT_DOCUMENT_TEMPLATES = [
  { source: "AGENTS.template.md", target: "AGENTS.md" },
  { source: "code-and-interface-conventions.md", target: "doc/standards/code-and-interface-conventions.md" },
  { source: "testing-and-acceptance.md", target: "doc/testing-and-acceptance.md" },
  { source: "progress.md", target: "doc/progress.md" },
  { source: "architecture.md", target: "doc/architecture.md", optional: "architecture" },
];

/**
 * 按模板创建项目文档；options.architecture 为 true 时额外写入 architecture.md。
 * @param {string} rootDir
 * @param {{ architecture?: boolean }} [options]
 */
export async function initProjectDocuments(rootDir, options = {}) {
  const selected = PROJECT_DOCUMENT_TEMPLATES.filter((template) => !template.optional || options[template.optional] === true);
  const loaded = await Promise.all(selected.map(async (template) => ({
    ...template,
    content: await readFile(path.join(PROJECT_DOCUMENT_TEMPLATE_DIR, template.source), "utf8"),
  })));
  const created = [];
  const preserved = [];

  for (const template of loaded) {
    const targetPath = path.join(rootDir, ...template.target.split("/"));
    await mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await writeFile(targetPath, template.content, { encoding: "utf8", flag: "wx" });
      created.push(template.target);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      preserved.push(template.target);
    }
  }

  await appendLedger(rootDir, {
    type: "project_documents_initialized",
    created,
    preserved,
    architectureIncluded: options.architecture === true,
  });
  return {
    created,
    preserved,
    architectureIncluded: options.architecture === true,
    architectureDesign: {
      status: "review_required",
      scope: "design_only",
      skill: "review-architecture-design",
      nextCommand: "prompts show --skill review-architecture-design",
      templateIsApproval: false,
    },
    awaitingHumanConfirmation: [
      "读取 review-architecture-design：已有设计先审查，无设计先提案；具体版本经人工确认后才作为权威设计",
      "替换或删除全部 [待确认] 占位项",
      "确认测试策略、标准命令与必要门禁",
      "确认生产入口、测试入口和生产产物隔离方式",
      "确认模块边界、项目术语与公共接口兼容要求",
    ],
  };
}
