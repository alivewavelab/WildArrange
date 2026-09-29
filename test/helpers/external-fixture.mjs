// =============================================================================
// 文件名称：external-fixture.mjs
// 所属模块：test/helpers
// 作用说明：
//   外置治理三根测试夹具：一次创建 project（产品 Git 仓）、governance（治理 Git 仓）
//   与隔离的本机状态目录，完成 attach，并在回调结束后清理。
//   测试不依赖开发者本机的 WildArrange 状态。
// =============================================================================

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCommandFile } from "../../src/infra/command-runner.mjs";
import { initRuntime } from "../../src/infra/runtime-bootstrap.mjs";
import { clearWildArrangeRuntimeRoot } from "../../src/infra/runtime-store.mjs";
import {
  attachGovernanceRepository,
  clearWorkspaceContext,
  initializeGovernanceRepository,
} from "../../src/infra/workspace-context.mjs";

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
 * @param {{ policy?: string, projectFiles?: Record<string, string>, init?: boolean, projectGit?: boolean }} [options]
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
