/**
 * Import scanner + impact graph.
 *
 * The lexical scanner (maskSource / extractImportSpecifiers) was hardened
 * adversarially in test/dependency-boundary.test.mjs; it lives here so the
 * boundary test and `wildarrange impact` share one implementation. The adversarial
 * tests in that file are the non-weakenable floor for this module — if the
 * scanner changes, those tests must keep passing.
 *
 * Lexical source masking. Round-4 kept string contents intact, which meant
 * an import statement WRITTEN INSIDE a string or template (documentation
 * text, generated snippets) was still regex-matched as a real edge — and,
 * worse, the code/string ambiguity could be steered either way by legal
 * source (cross-review P1, round 5, 2026-07-21). The masked view removes the
 * ambiguity completely:
 *   - line/block comments -> blanks (newlines kept for line numbers);
 *   - string/template/regex literal CONTENT -> NUL bytes, delimiters kept
 *     (template ${} interpolations stay code);
 *   - everything else copied verbatim, so output length === input length.
 * Import syntax is then matched on the masked view (only real code can
 * match), and the actual specifier text is sliced from the ORIGINAL source
 * at the same offsets and unescaped — so `"./ai/x.mjs"` is seen as
 * `../ai/x.mjs`, not as a bare specifier.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { normalizeRelativePath } from "./path-match.mjs";

export const ZONES = ["interface", "orchestration", "ai", "capabilities", "infra"];
export const UNKNOWN_ZONE = "unknown";

const MASK = "\u0000";

export function maskSource(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  let lastSignificant = "";
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (i < n) { out += "  "; i += 2; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      out += ch;
      i += 1;
      while (i < n && source[i] !== ch && source[i] !== "\n") {
        if (source[i] === "\\") { out += MASK + MASK; i += 2; continue; }
        out += MASK;
        i += 1;
      }
      if (i < n && source[i] === ch) { out += ch; i += 1; }
      lastSignificant = ch;
      continue;
    }
    if (ch === "`") {
      out += ch;
      i += 1;
      let braceDepth = 0;
      while (i < n) {
        const c = source[i];
        if (c === "\\") { out += MASK + MASK; i += 2; continue; }
        if (braceDepth === 0 && c === "`") { out += c; i += 1; break; }
        if (braceDepth === 0 && c === "$" && source[i + 1] === "{") { braceDepth = 1; out += "${"; i += 2; continue; }
        if (braceDepth > 0 && c === "{") braceDepth += 1;
        if (braceDepth > 0 && c === "}") braceDepth -= 1;
        // Interpolation bodies are code; top-level template text is content.
        out += braceDepth > 0 ? c : (c === "\n" ? "\n" : MASK);
        i += 1;
      }
      lastSignificant = "`";
      continue;
    }
    if (ch === "/") {
      // Regex literal vs division, by what precedes the slash: after a value
      // (identifier, number, closing bracket, string) it is division; after
      // an operator/opening bracket/keyword it starts a regex literal whose
      // body must be masked so its content can't fake comment markers or
      // import syntax.
      const afterKeyword = /(?:^|[^\w$])(?:return|typeof|case|in|of|new|delete|void|do|else|yield|await)\s*$/.test(out);
      const regexCanStart = lastSignificant === "" || "([{,;=:!&|?+-*%<>~^".includes(lastSignificant) || afterKeyword;
      if (regexCanStart) {
        out += ch;
        i += 1;
        let inClass = false;
        while (i < n) {
          const c = source[i];
          if (c === "\\") { out += MASK + MASK; i += 2; continue; }
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          const terminal = (c === "/" && !inClass) || c === "\n";
          out += terminal ? c : MASK;
          i += 1;
          if (terminal) break;
        }
        lastSignificant = ")";
        continue;
      }
    }
    out += ch;
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }
  return out;
}

/** Decodes a quoted JS string literal (with quotes) into its runtime value. */
export function decodeStringLiteral(raw) {
  const body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") { out += ch; continue; }
    const next = body[i + 1];
    if (next === "u") {
      if (body[i + 2] === "{") {
        const end = body.indexOf("}", i + 3);
        out += String.fromCodePoint(Number.parseInt(body.slice(i + 3, end), 16));
        i = end;
      } else {
        out += String.fromCharCode(Number.parseInt(body.slice(i + 2, i + 6), 16));
        i += 5;
      }
    } else if (next === "x") {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 2, i + 4), 16));
      i += 3;
    } else {
      const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
      out += simple[next] ?? next;
      i += 1;
    }
  }
  return out;
}

