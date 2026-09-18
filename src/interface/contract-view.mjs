// =============================================================================
// 文件名称：contract-view.mjs
// 所属模块：interface
// 作用说明：
//   从契约治理台账与扫描结果生成人类可读的契约总图 HTML。
//   只读 registry/scan 并写产物，不修改契约审批状态。
//
// 【运行原理速读】
//   可以把它想成「契约地图的静态站点生成器」：
//
//   · 谁调用？
//     wildarrange contracts generate 或治理流水线在契约变更批准后触发。
//
//   · 它做了什么？
//     ① 读取 registry 与 currentScan ② 渲染 HTML 卡片与未知区域
//     ③ 写入 contract-governance 配置的 html 路径。
//
//   · 缺了它会怎样？
//     开发者只能看 JSON 台账，难以浏览正式契约与待人工申报项。
// =============================================================================
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJson } from "../infra/runtime-store.mjs";
import { contractGovernancePaths, readContractRegistry, contractSourcePaths, relative } from "../infra/contract-governance.mjs";

/**
 * 生成契约总图 HTML 并返回产物摘要。
 * @param {string} rootDir 项目根目录
 * @returns {Promise<{ kind: string, registryPath: string, htmlPath: string, contracts: number, unknown: number }>}
 */
export async function generateContractArtifacts(rootDir) {
  const paths = contractGovernancePaths(rootDir);
  const registry = await readContractRegistry(rootDir);
  const scan = await readJson(paths.currentScan, null);
  await mkdir(path.dirname(paths.html), { recursive: true });
  await writeFile(paths.html, renderContractMapHtml(registry, scan), "utf8");
  return {
    kind: "contract_governance_artifacts",
    registryPath: relative(rootDir, paths.registry),
    htmlPath: relative(rootDir, paths.html),
    contracts: registry.contracts.length,
    unknown: scan?.coverage?.unknown?.length || 0,
  };
}

/**
 * 将 registry 契约项与 scan 未知区渲染为单页 HTML。
 * @param {{ contracts: Array<object> }} registry
 * @param {{ coverage?: { unknown?: Array<object>, manualRequired?: Array<object> } }|null} scan
 * @returns {string}
 */
function renderContractMapHtml(registry, scan) {
  const cards = registry.contracts.map((item) => `<section><h2>${escapeHtml(item.name)}</h2><p><code>${escapeHtml(item.id)}</code> · ${escapeHtml(item.kind)} · ${escapeHtml(item.lifecycle)}</p><p>来源：${escapeHtml(contractSourcePaths(item).join(", ") || "人工登记")}</p><p>验证引用：${escapeHtml((item.verificationRefs || []).join(", ") || "未登记")}</p></section>`).join("\n");
  const unknown = (scan?.coverage?.unknown || []).map((item) => `<li>${escapeHtml(item.contractId)}：${escapeHtml((item.fields || []).join(", "))}</li>`).join("");
  const manual = (scan?.coverage?.manualRequired || []).map((item) => `<li>${escapeHtml(item.sourcePath)}：${escapeHtml(item.reason)}</li>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>项目契约总图</title><style>body{max-width:980px;margin:32px auto;padding:0 16px;background:#091019;color:#e7eef7;font:15px/1.6 system-ui}section{border:1px solid #294057;background:#111c29;padding:16px;margin:12px 0;border-radius:8px}code{color:#ffd978}.warn{border-left:4px solid #f6c85f}</style></head><body><h1>接口与数据库契约总图</h1><p>正式契约 ${registry.contracts.length} 项；本页由机器台账生成，不可手改。</p>${cards || "<section><p>尚无已批准契约。</p></section>"}<section class="warn"><h2>未知区域</h2><ul>${unknown || "<li>无</li>"}</ul><h2>需要人工申报</h2><ul>${manual || "<li>无</li>"}</ul></section></body></html>\n`;
}

/**
 * HTML 实体转义，防止契约名称注入 markup。
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
