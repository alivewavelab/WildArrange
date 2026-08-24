#!/usr/bin/env node

// 模块文件归属与命名门禁（architecture-map skill）。
// 复制到新项目后只改顶部 CONFIG。命名正则、测试豁免、反向同步范围都从 CONFIG 派生。
//
// 强制项：
// 1. 监视区内每个文件必须命中唯一一个模块 include（最长前缀优先），否则判孤儿；同等长度命中多个判冲突。
// 2. 映射表登记的路径必须真实存在；目录前缀命中 0 个受监视文件判失效（allowEmpty 除外）。
// 3. 同模块 include 不得冗余嵌套。跨模块嵌套允许，按最长前缀判主属。
// 4. 命名风格由 zone.style 决定；禁止桶文件；Rust 禁止 <dir>.rs 与 <dir>/ 并存；
//    测试文件基名必须能对上被测文件。
// 5. module-registry ↔ 映射表 designId ↔ D 字典 key 三方一致。
// 6. D 字典 files 的 p 路径必须存在，且归属（主属或镜像）覆盖其所在模块；
//    跨模块引用（extTo/extFrom 带 p、extLinks 的 a/b）只查存在性。
// 7. 反向同步：GRAPH_DEPTH=all 时 include 的实现文件必须进图（D files 或 generated-graph）；
//    entry 时每模块至少画一个入口。豁免测试文件、index.*、mod.rs、__init__.py、*.types.*，及 D 目录节点。
// 8. 总图 `.flow.nK` / `.flow.shell` 的直接子元素数必须对得上，防止卡片掉进 92px 标签列。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const errors = [];
const expect = (condition, message) => { if (!condition) errors.push(message); };
const toPosix = (path) => relative(root, path).split(sep).join("/");

// ── 按项目调整（CONFIG）──────────────────────────────────────────
// 复制后必须填 WATCH_ZONES，空数组会失败（禁止沿用某个产品仓库的目录）。
// 例：{ dir: "src", exts: new Set([".ts", ".tsx"]), style: "kebab" }
// 例：{ dir: "frontend", exts: new Set([".py"]), style: "snake" }
const WATCH_ZONES = [
  { dir: "bin", exts: new Set([".mjs"]), style: "kebab" },
  { dir: "src/interface", exts: new Set([".mjs"]), style: "kebab" },
  { dir: "src/orchestration", exts: new Set([".mjs"]), style: "kebab" },
  { dir: "src/ai", exts: new Set([".mjs"]), style: "kebab" },
  { dir: "src/capabilities", exts: new Set([".mjs"]), style: "kebab" },
  { dir: "src/infra", exts: new Set([".mjs"]), style: "kebab" }
];
const GENERATED_PREFIXES = [];
const MAP_PATH = "tooling/arch-module-graph/module-file-map.json";
const OVERVIEW_PATH = "docs/product/architecture-overview.html";
const ALLOWED_BUCKET_FILES = [];
const GRAPH_DEPTH = "entry"; // "all" | "entry"
const DIR_EXEMPT = [
  /^\[.+\]$/,
  /^\(.+\)$/,
  /^\[\.\.\..+\]$/,
  /^\[\[\.\.\..+\]\]$/,
  /^_.+$/,
  /^__.*__$/,
  /^[a-z]{2}(-[A-Z]{2})?$/,
];

const TEST_FILE = /(?:\.test\.[^.]+$|_test\.[^.]+$|(?:^|\/)test_[^/]+$)/;
const ENTRY_BASENAMES = /(^|\/)(index\.[^/]+|mod\.rs|__init__\.py)$/;
const NAME_EXEMPT = /(?:^|\/)(__init__|__main__)\.py$|(?:^|\/)mod\.rs$/;
const TYPES_FILE = /\.types\.[^.]+$/;
const BANNED_BASENAME = /^(utils?|helpers?|common|misc|shared|constants)(\.[a-z0-9-]+)*\.[a-z0-9]+$/;
const FLOW_EXPECT = { n2: 3, n3: 5, n4: 7, n5: 9, n6: 11, n7: 13, n8: 15, shell: 3 };

