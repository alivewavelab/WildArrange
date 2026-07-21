import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * Enforces strict one-way layering as source files migrate into the five
 * zone directories (see doc/plans .../wildarrange-five-zone-refactor).
 *
 * Zoned files (anything under src/<zone>/) must only import from zones
 * lower in the stack, per ALLOWED_DEPS. Files still sitting at the flat
 * src/helix-*.mjs root are "legacy/unclassified" during the migration:
 * they are exempt from the rule (so today's codebase does not fail this
 * test) but any NEW file created inside a zone directory is bound by the
 * rule immediately. As Phase 2-5 move files into zones, this test starts
 * enforcing the invariant on them automatically -- it is not a one-time
 * check, it runs on every `npm test`.
 */

const SRC_DIR = path.join(process.cwd(), "src");
const ZONES = ["interface", "orchestration", "ai", "capabilities", "infra"];

// Note: "legacy" (flat src/helix-*.mjs shims) is deliberately NOT an allowed
// target for any zoned file. A legacy shim re-exports a zoned file, so letting
// a zoned file import a shim would be a laundering channel that bypasses zone
// rules (e.g. capabilities -> helix-hooks.mjs -> ai/hooks.mjs). Legacy files
// themselves remain unconstrained as sources: they exist only for backward
// compatibility of external/old callers.
const ALLOWED_DEPS = {
  interface: ["orchestration", "infra"],
  orchestration: ["ai", "capabilities", "infra"],
  // ai includes host-facing hooks/context builders that read orchestration
  // state (current task, attention report) and call gates (via the gateway,
  // same seam orchestration uses) to decide what to inject/block. That makes
  // ai -> orchestration and ai -> capabilities legitimate one-way edges; the
  // reverse (orchestration/capabilities depending on ai) stays forbidden.
  ai: ["orchestration", "capabilities", "infra"],
  capabilities: ["infra"],
  infra: [],
};

