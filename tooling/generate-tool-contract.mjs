// 从 CLI 命令注册表重新生成 Prompt Pack 工具合同：node tooling/generate-tool-contract.mjs
import { writeFile } from "node:fs/promises";
import { renderToolContract } from "../src/interface/cli-help.mjs";

await writeFile(new URL("../packs/wildarrange-linear/tools/tool-contract.json", import.meta.url), renderToolContract(), "utf8");