const EXCLUDED = (posix) =>
  TEST_FILE.test(posix) || GENERATED_PREFIXES.some((p) => posix.startsWith(p));

const walk = (directory, depth = Infinity) => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return depth > 0 ? walk(path, depth - 1) : [];
    return [path];
  });
};

const normalizeStyle = (style) => {
  if (style === "rust" || style === "python" || style === "snake") return "snake";
  if (style === "strict" || style === "kebab-strict") return "kebab-strict";
  return "kebab";
};

const extAlt = (exts) => [...exts].map((e) => e.slice(1).replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("|");

const nameReFor = (zone) => {
  if (zone.nameRe) return zone.nameRe;
  const alt = extAlt(zone.exts);
  const style = normalizeStyle(zone.style);
  if (style === "snake") return new RegExp(`^[a-z][a-z0-9_]*\\.(${alt})$`);
  if (style === "kebab-strict") {
    return new RegExp(`^[a-z0-9]+(-[a-z0-9]+)*(\\.[a-z0-9]+(-[a-z0-9]+)*)*\\.(${alt})$`);
  }
  // kebab 默认放行 React/Next 惯用名：Button.tsx、useDarkMode.ts、jwt-auth.guard.ts
  return new RegExp(
    `^([A-Z][A-Za-z0-9]*|[a-z][A-Za-z0-9]*|[a-z0-9]+(-[a-z0-9]+)*)(\\.[A-Za-z0-9]+(-[A-Za-z0-9]+)*)*\\.(${alt})$`,
  );
};

const dirReFor = (zone) => {
  if (zone.dirRe) return zone.dirRe;
  const style = normalizeStyle(zone.style);
  if (style === "snake") return /^[a-z][a-z0-9_]*$/;
  if (style === "kebab-strict") return /^[a-z0-9]+(-[a-z0-9]+)*$/;
  return /^([A-Z][A-Za-z0-9]*|[a-z0-9]+(-[a-z0-9]+)*)$/;
};

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
  for (const match of html.matchAll(/<div\s+class="([^"]*\bflow\b[^"]*)"/g)) {
    const cls = match[1];
    if (/\bgrid4\b/.test(cls)) continue;
    const kind = ["shell", "n8", "n7", "n6", "n5", "n4", "n3", "n2"].find((k) => new RegExp(`\\b${k}\\b`).test(cls));
    if (!kind) continue;
    const got = countDirectDivChildren(html, match.index);
    const want = FLOW_EXPECT[kind];
    expect(got === want,
      `总图 .flow.${kind} 应有 ${want} 个直接子元素（卡与箭头交错），实际 ${got}\n` +
      `  → 子元素数量必须和 nK 对上；单张卡不要写 n2。漏写包裹时卡片会掉进左侧 92px 标签列`);
  }
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

const watched = [];
const allSourceFiles = [];
const zoneHits = [];
for (const zone of WATCH_ZONES) {
  const zoneAbs = resolve(root, zone.dir);
  if (!existsSync(zoneAbs)) {
    expect(zone.allowMissing,
      `监视区不存在：${zone.dir}\n  → 把 WATCH_ZONES.dir 改成这个项目的源码目录，或给该 zone 标 allowMissing`);
    zoneHits.push({ dir: zone.dir, count: 0, missing: true });
    continue;
  }
  let count = 0;
  for (const file of walk(zoneAbs, zone.maxDepth ?? Infinity)) {
    const posix = toPosix(file);
    if (!zone.exts.has(extname(file))) continue;
    allSourceFiles.push({ posix, style: normalizeStyle(zone.style), zone });
    if (!EXCLUDED(posix)) {
      watched.push({ posix, style: normalizeStyle(zone.style), zone });
      count += 1;
    }
  }
  zoneHits.push({ dir: zone.dir, count, missing: false });
  expect(count > 0 || zone.allowEmpty || zone.allowMissing,
    `监视区零命中：${zone.dir}\n  → 检查 dir / exts 是否写对本项目；占位目录请标 allowEmpty`);
}

expect(WATCH_ZONES.length > 0,
  `WATCH_ZONES 为空\n  → 复制后门禁必须改成这个项目的源码目录，例如 { dir: "src", exts: new Set([".ts"]), style: "kebab" }`);
if (WATCH_ZONES.length > 0 && watched.length === 0) {
  expect(WATCH_ZONES.every((z) => z.allowMissing || z.allowEmpty),
    `WATCH_ZONES 未扫到任何文件：${WATCH_ZONES.map((z) => z.dir).join("、")}\n  → 把 dir / exts 改成这个项目的源码，否则门禁是假绿`);
}

const mapPath = resolve(root, MAP_PATH);
expect(existsSync(mapPath), `missing module file map: ${MAP_PATH}`);
const map = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) : { modules: {}, unowned: [] };
const modules = map.modules ?? {};
const unownedEntries = map.unowned ?? [];
const isUnowned = (posix) => unownedEntries.some((entry) => matchInclude(posix, entry.path));

