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
    awaitingHumanConfirmation: [
      "替换或删除全部 [待确认] 占位项",
      "确认测试策略、标准命令与必要门禁",
      "确认生产入口、测试入口和生产产物隔离方式",
      "确认模块边界、项目术语与公共接口兼容要求",
    ],
  };
}