async function listMjsFiles(dir) {
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
 * Lexical comment stripping. A plain regex cannot tell a real comment from
 * "/*" sitting inside a string literal, which let a crafted-but-legal file
 * hide an import between a string containing a block-comment opener and a
 * later closer (cross-review P1, round 4, 2026-07-21). This walks the source as a small
 * state machine: line/block comments are blanked out (newlines preserved so
 * reported line numbers stay right), while string literals, template
 * literals (including ${} nesting) and regex literals are copied through
 * untouched — import specifiers live in strings, so they must survive.
 */
function stripComments(source) {
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
        if (source[i] === "\\") { out += source[i] + (source[i + 1] ?? ""); i += 2; continue; }
        out += source[i];
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
        if (c === "\\") { out += c + (source[i + 1] ?? ""); i += 2; continue; }
        if (braceDepth === 0 && c === "`") { out += c; i += 1; break; }
        if (braceDepth === 0 && c === "$" && source[i + 1] === "{") { braceDepth = 1; out += "${"; i += 2; continue; }
        if (braceDepth > 0 && c === "{") braceDepth += 1;
        if (braceDepth > 0 && c === "}") braceDepth -= 1;
        out += c;
        i += 1;
      }
      lastSignificant = "`";
      continue;
    }
    if (ch === "/") {
      // Regex literal vs division, by what precedes the slash: after a value
      // (identifier, number, closing bracket, string) it is division; after
      // an operator/opening bracket/keyword it starts a regex literal whose
      // body must be skipped so its content can't fake a comment marker.
      const afterKeyword = /(?:^|[^\w$])(?:return|typeof|case|in|of|new|delete|void|do|else|yield|await)\s*$/.test(out);
      const regexCanStart = lastSignificant === "" || "([{,;=:!&|?+-*%<>~^".includes(lastSignificant) || afterKeyword;
      if (regexCanStart) {
        out += ch;
        i += 1;
        let inClass = false;
        while (i < n) {
          const c = source[i];
          if (c === "\\") { out += c + (source[i + 1] ?? ""); i += 2; continue; }
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          out += c;
          i += 1;
          if ((c === "/" && !inClass) || c === "\n") break;
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

function extractImportSpecifiers(source) {
  const code = stripComments(source);
  const specifiers = [];
  const importRegex = /(?:import|export)\s+(?:[^'"]*?from\s+)?["']([^"']+)["']/g;
  let match;
  while ((match = importRegex.exec(code)) !== null) {
    specifiers.push(match[1]);
  }
  const dynamicImportRegex = /import\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamicImportRegex.exec(code)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function classifyZone(absolutePath) {
  const relativeToSrc = path.relative(SRC_DIR, absolutePath);
  const [firstSegment] = relativeToSrc.split(path.sep);
  return ZONES.includes(firstSegment) ? firstSegment : "legacy";
}

async function buildDependencyEdges() {
  const files = await listMjsFiles(SRC_DIR);
  const edges = [];
  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    const sourceZone = classifyZone(filePath);
    for (const specifier of extractImportSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue; // skip node builtins / bare package specifiers
      const resolvedTarget = path.resolve(path.dirname(filePath), specifier);
      if (!resolvedTarget.startsWith(SRC_DIR)) continue; // skip references outside src/ (e.g. ../test)
      const targetZone = classifyZone(resolvedTarget);
      edges.push({
        from: path.relative(SRC_DIR, filePath),
        to: path.relative(SRC_DIR, resolvedTarget),
        sourceZone,
        targetZone,
      });
    }
  }
  return edges;
}

test("dependency boundary: zoned files only import allowed lower zones", async () => {
  const edges = await buildDependencyEdges();
  const violations = edges.filter((edge) => {
    if (edge.sourceZone === "legacy") return false; // legacy files are unconstrained during migration
    if (edge.sourceZone === edge.targetZone) return false; // same-zone imports are always fine
    const allowed = ALLOWED_DEPS[edge.sourceZone] || [];
    return !allowed.includes(edge.targetZone);
  });

  if (violations.length > 0) {
    const details = violations
      .map((edge) => `  ${edge.from} (${edge.sourceZone}) -> ${edge.to} (${edge.targetZone})`)
      .join("\n");
    assert.fail(`Found ${violations.length} dependency boundary violation(s):\n${details}`);
  }
});

test("dependency boundary: capabilities/gateway.mjs is the only zoned file capabilities exposes to orchestration or ai", async () => {
  const edges = await buildDependencyEdges();
  const toCapabilities = edges.filter(
    (edge) =>
      (edge.sourceZone === "orchestration" || edge.sourceZone === "ai") && edge.targetZone === "capabilities",
  );
  const nonGatewayTargets = toCapabilities.filter((edge) => edge.to !== "capabilities/gateway.mjs");
  assert.deepEqual(
    nonGatewayTargets,
    [],
    `orchestration/ai must call capabilities only through capabilities/gateway.mjs, found: ${JSON.stringify(nonGatewayTargets)}`,
  );
});

test("dependency boundary: capabilities never imports ai", async () => {
  const edges = await buildDependencyEdges();
  const violations = edges.filter((edge) => edge.sourceZone === "capabilities" && edge.targetZone === "ai");
  assert.deepEqual(violations, [], `capabilities must not depend on ai, found: ${JSON.stringify(violations)}`);
});

test("dependency boundary: orchestration -> ai stays limited to the pinned edge list", async () => {
  // ai <-> orchestration is allowed in both directions, so coupling between
  // the two zones can only be kept in check by naming every edge explicitly.
  // Deterministic route-table reading already lives in infra/route-table.mjs;
  // the only thing orchestration may still ask the ai zone for is the full
  // routeRequest flow (deterministic + semantic shadow) used by the workflow
  // "route" node. Adding a new edge here must be a conscious decision.
  const PINNED_EDGES = new Set(["orchestration/linear-runtime.mjs -> ai/routing.mjs"]);
  const edges = await buildDependencyEdges();
  const actual = edges
    .filter((edge) => edge.sourceZone === "orchestration" && edge.targetZone === "ai")
    .map((edge) => `${edge.from} -> ${edge.to}`);
  const unexpected = actual.filter((edge) => !PINNED_EDGES.has(edge));
  assert.deepEqual(unexpected, [], `new orchestration -> ai dependency introduced: ${JSON.stringify(unexpected)}`);
});

test("dependency boundary: no non-literal dynamic imports anywhere in src/", async () => {
  // The other boundary tests only see static imports and import("literal").
  // Anything else — import(variable), template literals, and expressions
  // like import("../x.mjs" + "") — is invisible to static scanning and could
  // smuggle in a reverse-zone dependency at runtime, so the ENTIRE argument
  // must be exactly one plain string literal immediately followed by the
  // closing paren. Checking only the first character was bypassable via
  // string concatenation (cross-review P1, round 3, 2026-07-21).
  const files = await listMjsFiles(SRC_DIR);
  const violations = [];
  const dynamicImportCall = /(?<![\w.$])import\s*\(/g;
  const singleLiteralArgument = /^\s*(["'])(?:(?!\1)[^\\\n]|\\.)*\1\s*\)/;
  for (const filePath of files) {
    const source = stripComments(await readFile(filePath, "utf8"));
    let match;
    while ((match = dynamicImportCall.exec(source)) !== null) {
      const tail = source.slice(match.index + match[0].length);
      if (!singleLiteralArgument.test(tail)) {
        const line = source.slice(0, match.index).split("\n").length;
        const snippet = source.slice(match.index, match.index + 80).split("\n")[0];
        violations.push(`${path.relative(SRC_DIR, filePath)}:${line}: ${snippet.trim()}`);
      }
    }
  }
  assert.deepEqual(violations, [], `dynamic import() whose argument is not a single string literal (invisible to zone checks):\n${violations.join("\n")}`);
});

test("dependency boundary: comment stripping is string-aware and cannot be blinded by block-comment markers inside literals", () => {
  // Round-4 adversarial finding: with regex-based stripping, a string literal
  // containing "/*" started a fake comment that swallowed every line up to a
  // later "*/" — hiding a real reverse-zone import in between while the file
  // stayed valid JavaScript. The lexical stripper must keep that import
  // visible, while still blanking real comments (so specifiers quoted in
  // JSDoc do not create false edges) and leaving strings/regexes intact.
  const openComment = "/" + "*";
  const closeComment = "*" + "/";

  const smuggled = [
    `const decoy = "${openComment}";`,
    `import { routeRequest } from "../ai/routing.mjs";`,
    `const closer = "${closeComment}";`,
  ].join("\n");
  assert.ok(
    extractImportSpecifiers(smuggled).includes("../ai/routing.mjs"),
    "import hidden between string-embedded comment markers must stay visible",
  );

  const realComment = [
    `${openComment} example: import { x } from "../ai/routing.mjs" ${closeComment}`,
    `// import { y } from "../ai/context.mjs"`,
    `import { z } from "../infra/foundation.mjs";`,
  ].join("\n");
  assert.deepEqual(
    extractImportSpecifiers(realComment),
    ["../infra/foundation.mjs"],
    "specifiers quoted inside real comments must not create edges",
  );

  const trickyRegexAndTemplate = [
    `const pattern = /https:\\/\\/${openComment.replace("/", "\\/")}/g;`,
    "const tpl = `prefix ${value} " + openComment + " suffix`;",
    `const apostrophe = "don't"; // trailing comment with ' quote`,
    `import { helper } from "../infra/path-match.mjs";`,
  ].join("\n");
  assert.ok(
    extractImportSpecifiers(trickyRegexAndTemplate).includes("../infra/path-match.mjs"),
    "regex literals, template literals and quotes in comments must not derail the scanner",
  );
});

test("dependency boundary: no module-level import cycles anywhere in src/", async () => {
  // Zone rules allow ai <-> orchestration in both directions (each edge is
  // legitimate on its own), so a module-level cycle between the two zones
  // would slip past the zone check. This test closes that gap for the whole
  // graph, shims included.
  const edges = await buildDependencyEdges();
  const graph = new Map();
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, []);
    graph.get(edge.from).push(edge.to);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const stack = [];
  const cycles = [];
  function visit(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      const state = color.get(dep) || WHITE;
      if (state === GRAY) {
        cycles.push([...stack.slice(stack.indexOf(dep)), dep].join(" -> "));
      } else if (state === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(node, BLACK);
  }
  for (const node of graph.keys()) {
    if ((color.get(node) || WHITE) === WHITE) visit(node);
  }
  assert.deepEqual(cycles, [], `Found import cycle(s):\n${cycles.join("\n")}`);
});
