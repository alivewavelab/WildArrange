#!/usr/bin/env node

// =============================================================================
// 文件名称：validate-flow-grid.mjs
// 所属模块：tooling/arch-module-graph
// 作用说明：
//   校验产品总图 HTML 中 flow-grid 卡片布局是否与预期子元素数一致。
//   从 validate-module-file-map.mjs 拆出：归属校验管文件与模块，本脚本只管总图排版。
//   不负责模块文件归属、命名或 D 字典同步。
//
// 【运行原理速读】
//   · 何时跑？npm run check:arch 或 CI 架构门禁阶段。
//   · 做了什么？读取 architecture-overview.html，统计各 `.flow.nK` / `.flow.shell`
//     的直接子 div 数量，与 FLOW_EXPECT 配置比对。
//   · 缺了它会怎样？卡片可能掉进 92px 标签列，总图布局不可读。
// =============================================================================

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const errors = [];
const expect = (condition, message) => { if (!condition) errors.push(message); };

// ── 按项目调整（CONFIG）──────────────────────────────────────────
const OVERVIEW_PATH = "docs/product/architecture-overview.html";
const FLOW_EXPECT = { n2: 3, n3: 5, n4: 7, n5: 9, n6: 11, n7: 13, n8: 15, shell: 3 };

const countDirectDivChildren = (html, start) => {
  const gt = html.indexOf(">", start);
  if (gt < 0) return 0;
  let i = gt + 1, depth = 1, n = 0;
  while (i < html.length && depth > 0) {
    const open = html.indexOf("<div", i);
    const close = html.indexOf("</div>", i);
    if (close < 0) break;
    if (open >= 0 && open < close) {
      if (depth === 1) n += 1;
      depth += 1;
      i = open + 4;
    } else {
      depth -= 1;
      i = close + 6;
    }
  }
  return n;
};

const lintFlowGrids = (html) => {
  let checked = 0;
  for (const match of html.matchAll(/<div\s+class="([^"]*\bflow\b[^"]*)"/g)) {
    const cls = match[1];
    if (/\bgrid4\b/.test(cls)) continue;
    const kind = ["shell", "n8", "n7", "n6", "n5", "n4", "n3", "n2"].find((k) => new RegExp(`\\b${k}\\b`).test(cls));
    if (!kind) continue;
    checked += 1;
    const got = countDirectDivChildren(html, match.index);
    const want = FLOW_EXPECT[kind];
    expect(got === want,
      `总图 .flow.${kind} 应有 ${want} 个直接子元素（卡与箭头交错），实际 ${got}\n` +
      `  → 子元素数量必须和 nK 对上；单张卡不要写 n2。漏写包裹时卡片会掉进左侧 92px 标签列`);
  }
  return checked;
};

const overviewPath = resolve(root, OVERVIEW_PATH);
if (!existsSync(overviewPath)) {
  errors.push(`missing architecture overview: ${OVERVIEW_PATH}\n  → 从 skill 的 template.html 复制到此路径并填 D 字典`);
} else {
  const checked = lintFlowGrids(readFileSync(overviewPath, "utf8"));
  if (errors.length === 0) {
    console.log(`Validated flow grids: ${checked} grids checked, 0 layout mismatches.`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