for (const entry of unownedEntries) {
  expect(typeof entry.reason === "string" && entry.reason.trim().length > 0,
    `unowned 登记必须带 reason：${entry.path}`);
}

const includeHits = (posix) => {
  const hits = [];
  for (const [key, m] of Object.entries(modules)) {
    for (const prefix of m.include ?? []) {
      if (matchInclude(posix, prefix)) hits.push({ key, prefix, len: prefix.length });
    }
  }
  return hits;
};

const ownersOf = (posix) => {
  const hits = includeHits(posix);
  if (hits.length === 0) return [];
  const max = Math.max(...hits.map((h) => h.len));
  return [...new Set(hits.filter((h) => h.len === max).map((h) => h.key))];
};

for (const { posix } of watched) {
  const owners = ownersOf(posix);
  if (owners.length === 0 && !isUnowned(posix)) {
    errors.push(
      `孤儿文件未归属任何模块：${posix}\n` +
      `  → 在 ${MAP_PATH} 为其所属模块登记前缀（支持目录、精确路径或 glob，如 src/lib/audio-*.ts），或加入 unowned 并写明理由`,
    );
  }
  if (owners.length > 1) {
    errors.push(
      `文件被多个模块同等长度前缀命中：${posix}（${owners.join("、")}）\n` +
      `  → 加长更具体的 include / glob，或把其余改用 mirror`,
    );
  }
}

for (const [key, m] of Object.entries(modules)) {
  for (const prefix of m.include ?? []) {
    if (prefix.includes("*")) {
      const hits = watched.filter(({ posix }) => matchInclude(posix, prefix));
      expect(hits.length > 0 || m.allowEmpty,
        `映射表 glob 未命中任何受监视文件：${key} → ${prefix}`);
      continue;
    }
    const abs = resolve(root, prefix);
    if (prefix.endsWith("/")) {
      expect(existsSync(abs) && statSync(abs).isDirectory(),
        `映射表登记的目录前缀不存在：${key} → ${prefix}\n  → 删除该条登记或修正路径`);
      if (!existsSync(abs)) continue;
      const hits = watched.filter(({ posix }) => posix.startsWith(prefix));
      expect(hits.length > 0 || m.allowEmpty,
        `映射表登记的目录前缀下没有任何受监视文件：${key} → ${prefix}\n  → 空前缀说明目录已挪走，删除该条；占位或非代码目录请显式标注 allowEmpty`);
    } else {
      expect(existsSync(abs) && statSync(abs).isFile(),
        `映射表登记的路径不存在：${key} → ${prefix}\n  → 删除该条登记或修正路径`);
    }
  }
  for (const mirror of m.mirror ?? []) {
    expect(existsSync(resolve(root, mirror)),
      `映射表登记的镜像路径不存在：${key} → ${mirror}`);
  }
}
for (const entry of unownedEntries) {
  const path = entry.path;
  if (path.includes("*")) continue;
  const abs = resolve(root, path);
  if (path.endsWith("/")) {
    expect(existsSync(abs) && statSync(abs).isDirectory(),
      `unowned 目录前缀不存在：${path}\n  → 删除该条或改成真实目录（末尾 /）`);
    if (existsSync(abs)) {
      const hits = watched.filter(({ posix }) => posix.startsWith(path));
      expect(hits.length > 0 || entry.allowEmpty,
        `unowned 目录前缀下没有受监视文件：${path}\n  → 空目录删掉；占位请标 allowEmpty`);
    }
    continue;
  }
  expect(existsSync(abs),
    `unowned 登记的路径不存在：${path}`);
}

