import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runRepositoryGovernanceAudit } from "../src/capabilities/repository-governance.mjs";
import { extractComments, inspectRepositoryGovernance } from "../src/infra/repository-layout.mjs";
import { resolveRouteDecision } from "../src/infra/route-table.mjs";
import { runDoctor } from "../src/interface/doctor.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-governance-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const policy = {
  enabled: true,
  governedRoots: ["src"],
  requiredAgentBoundaries: ["src"],
  documentationPairs: [["README.md", "README.en.md"]],
  naming: {
    directories: "kebab-case",
    sourceFiles: "kebab-case.mjs",
    exceptions: [],
  },
  commentRules: [{
    globs: ["src/**/*.mjs"],
    blockedPatterns: ["\\bTODO\\b"],
  }],
};

async function seedRepository(dir, source) {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "AGENTS.md"), "# Source Rules\n\nAll source changes require tests.\n");
  await writeFile(path.join(dir, "src", "example.mjs"), source);
  await writeFile(path.join(dir, "README.md"), "```bash\nnode ./bin/helix.mjs governance audit\n```\n");
  await writeFile(path.join(dir, "README.en.md"), "```bash\nnode ./bin/helix.mjs governance audit\n```\n");
}

test("repository governance inspects real comments without flagging string literals", async () => {
  await withTempDir(async (dir) => {
    await seedRepository(dir, "const label = \"TODO is user data\";\nexport { label };\n");
    const result = await inspectRepositoryGovernance(dir, policy);
    assert.equal(result.status, "pass");
    assert.equal(result.findings.length, 0);
    assert.deepEqual(extractComments("src/example.mjs", "const value = '// TODO';\n// real note\n"), [
      { line: 2, text: " real note" },
    ]);
  });
});

test("repository governance detects comments inside JavaScript template expressions", async () => {
  await withTempDir(async (dir) => {
    const source = "export const value = `${1 + (/* TODO inside expression */ 2)}`;\n";
    await seedRepository(dir, source);
    assert.deepEqual(extractComments("src/example.mjs", source), [
      { line: 1, text: " TODO inside expression " },
    ]);
    assert.deepEqual(
      extractComments("src/example.mjs", "const nested = `${{value: `${2 /* TODO nested */}`}}`;\n"),
      [{ line: 1, text: " TODO nested " }],
    );
    assert.deepEqual(
      extractComments("src/example.mjs", "const safe = `${/}/.test(\"}\") ? 1 : 2} // string data`; // real note\n"),
      [{ line: 1, text: " real note" }],
    );
    const result = await inspectRepositoryGovernance(dir, policy);
    assert.equal(result.status, "fail");
    assert.ok(result.findings.some((finding) => finding.ruleId === "comment_pattern_blocked" && finding.line === 1));
  });
});

test("repository governance blocks comment violations and writes LuWu evidence", async () => {
  await withTempDir(async (dir) => {
    await seedRepository(dir, "// TODO replace placeholder\nexport const ready = false;\n");
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({ repositoryGovernance: policy }, null, 2));

    const report = await runRepositoryGovernanceAudit(dir);
    assert.equal(report.status, "fail");
    assert.ok(report.findings.some((finding) => finding.ruleId === "comment_pattern_blocked" && finding.path === "src/example.mjs"));
    assert.ok(report.proposedChanges.some((change) => change.path === "src/example.mjs" && change.verification.includes("governance audit")));
    assert.deepEqual(report.unresolved, []);
    assert.match(await readFile(path.join(dir, ".helix", "reports", "governance", "latest.md"), "utf8"), /comment_pattern_blocked/);

    const doctor = await runDoctor(dir);
    assert.equal(doctor.sections.repositoryGovernance.status, "fail");
    assert.ok(doctor.findings.some((finding) => finding.section === "repository_governance" && finding.severity === "error"));
  });
});

test("repository governance detects missing directory AGENTS and README command drift", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "example.mjs"), "export const ready = true;\n");
    await writeFile(path.join(dir, "README.md"), "node ./bin/helix.mjs governance audit\n");
    await writeFile(path.join(dir, "README.en.md"), "node ./bin/helix.mjs doctor\n");

    const result = await inspectRepositoryGovernance(dir, policy);
    const repeated = await inspectRepositoryGovernance(dir, policy);
    assert.equal(result.status, "fail");
    const missingAgents = result.findings.find((finding) => finding.ruleId === "agents_file_missing");
    assert.ok(missingAgents);
    assert.equal(repeated.findings.find((finding) => finding.ruleId === "agents_file_missing").id, missingAgents.id);
    assert.ok(result.findings.some((finding) => finding.ruleId === "documentation_command_drift"));
  });
});

test("repository governance enforces required safety markers in paired documentation", async () => {
  await withTempDir(async (dir) => {
    await seedRepository(dir, "export const ready = true;\n");
    const result = await inspectRepositoryGovernance(dir, {
      ...policy,
      documentationRequirements: [{
        path: "README.en.md",
        requiredPatterns: ["HELIX_DASHBOARD_TOKEN"],
      }],
    });
    assert.equal(result.status, "fail");
    assert.ok(result.findings.some((finding) => finding.ruleId === "documentation_required_marker_missing" && finding.path === "README.en.md"));
  });
});

