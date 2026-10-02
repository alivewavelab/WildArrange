// =============================================================================
// 文件名称：external-fixture.mjs
// 所属模块：test/helpers
// 作用说明：
//   外置治理三根测试夹具：一次创建 project（产品 Git 仓）、governance（治理 Git 仓）
//   与隔离的本机状态目录，完成 attach，并在回调结束后清理。
//   测试不依赖开发者本机的 WildArrange 状态。默认在治理配置里装好 Worker 握手与
//   调研握手与职责审查者夹具（均在项目外），每张任务仍须用 declare() 声明职责并经 plan approve。
// =============================================================================

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCommandFile } from "../../src/infra/command-runner.mjs";
import { initRuntime } from "../../src/infra/runtime-bootstrap.mjs";
import { approvePlan, importPlan } from "../../src/orchestration/plan-state.mjs";
import { clearWildArrangeRuntimeRoot } from "../../src/infra/runtime-store.mjs";
import {
  attachGovernanceRepository,
  clearWorkspaceContext,
  initializeGovernanceRepository,
} from "../../src/infra/workspace-context.mjs";

/** 夹具审查者：握手确认、项目审查步骤 PASS、R1–R5 职责审计 PASS（证据取自真实源码包）。 */
const FIXTURE_REVIEWER_SOURCE = `const fs=require('node:fs');
const p=JSON.parse(fs.readFileSync(process.env.WILDARRANGE_READINESS_PACKET||process.env.WILDARRANGE_REVIEW_PACKET,'utf8'));
if(p.kind==='execution_readiness_probe') console.log(JSON.stringify({ready:true,challenge:p.challenge,loadedSkills:p.requiredSkills.map(s=>s.name)}));
else if(p.kind==='project_review_step') {
  const evidence=p.step.appliesTo.map(name=>p.source.files.find(file=>file.path===name)).filter(file=>file&&typeof file.content==='string').map(file=>({file:file.path,line:1,text:file.content.split('\\n')[0]}));
  console.log(JSON.stringify({stepId:p.step.id,inputDigest:p.inputDigest,decision:'PASS',summary:'Fixture reviewed current document content',evidence,findings:[]}));
} else console.log(JSON.stringify({decision:'PASS',checks:Object.keys(p.rules).map(rule=>({rule,decision:'PASS',reason:'Fixture inspected source'})),findings:[]}));`;

/**
 * 生成夹具任务的职责声明：每个脚本一条、无业务事实。
 * @param {...string} scripts 任务会改动的精确文件路径
 */
export function declare(...scripts) {
  return scripts.map((script) => ({
    script,
    additions: `Fixture change to ${script}`,
    responsibilityBefore: "Absent or previous fixture behavior",
    responsibilityAfter: `Own the fixture output in ${script}`,
    facts: [],
  }));
}

/** 导入计划并以夹具身份批准；每张任务须已带 declare() 职责声明。 */
export async function importApprovedPlan(projectRoot, planPath) {
  const plan = await importPlan(projectRoot, planPath);
  await approvePlan(projectRoot, { approver: "fixture" });
  return plan;
}

/** 在 cwd 下提交全部文件；失败直接抛出，夹具不吞错。 */
export async function gitCommitAll(cwd, message) {
  for (const args of [["add", "-A"], ["commit", "-q", "--allow-empty", "-m", message]]) {
    const result = await runCommandFile("git", args, cwd);
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
}

/** 初始化一个带身份配置的 main 分支仓库。 */
async function gitInit(cwd) {
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "WildArrange Test"], ["config", "user.email", "test@example.invalid"]]) {
    const result = await runCommandFile("git", args, cwd);
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
}

/**
 * 创建已连接的外置三根项目并执行回调。
 * @param {(roots: {root: string, projectRoot: string, governanceRoot: string, stateHome: string}) => Promise<void>} fn
 * @param {{ policy?: string, projectFiles?: Record<string, string>, init?: boolean, projectGit?: boolean, reviewer?: boolean }} [options]
 *   reviewer:false 不装夹具审查者，用于验证缺少执行器时的阻断。
 *   projectGit:false 让产品项目不是 Git 仓（只写 projectFiles、不建提交），用于验证非 Git 项目的 manifest 范围回落；默认 true。
 */
export async function withExternalProject(fn, options = {}) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const root = await mkdtemp(path.join(baseDir, "external-"));
  const projectRoot = path.join(root, "project");
  const governanceRoot = path.join(root, "governance");
  const stateHome = path.join(root, "state-home");
  const previousStateHome = process.env.WILDARRANGE_STATE_HOME;
  process.env.WILDARRANGE_STATE_HOME = stateHome;
  try {
    await mkdir(projectRoot, { recursive: true });
    if (options.projectGit !== false) await gitInit(projectRoot);
    for (const [relativePath, content] of Object.entries(options.projectFiles || { "README.md": "# Fixture project\n" })) {
      await mkdir(path.dirname(path.join(projectRoot, relativePath)), { recursive: true });
      await writeFile(path.join(projectRoot, relativePath), content, "utf8");
    }
    if (options.projectGit !== false) await gitCommitAll(projectRoot, "fixture baseline");

    await initializeGovernanceRepository(projectRoot, { governanceRoot, repository: "https://example.test/product.git", defaultBranch: "main" });
    // init-governance 会补建其它政策模板（含 [待确认] 占位）；夹具只保留一份可控的 AGENTS.md。
    for (const name of await readdir(path.join(governanceRoot, "policy"))) {
      if (name !== "AGENTS.md") await rm(path.join(governanceRoot, "policy", name), { force: true });
    }
    await writeFile(path.join(governanceRoot, "policy", "AGENTS.md"), options.policy || "# Fixture policy\n\n- Keep changes inside writable paths.\n", "utf8");
    if (options.reviewer !== false) {
      const reviewerPath = path.join(root, "fixture-reviewer.cjs");
      await writeFile(reviewerPath, FIXTURE_REVIEWER_SOURCE, "utf8");
      const command = `node "${reviewerPath}"`;
      await writeFile(path.join(governanceRoot, "policy", "wildarrange.config.json"),
        JSON.stringify({ executionReadiness: { workerProbe: command, researchProbe: command }, review: { responsibility: { command } } }, null, 2), "utf8");
    }
    await gitInit(governanceRoot);
    await gitCommitAll(governanceRoot, "fixture governance");

    await attachGovernanceRepository(projectRoot, { governanceRoot, stateHome });
    if (options.init !== false) await initRuntime(projectRoot);
    await fn({ root, projectRoot, governanceRoot, stateHome });
  } finally {
    if (previousStateHome === undefined) delete process.env.WILDARRANGE_STATE_HOME;
    else process.env.WILDARRANGE_STATE_HOME = previousStateHome;
    clearWorkspaceContext(projectRoot);
    clearWildArrangeRuntimeRoot(projectRoot);
    await rm(root, { recursive: true, force: true });
  }
}