const STATIC_IMPORT_REGEX = /(?<![\w.$])(?:import|export)\s+(?:[^'"`]*?from\s+)?((["'])\u0000*\2)/dg;
const DYNAMIC_IMPORT_REGEX = /(?<![\w.$])import\s*\(\s*((["'])\u0000*\2)/dg;

export function extractImportSpecifiers(source) {
  const masked = maskSource(source);
  const specifiers = [];
  for (const regex of [STATIC_IMPORT_REGEX, DYNAMIC_IMPORT_REGEX]) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(masked)) !== null) {
      const [start, end] = match.indices[1];
      specifiers.push(decodeStringLiteral(source.slice(start, end)));
    }
  }
  return specifiers;
}

export function classifyZone(srcDir, absolutePath) {
  const relativeToSrc = path.relative(srcDir, absolutePath);
  const [firstSegment] = relativeToSrc.split(path.sep);
  return ZONES.includes(firstSegment) ? firstSegment : UNKNOWN_ZONE;
}

function assertKnownZone(srcDir, absolutePath, role) {
  const zone = classifyZone(srcDir, absolutePath);
  if (zone !== UNKNOWN_ZONE) return zone;
  const relativePath = normalizeRelativePath(path.relative(srcDir, absolutePath)) || ".";
  const error = new Error(
    `${role} is outside the five source zones: src/${relativePath} (expected src/<${ZONES.join("|")}>/...)`,
  );
  error.code = "UNKNOWN_SOURCE_ZONE";
  throw error;
}

export async function listMjsFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMjsFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Zone-boundary view: scans src/ only, edges only to targets inside src/,
 * from/to relative to src/. This is exactly the graph the boundary test
 * enforces on; keep the semantics stable.
 */
export async function buildDependencyEdges(rootDir) {
  const srcDir = path.join(rootDir, "src");
  const files = await listMjsFiles(srcDir);
  const edges = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    // Reject unknown owners before reading imports: a standalone runtime file
    // with no dependency edges is still an architecture-boundary violation.
    const sourceZone = assertKnownZone(srcDir, filePath, "runtime module");
    for (const specifier of extractImportSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue; // skip node builtins / bare package specifiers
      const resolvedTarget = path.resolve(path.dirname(filePath), specifier);
      if (resolvedTarget !== srcDir && !resolvedTarget.startsWith(`${srcDir}${path.sep}`)) continue;
      const targetZone = assertKnownZone(srcDir, resolvedTarget, "dependency target");
      edges.push({
        from: normalizeRelativePath(path.relative(srcDir, filePath)),
        to: normalizeRelativePath(path.relative(srcDir, resolvedTarget)),
        sourceZone,
        targetZone,
      });
    }
  }
  return edges;
}

/**
 * Repo-wide import graph for impact analysis: scans the given top-level
 * dirs (default src/bin/test), edges from/to relative to rootDir, targets
 * kept only when they resolve inside one of the scanned dirs.
 */
export async function buildRepoImportGraph(rootDir, { dirs = ["src", "bin", "test"] } = {}) {
  const roots = dirs.map((dir) => path.join(rootDir, dir));
  const files = (await Promise.all(roots.map((dir) => listMjsFiles(dir)))).flat();
  const edges = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    for (const specifier of extractImportSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const resolvedTarget = path.resolve(path.dirname(filePath), specifier);
      if (!roots.some((dir) => resolvedTarget === dir || resolvedTarget.startsWith(dir + path.sep))) continue;
      edges.push({
        from: normalizeRelativePath(path.relative(rootDir, filePath)),
        to: normalizeRelativePath(path.relative(rootDir, resolvedTarget)),
      });
    }
  }
  return { files: files.map((file) => normalizeRelativePath(path.relative(rootDir, file))), edges };
}