test("repository governance rejects unrouted Agents and nonexistent documented CLI commands", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "AGENTS.md"), "# Source Rules\n\nSource rules.\n");
    await writeFile(path.join(dir, "README.md"), "node ./bin/helix.mjs imaginary command\n");
    await writeFile(path.join(dir, "README.en.md"), "node ./bin/helix.mjs imaginary command\n");
    await mkdir(path.join(dir, "bin"), { recursive: true });
    await writeFile(path.join(dir, "bin", "helix.mjs"), [
      "const decoy = 'wildarrange imaginary command';",
      "if (process.argv.includes('--help')) console.log('wildarrange doctor');",
      "void decoy;",
      "",
    ].join("\n"));

    const packDir = path.join(dir, "packs", "wildarrange-linear");
    await mkdir(path.join(packDir, "agents"), { recursive: true });
    await mkdir(path.join(packDir, "skills"), { recursive: true });
    await mkdir(path.join(packDir, "tools"), { recursive: true });
    await writeFile(path.join(packDir, "agents", "luwu.md"), "# LuWu\n");
    await writeFile(path.join(packDir, "skills", "repository-governance.md"), "# repository-governance\n");
    await writeFile(path.join(packDir, "tools", "tool-contract.json"), "{}\n");
    await writeFile(path.join(packDir, "routes.json"), JSON.stringify({
      defaults: { skills: ["repository-governance"] },
      intents: [],
      domains: [],
    }));
    await writeFile(path.join(packDir, "manifest.json"), JSON.stringify({
      agents: { LuWu: "agents/luwu.md" },
      skills: { "repository-governance": "skills/repository-governance.md" },
      tools: "tools/tool-contract.json",
      routes: "routes.json",
    }));

    const result = await inspectRepositoryGovernance(dir, policy);
    assert.equal(result.status, "fail");
    assert.ok(result.findings.some((finding) => finding.ruleId === "manifest_agent_unrouted"));
    assert.ok(result.findings.some((finding) => finding.ruleId === "documented_cli_unknown" && finding.evidence.includes("imaginary command")));
  });
});

test("repository governance rejects a self-consistent sixth long-lived Agent", async () => {
  await withTempDir(async (dir) => {
    const packDir = path.join(dir, "packs", "wildarrange-linear");
    await mkdir(path.join(packDir, "agents"), { recursive: true });
    await mkdir(path.join(packDir, "skills"), { recursive: true });
    await mkdir(path.join(packDir, "tools"), { recursive: true });
    await writeFile(path.join(packDir, "agents", "router.md"), "# Router\n");
    await writeFile(path.join(packDir, "agents", "rogue.md"), "# Rogue\n");
    await writeFile(path.join(packDir, "tools", "tool-contract.json"), "{}\n");
    const routes = {
      defaults: { route: "answer", primaryAgent: "Rogue", supportAgents: [], skills: [] },
      askGate: {},
      intents: [],
      domains: [],
    };
    await writeFile(path.join(packDir, "routes.json"), JSON.stringify(routes));
    await writeFile(path.join(packDir, "manifest.json"), JSON.stringify({
      agents: { Router: "agents/router.md", Rogue: "agents/rogue.md" },
      skills: {},
      tools: "tools/tool-contract.json",
      routes: "routes.json",
    }));
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      agents: { Rogue: { role: "rogue", provider: "host", model: "host-default" } },
    }));

    const result = await inspectRepositoryGovernance(dir, {
      enabled: true,
      governedRoots: [],
      requiredAgentBoundaries: [],
      documentationPairs: [],
    });
    assert.equal(result.status, "fail");
    assert.ok(result.findings.some((finding) => finding.ruleId === "fixed_agent_extra" && finding.evidence.includes("Rogue")));
    assert.ok(result.findings.some((finding) => finding.ruleId === "configured_agent_not_fixed" && finding.evidence.includes("Rogue")));
    assert.throws(() => resolveRouteDecision(routes, "anything"), /must use one of Jiuwei, DiJiang, ZhuRong, BaiZe, LuWu/);
  });
});

test("changed-only governance checks touched boundaries without silently running unrelated roots", async () => {
  await withTempDir(async (dir) => {
    await seedRepository(dir, "export const ready = true;\n");
    await mkdir(path.join(dir, "doc"), { recursive: true });
    const scopedPolicy = {
      ...policy,
      governedRoots: ["src", "doc"],
      requiredAgentBoundaries: ["src", "doc"],
    };
    const changed = await inspectRepositoryGovernance(dir, scopedPolicy, {
      changedOnly: true,
      changedPaths: ["src/example.mjs"],
    });
    assert.equal(changed.status, "pass");
    assert.equal(changed.mode, "changed-only");
    assert.equal(changed.changedPathCount, 1);
    assert.ok(!changed.findings.some((finding) => finding.path === "doc/AGENTS.md"));

    const full = await inspectRepositoryGovernance(dir, scopedPolicy);
    assert.ok(full.findings.some((finding) => finding.ruleId === "agents_file_missing" && finding.path === "doc/AGENTS.md"));
  });
});