const flatPrefixes = Object.entries(modules).flatMap(([key, m]) =>
  (m.include ?? []).filter((prefix) => !prefix.includes("*")).map((prefix) => ({ key, prefix })),
);
for (let i = 0; i < flatPrefixes.length; i++) {
  for (let j = i + 1; j < flatPrefixes.length; j++) {
    const a = flatPrefixes[i];
    const b = flatPrefixes[j];
    const nested = a.prefix.startsWith(b.prefix) ? [a, b] : b.prefix.startsWith(a.prefix) ? [b, a] : null;
    if (!nested) continue;
    const [inner, outer] = nested;
    if (inner.key === outer.key) {
      errors.push(
        `前缀在同模块内冗余嵌套：${inner.key} 同时登记 ${outer.prefix} 与 ${inner.prefix}\n  → 删除被外层覆盖的内层前缀`,
      );
    }
  }
}

const seenDirErrors = new Set();
for (const zone of WATCH_ZONES) {
  const zoneAbs = resolve(root, zone.dir);
  if (!existsSync(zoneAbs)) continue;
  const dirRule = dirReFor(zone);
  const nameRule = nameReFor(zone);
  const dirLabel = normalizeStyle(zone.style) === "snake" ? "snake_case" : "kebab-case / PascalCase";
  for (const entry of walk(zoneAbs, zone.maxDepth ?? Infinity)) {
    const posix = toPosix(entry);
    if (EXCLUDED(posix)) continue;
    if (!zone.exts.has(extname(entry))) continue;
    let cursor = dirname(entry);
    while (cursor.length > zoneAbs.length) {
      const name = cursor.split(sep).pop();
      const dirPosix = `${toPosix(cursor)}/`;
      if (!DIR_EXEMPT.some((re) => re.test(name)) && !dirRule.test(name) && !seenDirErrors.has(dirPosix)) {
        seenDirErrors.add(dirPosix);
        errors.push(`目录名必须 ${dirLabel}：${dirPosix}`);
      }
      cursor = dirname(cursor);
    }
    if (NAME_EXEMPT.test(posix)) continue;
    const base = entry.split(sep).pop();
    if (BANNED_BASENAME.test(base) && !ALLOWED_BUCKET_FILES.includes(posix)) {
      errors.push(
        `禁止无语义文件名：${posix}\n  → 用职责命名；第三方脚手架固定产物写入 CONFIG.ALLOWED_BUCKET_FILES`,
      );
      continue;
    }
    expect(nameRule.test(base),
      `文件名必须 ${dirLabel}：${posix}\n  → 改名后同步 ${OVERVIEW_PATH} 中的 p 字段`);
  }
}

for (const { posix, style } of allSourceFiles) {
  if (style !== "snake" || !posix.endsWith(".rs")) continue;
  const siblingDir = posix.slice(0, -".rs".length) + "/";
  expect(!existsSync(resolve(root, siblingDir)),
    `Rust 禁止 <dir>.rs 与 <dir>/ 并存：${posix}\n  → 合并为 ${siblingDir}mod.rs`);
}

