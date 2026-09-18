#!/usr/bin/env node
// =============================================================================
// 文件名称：generate-module-graph.mjs
// 所属模块：tooling/arch-module-graph
// 作用说明：
//   从源码 import/require/from 解析依赖，生成 architecture-overview.html 内
//   <script id="generated-graph"> JSON 块。不改 D 字典人话（plain/io/r），
//   已有人话边只补缺口。
//
// 【运行原理速读】
//   · 何时跑？check:arch 或人工 node generate-module-graph.mjs [根] [--depth=entry|all]。
//   · 做了什么？读 module-file-map.json → 展开 include → 解析 JS import →
//     提取导出签名 → 写入/替换 generated-graph 脚本块。
//   · 和其他部分的关系？
//     CONFIG 与 validate-module-file-map.mjs 对齐（MAP_PATH / OVERVIEW_PATH 可环境变量覆盖）；
//     反向同步门禁在 validate 侧校验生成结果是否覆盖模块文件。
//   · 缺了它会怎样？架构总图缺少自动推导的跨文件边，需全手维护 D files。
// =============================================================================

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";

// --- CLI 与 CONFIG ---
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.filter((a) => a.startsWith("--")));
const depthFlag = [...flags].find((f) => f.startsWith("--depth="));
// §3.2：图生成深度；--depth= 优先，其次 GRAPH_DEPTH 环境变量，默认 "entry"（与 validate 门禁一致）。
const GRAPH_DEPTH = (depthFlag && depthFlag.slice("--depth=".length)) || process.env.GRAPH_DEPTH || "entry";
const root = resolve(args[0] ?? ".");
// §3.2：module-file-map.json 相对路径；环境变量 MAP_PATH 可覆盖。
const MAP_PATH = process.env.MAP_PATH || "tooling/arch-module-graph/module-file-map.json";
// §3.2：产品总图 HTML 相对路径；环境变量 OVERVIEW_PATH 可覆盖。
const OVERVIEW_PATH = process.env.OVERVIEW_PATH || "docs/product/architecture-overview.html";

// --- 文件分类正则 ---
// §3.2：以下扩展名/路径正则用于跳过测试、入口聚合与类型声明文件，不参与反向同步。
const TEST_FILE = /(?:\.test\.[^.]+$|_test\.[^.]+$|(?:^|\/)test_[^/]+$)/;
/** 入口聚合文件（index/mod/__init__）不参与反向同步图节点。 */
const ENTRY_BASENAMES = /(^|\/)(index\.[^/]+|mod\.rs|__init__\.py)$/;
/** 类型声明侧车文件（*.types.*）跳过实现图。 */
const TYPES_FILE = /\.types\.[^.]+$/;
/** JS/TS 系扩展名集合，用于解析 import 图。 */
const JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
/** Python 扩展名集合。 */
const PY_EXT = new Set([".py"]);
/** Rust 扩展名集合。 */
const RS_EXT = new Set([".rs"]);

// --- 路径与 include 匹配 ---
const toPosix = (path) => relative(root, path).split(sep).join("/");
const walk = (directory) => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
};

const globToRe = (pattern) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
};
const matchInclude = (posix, prefix) => {
  if (prefix.includes("*")) return globToRe(prefix).test(posix);
  if (prefix.endsWith("/")) return posix.startsWith(prefix);
  return posix === prefix;
};

const map = JSON.parse(readFileSync(resolve(root, MAP_PATH), "utf8"));
const modules = map.modules ?? {};
const includeHits = (posix) => {
  const hits = [];
  for (const [key, m] of Object.entries(modules)) {
    for (const prefix of m.include ?? []) {
      if (matchInclude(posix, prefix)) hits.push({ key, prefix, len: prefix.length });
    }
  }
  return hits;
};
const ownerOf = (posix) => {
  const hits = includeHits(posix);
  if (hits.length === 0) return null;
  const max = Math.max(...hits.map((h) => h.len));
  const keys = [...new Set(hits.filter((h) => h.len === max).map((h) => h.key))];
  return keys[0] ?? null;
};

const expandInclude = (inc) => {
  if (inc.includes("*")) {
    const zoneGuess = inc.split("/")[0] ? resolve(root, inc.split("/")[0]) : root;
    const start = existsSync(resolve(root, dirname(inc))) ? resolve(root, dirname(inc)) : zoneGuess;
    return walk(start).map(toPosix).filter((posix) => matchInclude(posix, inc));
  }
  const abs = resolve(root, inc);
  if (!existsSync(abs)) return [];
  return (statSync(abs).isFile() ? [abs] : walk(abs)).map(toPosix);
};

const reverseExcluded = (posix) =>
  TEST_FILE.test(posix) || ENTRY_BASENAMES.test(posix) || TYPES_FILE.test(posix);

// --- JS 模块解析 ---
const tryFile = (posix) => {
  if (existsSync(resolve(root, posix)) && statSync(resolve(root, posix)).isFile()) return posix;
  return null;
};
const normalizePosix = (p) => {
  const parts = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
};

