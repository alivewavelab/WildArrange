// =============================================================================
// 文件名称：project-connection.mjs
// 所属模块：interface
// 作用说明：
//   面向 CLI/宿主展示项目、治理仓库和运行态三根连接结果。
// =============================================================================
import {
  attachGovernanceRepository,
  initializeGovernanceRepository,
  resolveWorkspaceContext,
} from "../infra/workspace-context.mjs";

/** 显式连接项目与独立治理仓库。 */
export async function attachProjectConnection(projectRoot, options = {}) {
  return attachGovernanceRepository(projectRoot, options);
}

/** 创建独立治理仓库：最小骨架 + 默认武装的治理配置 + Git 初始提交；不触碰客户项目。 */
export async function initializeProjectGovernance(projectRoot, options = {}) {
  return initializeGovernanceRepository(projectRoot, { scaffoldConfig: true, initGit: true, ...options });
}

/** 查询并绑定项目当前工作区上下文；项目尚未连接时返回 null。 */
export async function showProjectConnection(projectRoot, options = {}) {
  return resolveWorkspaceContext(projectRoot, options);
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