for (const { posix, zone } of allSourceFiles) {
  const testMatch = posix.match(/^(.*\/)?([^/]+)\.test\.([^./]+)$/);
  if (!testMatch) continue;
  const dir = testMatch[1] ?? "";
  const base = testMatch[2];
  const candidates = [...zone.exts].flatMap((ext) => [
    `${dir}${base}${ext}`,
    `${dir}${base}.page${ext}`,
  ]);
  expect(candidates.some((candidate) => existsSync(resolve(root, candidate))),
    `测试文件基名与被测文件不匹配：${posix}\n  → 找到同目录 ${base}.* 之一`);
}

const overviewPath = resolve(root, OVERVIEW_PATH);
let overview = "";
let dBlocks = [];
let dKeys = new Set();
if (!existsSync(overviewPath)) {
  errors.push(`missing architecture overview: ${OVERVIEW_PATH}\n  → 从 skill 的 template.html 复制到此路径并填 D 字典`);
} else {
  overview = readFileSync(overviewPath, "utf8");
  lintFlowGrids(overview);
  const registryMatch = overview.match(/<script type="application\/json" id="module-registry">([\s\S]*?)<\/script>/);
  expect(registryMatch, `${OVERVIEW_PATH} missing module-registry script block`);
  const registry = registryMatch ? JSON.parse(registryMatch[1]) : [];

  const dModuleStarts = [...overview.matchAll(/^\s{2}"([a-z0-9-]+)":\s*\{\s*name:/gm)];
  dBlocks = dModuleStarts.map((match, index) => ({
    key: match[1],
    start: match.index,
    end: index + 1 < dModuleStarts.length ? dModuleStarts[index + 1].index : overview.length,
  }));
  dKeys = new Set(dBlocks.map((block) => block.key));
  if (Object.keys(modules).length > 0 && dKeys.size === 0) {
    errors.push(
      `架构页未能解析出任何 D 字典模块（需要两空格缩进且 name 为第一个字段，例如  "foo": { name: "..." }）`,
    );
  }

  const claimedDesignIds = new Set(
    Object.values(modules).map((m) => m.designId).filter(Boolean),
  );
  for (const id of registry) {
    expect(claimedDesignIds.has(id),
      `module-registry 模块无任何映射登记：${id}\n  → 在 ${MAP_PATH} 让某个模块声明 designId: "${id}"`);
  }
  for (const [key, m] of Object.entries(modules)) {
    if (m.designId == null) continue;
    expect(registry.includes(m.designId),
      `映射表模块的 designId 未在 module-registry 注册：${key} → "${m.designId}"`);
  }
  for (const key of dKeys) {
    expect(key in modules,
      `架构页 D 字典模块未登记映射：${key}\n  → 未开始的模块也要登记，include 写空数组`);
  }
  for (const key of Object.keys(modules)) {
    expect(dKeys.has(key),
      `映射表模块不在架构页 D 字典中：${key}\n  → 先在 ${OVERVIEW_PATH} 注册架构节点，或并入已有模块`);
  }

  const mirrorOf = (posix) =>
    Object.entries(modules)
      .filter(([, m]) => (m.mirror ?? []).some((p) => matchInclude(posix, p)))
      .map(([key]) => key);

  for (const { key: moduleKey, start, end } of dBlocks) {
    const block = overview.slice(start, end);
    for (const pMatch of block.matchAll(/\{\s*id:\s*"[^"]+",\s*p:\s*"([^"]+)"/g)) {
      const p = pMatch[1];
      expect(existsSync(resolve(root, p)),
        `D 字典中的实现文件路径不存在：${moduleKey} → ${p}`);
      if (p.endsWith("/")) continue;
      const owners = ownersOf(p);
      const mirrors = mirrorOf(p);
      expect(owners.includes(moduleKey) || mirrors.includes(moduleKey),
        `D 字典中的路径与映射表归属不符：${p} 在 D 中属 ${moduleKey}，映射表主属为 ${owners.join("、") || "（无）"}${mirrors.length ? `，镜像为 ${mirrors.join("、")}` : ""}`);
    }
    for (const xMatch of block.matchAll(/\{\s*t:\s*"[^"]+",\s*io:[^}]*?\bp:\s*"([^"]+)"/g)) {
      const p = xMatch[1];
      expect(existsSync(resolve(root, p)),
        `D 字典跨模块引用路径不存在：${moduleKey} → ${p}`);
    }
    for (const lMatch of block.matchAll(/\bextLinks:\s*\[([\s\S]*?)\]/g)) {
      for (const pMatch of lMatch[1].matchAll(/\b[ab]:\s*"([^"]+)"/g)) {
        const p = pMatch[1];
        expect(existsSync(resolve(root, p)),
          `D 字典 extLinks 路径不存在：${moduleKey} → ${p}`);
      }
    }
  }

  const scriptExts = new Set(WATCH_ZONES.flatMap((z) => [...z.exts]));
  const reverseExcluded = (posix) =>
    TEST_FILE.test(posix) || ENTRY_BASENAMES.test(posix) || TYPES_FILE.test(posix) ||
    GENERATED_PREFIXES.some((p) => posix.startsWith(p));

  let required = 0;
  let covered = 0;
  for (const { key: moduleKey, start, end } of dBlocks) {
    const m = modules[moduleKey];
    if (!m) continue;
    const block = overview.slice(start, end);
    const dFiles = new Set([...block.matchAll(/\{\s*id:\s*"[^"]+",\s*p:\s*"([^"]+)"/g)].map((x) => x[1]));
    const genMatch = overview.match(/<script type="application\/json" id="generated-graph">([\s\S]*?)<\/script>/);
    if (genMatch) {
      try {
        const gen = JSON.parse(genMatch[1] || "{}");
        for (const f of gen.modules?.[moduleKey]?.files || []) if (f.p) dFiles.add(f.p);
      } catch { /* 生成块坏了由人工修，不在这里崩 */ }
    }
    const dDirs = [...dFiles].filter((p) => p.endsWith("/"));
    const moduleFiles = [];
    for (const inc of m.include ?? []) {
      if (inc.includes("*")) {
        for (const { posix } of watched) {
          if (matchInclude(posix, inc) && scriptExts.has(extname(posix))) moduleFiles.push(posix);
        }
        continue;
      }
      const abs = resolve(root, inc);
      if (!existsSync(abs)) continue;
      const files = (statSync(abs).isFile() ? [abs] : walk(abs))
        .map((f) => toPosix(f))
        .filter((posix) => scriptExts.has(extname(posix)));
      moduleFiles.push(...files);
    }
    const pending = moduleFiles.filter((posix) => !reverseExcluded(posix));
    if (GRAPH_DEPTH === "entry") {
      if (pending.length === 0) continue;
      required += 1;
      const hasAny = pending.some((posix) => dFiles.has(posix) || dDirs.some((d) => posix.startsWith(d)));
      if (hasAny) covered += 1;
      else {
        expect(false,
          `模块未画任何入口脚本：${moduleKey}\n  → GRAPH_DEPTH=entry 时每个模块至少画一个真实脚本节点，或用 p 以 / 结尾的目录节点覆盖`);
      }
    } else {
      for (const posix of pending) {
        required += 1;
        if (dFiles.has(posix) || dDirs.some((d) => posix.startsWith(d))) {
          covered += 1;
          continue;
        }
        expect(false,
          `模块文件未进架构图：${moduleKey} → ${posix}\n  → 在 D 字典 files 补该脚本节点（含职责与输入输出），或把 GRAPH_DEPTH 改为 "entry"，或用目录节点覆盖`);
      }
    }
  }

  if (errors.length === 0) {
    const zoneSummary = zoneHits.map((z) => `${z.dir}:${z.count}`).join(", ");
    console.log(
      `Validated module file map: ${Object.keys(modules).length} modules, ${watched.length} watched files, ${unownedEntries.length} unowned, 0 orphans. zones[${zoneSummary}] graph ${covered}/${required} (${GRAPH_DEPTH}).`,
    );
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