/**
 * Reverse-transitive impact: who imports the changed files, directly or
 * transitively, plus the tests that should run to prove the change is safe.
 * test/dependency-boundary.test.mjs is always included — any import-graph
 * change can flip a boundary.
 */
export async function computeImpact(rootDir, changedPaths) {
  const { files, edges } = await buildRepoImportGraph(rootDir);
  const known = new Set(files);
  const normalizedChanged = [...new Set(changedPaths.map((p) => normalizeRelativePath(p)))];
  const changed = normalizedChanged
    .filter((p) => known.has(p));

  const importers = new Map();
  for (const edge of edges) {
    if (!importers.has(edge.to)) importers.set(edge.to, []);
    importers.get(edge.to).push(edge.from);
  }

  const affected = new Set();
  const queue = [...changed];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const importer of importers.get(current) || []) {
      if (affected.has(importer) || changed.includes(importer)) continue;
      affected.add(importer);
      queue.push(importer);
    }
  }

  const testsToRun = new Set(["test/dependency-boundary.test.mjs"]);
  for (const file of [...changed, ...affected]) {
    if (/^test\/.*\.test\.mjs$/.test(file)) testsToRun.add(file);
    // 命名对位启发式：src/<zone>/<name>.mjs → test/<name>.test.mjs（存在才取）。
    const match = file.match(/^(?:src|bin)\/.*\/([^/]+)\.mjs$/) || file.match(/^bin\/([^/]+)\.mjs$/);
    if (match) {
      const candidate = `test/${match[1]}.test.mjs`;
      if (known.has(candidate)) testsToRun.add(candidate);
    }
  }

  const affectedList = [...affected].sort();
  const testList = [...testsToRun].sort();
  return {
    kind: "impact_report",
    changed,
    unknownChanged: normalizedChanged.filter((p) => !known.has(p)),
    affected: affectedList,
    testsToRun: testList,
    summary: `影响 ${affectedList.length} 个文件，应跑 ${testList.length} 个测试`,
  };
}

/** 仓库内全部测试文件（test/*.test.mjs），相对路径排序。 */
export async function listRepoTests(rootDir) {
  const files = await listMjsFiles(path.join(rootDir, "test"));
  return files
    .map((file) => normalizeRelativePath(path.relative(rootDir, file)))
    .filter((file) => /^test\/.*\.test\.mjs$/.test(file))
    .sort();
}

/**
 * 分区测试选择：某区的应跑测试 = 引用了该区文件的测试（反向传递闭包）
 * + 命名对位测试 + 常驻的依赖边界测试。wildarrange test --zone 用它把
 * "我只改了 infra" 映射到最小证明集，低代码维护者不必背测试矩阵。
 */
export async function computeZoneTests(rootDir, zone) {
  if (!ZONES.includes(zone)) {
    throw new Error(`unknown zone: ${zone} (expected one of ${ZONES.join(", ")})`);
  }
  const { files, edges } = await buildRepoImportGraph(rootDir);
  const known = new Set(files);
  const zonePrefix = `src/${zone}/`;
  const zoneFiles = files.filter((file) => file.startsWith(zonePrefix));

  const importers = new Map();
  for (const edge of edges) {
    if (!importers.has(edge.to)) importers.set(edge.to, []);
    importers.get(edge.to).push(edge.from);
  }
  const closure = new Set(zoneFiles);
  const queue = [...zoneFiles];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const importer of importers.get(current) || []) {
      if (closure.has(importer)) continue;
      closure.add(importer);
      queue.push(importer);
    }
  }

  const testsToRun = new Set(["test/dependency-boundary.test.mjs"]);
  for (const file of closure) {
    if (/^test\/.*\.test\.mjs$/.test(file)) testsToRun.add(file);
    const match = file.match(/^src\/[^/]+\/([^/]+)\.mjs$/);
    if (match) {
      const candidate = `test/${match[1]}.test.mjs`;
      if (known.has(candidate)) testsToRun.add(candidate);
    }
  }

  const testList = [...testsToRun].sort();
  return {
    kind: "zone_test_report",
    zone,
    zoneFiles: zoneFiles.length,
    testsToRun: testList,
    summary: `${zone} 区应跑 ${testList.length} 个测试`,
  };
}
