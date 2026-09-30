// =============================================================================
// 文件名称：project-setup.mjs
// 所属模块：interface
// 作用说明：
//   `wildarrange setup` 的一步式外置治理接入：组合已有 owner，不引入新业务流程；
//   同时提供 `project init-governance` 的默认值封装与 `project attach/show` 的 JSON 视图。
//
// 【运行原理速读】
//   init-governance（骨架+武装配置+Git 初始提交）→ attach → init 运行态
//   → 生成外置宿主 Adapter 包；客户项目全程零写入。
// =============================================================================
import path from "node:path";
import { runCommandFile } from "../infra/command-runner.mjs";
import { initRuntime } from "../infra/runtime-bootstrap.mjs";
import { DEFAULT_PACKAGE_NAME } from "../infra/runtime-config.mjs";
import { attachGovernanceRepository, initializeGovernanceRepository } from "../infra/workspace-context.mjs";
import { installAdapters } from "./adapters.mjs";

/** 创建独立治理仓库：最小骨架 + 默认武装的治理配置 + Git 初始提交；不触碰客户项目。 */
export async function initializeProjectGovernance(projectRoot, options = {}) {
  return initializeGovernanceRepository(projectRoot, { scaffoldConfig: true, initGit: true, ...options });
}

/** 返回适合 CLI JSON 输出的无策略投影。 */
export function projectConnectionView(context) {
  return {
    attached: true,
    projectId: context.projectId,
    governanceId: context.governanceId,
    projectRoot: context.projectRoot,
    governanceRoot: context.governanceRoot,
    runtimeRoot: context.runtimeRoot,
    registryPath: context.registryPath,
    governanceContractPath: context.governanceContractPath,
    projectIdentitySource: context.projectIdentitySource,
    attachedAt: context.attachedAt,
  };
}

/**
 * 一步完成外置治理接入。
 * @param {string} projectRoot 客户项目根
 * @param {{ governanceRoot: string, repository?: string, defaultBranch?: string, target?: string, mode?: string, packageName?: string, localCliPath?: string }} options
 */
export async function setupExternalGovernance(projectRoot, options = {}) {
  if (!options.governanceRoot) throw new Error("wildarrange setup requires --governance-root <path>");
  const repository = options.repository || await readOriginUrl(projectRoot);
  if (!repository) {
    throw new Error("wildarrange setup requires --repository <git-url>（项目没有 origin 远端可推断）");
  }
  const governance = await initializeProjectGovernance(projectRoot, {
    governanceRoot: path.resolve(options.governanceRoot),
    repository,
    defaultBranch: options.defaultBranch,
  });
  const workspace = await attachGovernanceRepository(projectRoot, { governanceRoot: governance.governanceRoot });
  await initRuntime(workspace.projectRoot);
  const adapters = await installAdapters(workspace.projectRoot, workspace, {
    target: options.target || "all",
    mode: options.mode || "local",
    packageName: options.packageName || DEFAULT_PACKAGE_NAME,
    localCliPath: options.localCliPath,
  });
  return {
    kind: "wildarrange_setup",
    projectRoot: workspace.projectRoot,
    governanceRoot: workspace.governanceRoot,
    runtimeRoot: workspace.runtimeRoot,
    repository,
    governance: { created: governance.created, preserved: governance.preserved, git: governance.git || null },
    adapters: adapters.targets,
    nextActions: [
      `编辑并提交治理政策：${path.join(workspace.governanceRoot, "policy", "AGENTS.md")}（含 [待确认] 时不会注入 Agent）`,
      ...Object.values(adapters.targets).flatMap((entry) => entry.nextActions || []),
      "新开一次宿主会话后运行 wildarrange doctor 确认 execution_observed",
    ],
  };
}

/** 读取项目 origin 远端地址；没有则返回 null。 */
async function readOriginUrl(projectRoot) {
  const result = await runCommandFile("git", ["-C", projectRoot, "remote", "get-url", "origin"], projectRoot, 15_000);
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}
