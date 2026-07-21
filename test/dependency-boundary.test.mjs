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

const ALLOWED_DEPS = {
  interface: ["orchestration", "infra", "legacy"],
  orchestration: ["ai", "capabilities", "infra", "legacy"],
  // ai includes host-facing hooks/context builders that read orchestration
  // state (current task, attention report) and call gates (via the gateway,
  // same seam orchestration uses) to decide what to inject/block. That makes
  // ai -> orchestration and ai -> capabilities legitimate one-way edges; the
  // reverse (orchestration/capabilities depending on ai) stays forbidden.
  ai: ["orchestration", "capabilities", "infra", "legacy"],
  capabilities: ["infra", "legacy"],
  infra: ["legacy"],
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

function extractImportSpecifiers(source) {
  const specifiers = [];
  const importRegex = /(?:import|export)\s+(?:[^'"]*?from\s+)?["']([^"']+)["']/g;
  let match;
  while ((match = importRegex.exec(source)) !== null) {
    specifiers.push(match[1]);
  }
  const dynamicImportRegex = /import\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamicImportRegex.exec(source)) !== null) {
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
