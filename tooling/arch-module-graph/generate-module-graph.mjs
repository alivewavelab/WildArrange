#!/usr/bin/env node

// 从真实 import / use / from 生成 <script id="generated-graph">。
// 不改 D 字典人话（plain / io / r）。已有人话边只补缺口。
// 用法：node generate-module-graph.mjs [仓库根] [--depth=entry|all]
// CONFIG 与 validate-module-file-map.mjs 对齐：MAP_PATH / OVERVIEW_PATH 可用环境变量覆盖。

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.filter((a) => a.startsWith("--")));
const depthFlag = [...flags].find((f) => f.startsWith("--depth="));
const GRAPH_DEPTH = (depthFlag && depthFlag.slice("--depth=".length)) || process.env.GRAPH_DEPTH || "entry";
const root = resolve(args[0] ?? ".");
const MAP_PATH = process.env.MAP_PATH || "tooling/arch-module-graph/module-file-map.json";
const OVERVIEW_PATH = process.env.OVERVIEW_PATH || "docs/product/architecture-overview.html";

const TEST_FILE = /(?:\.test\.[^.]+$|_test\.[^.]+$|(?:^|\/)test_[^/]+$)/;
const ENTRY_BASENAMES = /(^|\/)(index\.[^/]+|mod\.rs|__init__\.py)$/;
const TYPES_FILE = /\.types\.[^.]+$/;
const JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const PY_EXT = new Set([".py"]);
const RS_EXT = new Set([".rs"]);

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
    norm + "/mod.rs",
  ];
  for (const c of candidates) {
    const hit = tryFile(c.replace(/\/+/g, "/"));
    if (hit) return hit;
  }
  return null;
};

const resolvePyRel = (fromPosix, dots, rest) => {
  let dir = dirname(fromPosix);
  for (let i = 1; i < dots.length; i++) dir = dirname(dir);
  const parts = rest ? rest.split(".") : [];
  const stem = parts.length ? `${dir}/${parts.join("/")}` : dir;
  return tryFile(stem + ".py") || tryFile(stem + "/__init__.py");
};

const resolvePyAbs = (fromPosix, mod, names = []) => {
  if (!mod || mod === "__future__") return [];
  const rel = mod.replace(/\./g, "/");
  const bases = [];
  let dir = dirname(fromPosix);
  while (true) {
    bases.push(dir === "." ? "" : dir);
    if (!dir || dir === ".") break;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  bases.push("");
  const hits = [];
  for (const base of [...new Set(bases)]) {
    const stem = base ? `${base}/${rel}` : rel;
    const asMod = tryFile(`${stem}.py`) || tryFile(`${stem}/__init__.py`);
    if (asMod) hits.push(asMod);
    for (const name of names) {
      if (!/^[A-Za-z_]\w*$/.test(name) || name === "*") continue;
      const sub = tryFile(`${stem}/${name}.py`) || tryFile(`${stem}/${name}/__init__.py`);
      if (sub) hits.push(sub);
    }
  }
  return hits;
};

const importedNames = (clause) =>
  clause
    .replace(/[()]/g, " ")
    .split(",")
    .map((part) => part.trim().split(/\s+as\s+/i)[0].trim())
    .filter(Boolean);

const rustRoots = () => {
  const roots = new Set();
  for (const m of Object.values(modules)) {
    for (const inc of m.include ?? []) {
      if (inc.includes("src-tauri/src") || inc.endsWith(".rs") || inc.includes("/src/")) {
        if (inc.includes("src-tauri/src")) roots.add(inc.split("src-tauri/src")[0] + "src-tauri/src");
      }
    }
  }
  if (existsSync(resolve(root, "client/src-tauri/src"))) roots.add("client/src-tauri/src");
  if (existsSync(resolve(root, "src"))) roots.add("src");
  return [...roots];
};

const resolveRust = (fromPosix, cratePath) => {
  const segs = cratePath.split("::");
  for (const rroot of rustRoots()) {
    const stem = `${rroot}/${segs.join("/")}`;
    const hit = tryFile(stem + ".rs") || tryFile(stem + "/mod.rs");
    if (hit) return hit;
  }
  const local = `${dirname(fromPosix)}/${segs[segs.length - 1]}`;
  return tryFile(local + ".rs") || tryFile(local + "/mod.rs");
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
  if (PY_EXT.has(ext)) {
    const out = [];
    for (const m of src.matchAll(/^from\s+(\.+)([\w.]*)\s+import/gm)) {
      const hit = resolvePyRel(posix, m[1], m[2]);
      if (hit) out.push(hit);
    }
    for (const m of src.matchAll(/^from\s+([\w.]+)\s+import\s+(.+)$/gm)) {
      if (m[1].startsWith(".")) continue;
      out.push(...resolvePyAbs(posix, m[1], importedNames(m[2])));
    }
    for (const m of src.matchAll(/^import\s+([\w.]+(?:\s*,\s*[\w.]+)*)$/gm)) {
      for (const spec of m[1].split(",")) {
        const name = spec.trim().split(/\s+as\s+/i)[0].trim();
        out.push(...resolvePyAbs(posix, name));
      }
    }
    return out;
  }
  if (RS_EXT.has(ext)) {
    const out = [];
    for (const m of src.matchAll(/\buse\s+crate::([a-z0-9_]+(?:::[a-z0-9_]+)*)/g)) {
      const hit = resolveRust(posix, m[1]);
      if (hit) out.push(hit);
    }
    for (const m of src.matchAll(/\bmod\s+([a-z0-9_]+);/g)) {
      const hit = tryFile(`${dirname(posix)}/${m[1]}.rs`) || tryFile(`${dirname(posix)}/${m[1]}/mod.rs`);
      if (hit) out.push(hit);
    }
    return out;
  }
  return [];
};

const slug = (posix) => posix.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(-40) || "f";

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
