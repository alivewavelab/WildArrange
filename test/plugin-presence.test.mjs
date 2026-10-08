// =============================================================================
// 文件名称：plugin-presence.test.mjs
// 所属模块：test
// 作用说明：doctor 不能只凭历史 Hook 回执认定宿主已激活：插件在 WildArrange 之外被卸载
//   或禁用时必须报错；无法查询时只告警。覆盖 Claude Code（claude plugin list）、
//   Codex（codex plugin list）与 Kimi（installed.json）。全部使用假 CLI 与假主目录。
// =============================================================================
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCommandFile } from "../src/infra/command-runner.mjs";
import { resolveWorkspaceContext } from "../src/infra/workspace-context.mjs";
import { activateClaudeAdapter, installAdapters } from "../src/interface/adapters.mjs";
import { runDoctor } from "../src/interface/doctor.mjs";
import { withExternalProject } from "./helpers/external-fixture.mjs";

const CLI_PATH = path.join(process.cwd(), "bin", "wildarrange.mjs");

/** 写一个按 STATE 文件内容回答的假 CLI。 */
async function fakeCli(dir, name, body) {
  const bin = path.join(dir, `${name}.cjs`);
  await writeFile(bin, `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst state = fs.existsSync(${JSON.stringify(path.join(dir, `${name}.state`))}) ? fs.readFileSync(${JSON.stringify(path.join(dir, `${name}.state`))}, "utf8") : "";\nconst args = process.argv.slice(2);\n${body}\n`, "utf8");
  await chmod(bin, 0o755);
  return { bin, set: (value) => writeFile(path.join(dir, `${name}.state`), value) };
}

async function setup(roots) {
  const { projectRoot, stateHome, root } = roots;
  const workspace = await resolveWorkspaceContext(projectRoot, { stateHome });
  const report = await installAdapters(projectRoot, workspace, { target: "all", mode: "local", localCliPath: CLI_PATH });
  const fakes = path.join(root, "fakes");
  await mkdir(fakes);
  const claude = await fakeCli(fakes, "claude", `
if (args.join(" ") === "plugin list --json") { console.log(state || "[]"); process.exit(0); }
if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") { console.log("[]"); process.exit(0); }
process.exit(0);`);
  const codex = await fakeCli(fakes, "codex", `
if (args[0] === "plugin" && args[1] === "list") { console.log("Marketplace \`wildarrange-local\`\\n\\nPLUGIN  STATUS  VERSION  SOURCE\\n" + state); process.exit(0); }
process.exit(1);`);
  const kimiHome = path.join(root, "kimi-home");
  await mkdir(path.join(kimiHome, ".kimi-code", "plugins"), { recursive: true });
  const kimi = (plugins) => writeFile(path.join(kimiHome, ".kimi-code", "plugins", "installed.json"), JSON.stringify({ version: 1, plugins }));
  // 先装好并激活 Claude Code，再让三个宿主各产生一次真实生命周期回执
  await claude.set(JSON.stringify([{ id: "wildarrange-governance@wildarrange-local", scope: "user", enabled: true }]));
  await activateClaudeAdapter(projectRoot, workspace, { claudeBin: claude.bin });
  for (const host of ["claude", "codex", "kimi"]) {
    const payload = JSON.stringify({ hook_event_name: "SessionStart", session_id: `${host}-presence`, cwd: projectRoot });
    const ran = await runCommandFile(process.execPath, [report.targets[host].bridgePath], projectRoot, 30_000, { input: payload, env: { WILDARRANGE_STATE_HOME: stateHome } });
    assert.equal(ran.exitCode, 0, ran.stderr);
  }
  const hostProbe = { claudeBin: claude.bin, codexBin: codex.bin, homeDir: kimiHome };
  return { claude, codex, kimi, hostProbe };
}

function adapterFindings(report) {
  return report.findings.filter((finding) => finding.section === "adapters").map((finding) => `${finding.target}:${finding.code}`);
}

test("doctor flags plugins removed or disabled outside WildArrange even when old receipts exist", async () => {
  await withExternalProject(async (roots) => {
    const { claude, codex, kimi, hostProbe } = await setup(roots);
    await codex.set("wildarrange-governance@wildarrange-local  installed, enabled  1.0.0  /x");
    await kimi([{ id: "wildarrange-governance", enabled: true }]);
    let report = await runDoctor(roots.projectRoot, { hostProbe });
    assert.deepEqual(adapterFindings(report).filter((code) => /removed|presence/.test(code)), [], "all three present: no presence findings");
    assert.equal(report.sections.adapters.targets.find((target) => target.target === "codex").activation, "execution_observed");

    await claude.set("[]");
    await codex.set("wildarrange-governance@wildarrange-local  not installed    /x");
    await kimi([{ id: "wildarrange-governance", enabled: false }]);
    report = await runDoctor(roots.projectRoot, { hostProbe });
    for (const host of ["claude", "codex", "kimi"]) {
      const finding = report.findings.find((item) => item.target === host && item.code === "external_adapter_removed");
      assert.equal(finding?.severity, "error", `${host}: ${JSON.stringify(adapterFindings(report))}`);
      assert.equal(report.sections.adapters.targets.find((target) => target.target === host).activation, "removed", `${host} must not stay "execution_observed"`);
    }
    assert.match(report.findings.find((item) => item.target === "kimi" && item.code === "external_adapter_removed").message, /disabled|禁用/);
  });
});

test("doctor only warns when it cannot check whether a plugin is still installed", async () => {
  await withExternalProject(async (roots) => {
    const { kimi, hostProbe } = await setup(roots);
    await kimi([{ id: "wildarrange-governance", enabled: true }]);
    const report = await runDoctor(roots.projectRoot, { hostProbe: { ...hostProbe, codexBin: path.join(roots.root, "no-codex") } });
    const codex = report.findings.find((item) => item.target === "codex" && /presence|removed/.test(item.code || ""));
    assert.equal(codex?.code, "external_adapter_presence_unknown");
    assert.equal(codex.severity, "warn");
    assert.equal(report.sections.adapters.targets.find((target) => target.target === "codex").activation, "execution_observed");
  });
});
