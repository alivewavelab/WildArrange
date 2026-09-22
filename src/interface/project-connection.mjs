// =============================================================================
// 文件名称：project-connection.mjs
// 所属模块：interface
// 作用说明：
//   面向 CLI/宿主展示项目、治理仓库和运行态三根连接结果。
// =============================================================================
import {
  attachGovernanceRepository,
  initializeGovernanceRepository,
  migrateLegacyWorkspace,
  resolveWorkspaceContext,
} from "../infra/workspace-context.mjs";

/** 显式连接项目与独立治理仓库。 */
export async function attachProjectConnection(projectRoot, options = {}) {
  return attachGovernanceRepository(projectRoot, options);
}

/** 创建独立治理仓库最小骨架；不触碰项目、不自动执行 Git。 */
export async function initializeProjectGovernance(projectRoot, options = {}) {
  return initializeGovernanceRepository(projectRoot, options);
}

/** 查询并绑定项目当前工作区上下文。 */
export async function showProjectConnection(projectRoot, options = {}) {
  return resolveWorkspaceContext(projectRoot, options);
}

/** 校验并迁移旧项目内运行态，成功后才切换外部 registry。 */
export async function migrateProjectConnection(projectRoot, options = {}) {
  return migrateLegacyWorkspace(projectRoot, options);
}

/** 返回适合 CLI JSON 输出的无策略投影。 */
export function projectConnectionView(context) {
  return {
    mode: context.mode,
    attached: context.attached,
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