const resolveJs = (fromPosix, spec) => {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const joined = spec.startsWith("/")
    ? spec.slice(1)
    : `${dirname(fromPosix)}/${spec}`;
  const norm = normalizePosix(joined);
  const candidates = [
    norm,
    norm + ".ts", norm + ".tsx", norm + ".js", norm + ".mjs",
    norm + "/index.ts", norm + "/index.tsx", norm + "/index.js",
  ];
  for (const c of candidates) {
    const hit = tryFile(c.replace(/\/+/g, "/"));
    if (hit) return hit;
  }
  return null;
};

const parseImports = (posix) => {
  const ext = extname(posix);
  const src = readFileSync(resolve(root, posix), "utf8");
  const specs = [];
  if (JS_EXT.has(ext)) {
    for (const re of [
      /\bfrom\s+['"]([^'"]+)['"]/g,
      /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bimport\s+['"]([^'"]+)['"]/g,
    ]) {
      for (const m of src.matchAll(re)) specs.push(m[1]);
    }
    return specs.map((s) => resolveJs(posix, s)).filter(Boolean);
  }
  return [];
};

const slug = (posix) => posix.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(-40) || "f";

// --- 导出签名提取（供 io 字段） ---
const extractIo = (posix) => {
  const src = readFileSync(resolve(root, posix), "utf8");
  const ext = extname(posix);
  const sigs = [];
  const push = (name, params, ret) => {
    if (!name || name === "main" || name.startsWith("_")) return;
    const p = (params || "").replace(/\s+/g, " ").trim().slice(0, 20);
    const r = (ret || "导出").replace(/\s+/g, " ").trim().slice(0, 16);
    sigs.push(`${name}(${p}) → ${r}`);
  };
  if (PY_EXT.has(ext)) {
    for (const m of src.matchAll(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/gm)) push(m[1], m[2], m[3]);
  } else if (RS_EXT.has(ext)) {
    for (const m of src.matchAll(/\bpub\s+(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^{]+))?/g)) {
      push(m[1], m[2], m[3]);
    }
  } else if (JS_EXT.has(ext)) {
    for (const m of src.matchAll(/\bexport\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*([^{]+))?/g)) {
      push(m[1], m[2], m[3]);
    }
  }
  const uniq = [...new Set(sigs)].slice(0, 2);
  return uniq.length ? uniq.join("；") : "待读代码填写";
};

// --- 图生成与 HTML 回写 ---
const overviewPath = resolve(root, OVERVIEW_PATH);
const overview = readFileSync(overviewPath, "utf8");
const dStarts = [...overview.matchAll(/^\s{2}"([a-z0-9-]+)":\s*\{\s*name:/gm)];
const existing = new Map();
for (let i = 0; i < dStarts.length; i++) {
  const key = dStarts[i][1];
  const block = overview.slice(dStarts[i].index, i + 1 < dStarts.length ? dStarts[i + 1].index : overview.length);
  const files = [...block.matchAll(/\{\s*id:\s*"[^"]+",\s*p:\s*"([^"]+)"/g)].map((x) => x[1]).filter((p) => !p.endsWith("/"));
  existing.set(key, files);
}

const generated = { modules: {} };
for (const [key, m] of Object.entries(modules)) {
  const owned = [];
  for (const inc of m.include ?? []) owned.push(...expandInclude(inc));
  const pending = [...new Set(owned)].filter((posix) => !reverseExcluded(posix) && existsSync(resolve(root, posix)));
  let targets = existing.get(key) || [];
  if (GRAPH_DEPTH === "all") targets = pending;
  else if (targets.length === 0 && pending.length) {
    targets = [pending[0]];
  }
  targets = targets.filter((p) => existsSync(resolve(root, p)));
  const files = [];
  for (const posix of targets) {
    const imports = [...new Set(parseImports(posix))];
    const to = [];
    const extTo = [];
    for (const dest of imports) {
      if (dest === posix) continue;
      const destOwner = ownerOf(dest);
      if (destOwner === key) to.push({ t: slug(dest), io: dest.split("/").pop(), p: dest });
      else if (destOwner) extTo.push({ t: dest.split("/").pop(), io: dest.split("/").pop(), p: dest, m: destOwner });
    }
    const rec = { id: slug(posix), p: posix, r: posix.split("/").pop(), io: extractIo(posix) };
    if (to.length) rec.to = to;
    if (extTo.length) rec.extTo = extTo;
    files.push(rec);
  }
  if (files.length) generated.modules[key] = { files };
}

const json = JSON.stringify(generated, null, 2);
const block = `<script type="application/json" id="generated-graph">\n${json}\n</script>`;
let next = overview;
if (/<script type="application\/json" id="generated-graph">/.test(next)) {
  next = next.replace(/<script type="application\/json" id="generated-graph">[\s\S]*?<\/script>/, block);
} else {
  next = next.replace(/<script>\s*\nconst D = \{/, `${block}\n\n<script>\nconst D = {`);
  if (next === overview) {
    next = next.replace("</body>", `${block}\n</body>`);
  }
}
writeFileSync(overviewPath, next);
const fileCount = Object.values(generated.modules).reduce((n, rec) => n + rec.files.length, 0);
console.log(`Generated graph: ${Object.keys(generated.modules).length} modules, ${fileCount} files (${GRAPH_DEPTH}) → ${OVERVIEW_PATH}`);
