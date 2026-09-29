// =============================================================================
// 文件名称：workspace-context.mjs
// 所属模块：infra
// 作用说明：
//   解析客户项目根、独立治理仓库根与本机运行态根；维护外部项目连接表。
//
// 【运行原理速读】
//   project identity → external registry → validated three-root context
//   → bindWildArrangeRuntimeRoot。未连接项目保持 legacy 单根兼容。
// =============================================================================
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandFile } from "./command-runner.mjs";
import { buildRegistryFromCards, digestCanonical } from "./verification-registry.mjs";
import {
  bindWildArrangeRuntimeRoot,
  readJson,
  writeJsonAtomic,
} from "./runtime-store.mjs";
import { writeFile } from "node:fs/promises";

const WORKSPACE_REGISTRY_VERSION = 1;
const GOVERNANCE_CONTRACT_FILE = "wildarrange-governance.json";
const BOUND_CONTEXTS = new Map();

/** 在独立目录创建最小治理仓库骨架；只创建缺失文件，不初始化或操作 Git。 */
export async function initializeGovernanceRepository(projectRoot, options = {}) {
  const project = await canonicalExistingDirectory(projectRoot, "project root");
  const governanceRoot = path.resolve(requiredText(options.governanceRoot, "governance root"));
  assertSeparateRoot(project, governanceRoot, "governance root");
  const repository = requiredText(options.repository, "project repository");
  await mkdir(path.join(governanceRoot, "policy"), { recursive: true });
  await mkdir(path.join(governanceRoot, "verification"), { recursive: true });
  for (const directory of ["tasks", "acceptance", "decisions"]) {
    await mkdir(path.join(governanceRoot, directory), { recursive: true });
  }
  const targets = [
    {
      path: path.join(governanceRoot, GOVERNANCE_CONTRACT_FILE),
      value: `${JSON.stringify({
        schemaVersion: 1,
        project: { repository, ...(options.defaultBranch ? { defaultBranch: options.defaultBranch } : {}) },
        policyRoot: "policy",
        verificationRegistry: "verification/registry.json",
      }, null, 2)}\n`,
    },
    {
      path: path.join(governanceRoot, "policy", "AGENTS.md"),
      value: "# Project governance policy\n\n> Replace the placeholders below, review them with a human, then commit this governance repository before importing project plans.\n\n## Quality policy\n\n- [待确认] Project-specific non-negotiable quality rules.\n\n## Risk boundaries\n\n- [待确认] Risks that require additional verification or human approval.\n",
    },
    {
      path: path.join(governanceRoot, "verification", "registry.json"),
      value: `${JSON.stringify(buildRegistryFromCards([]), null, 2)}\n`,
    },
  ];
  const created = [];
  const preserved = [];
  for (const target of targets) {
    try {
      await writeFile(target.path, target.value, { encoding: "utf8", flag: "wx" });
      created.push(path.relative(governanceRoot, target.path).split(path.sep).join("/"));
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      preserved.push(path.relative(governanceRoot, target.path).split(path.sep).join("/"));
    }
  }
  return {
    kind: "governance_repository_initialized",
    governanceRoot,
    created,
    preserved,
    gitInitialized: false,
    attached: false,
  };
}

/** 返回平台默认的 WildArrange 本机状态目录。 */
function defaultWildArrangeStateHome(env = process.env, platform = process.platform) {
  if (typeof env.WILDARRANGE_STATE_HOME === "string" && env.WILDARRANGE_STATE_HOME.trim()) {
    return path.resolve(env.WILDARRANGE_STATE_HOME);
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "WildArrange");
  }
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "WildArrange");
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "wildarrange");
}

/** 读取并校验治理仓库合同。 */
export async function loadGovernanceContract(governanceRoot) {
  const root = await canonicalExistingDirectory(governanceRoot, "governance root");
  const contractPath = path.join(root, GOVERNANCE_CONTRACT_FILE);
  const contract = await readJson(contractPath, null);
  if (!contract) throw new Error(`governance contract is missing: ${contractPath}`);
  if (contract.schemaVersion !== 1) throw new Error("governance contract schemaVersion must be 1");
  if (!contract.project || typeof contract.project.repository !== "string" || !contract.project.repository.trim()) {
    throw new Error("governance contract project.repository is required");
  }
  const policyRoot = assertSafeRelativePath(contract.policyRoot || "policy", "policyRoot");
  const verificationRegistry = assertSafeRelativePath(contract.verificationRegistry || "verification/registry.json", "verificationRegistry");
  const policyPath = await canonicalExistingDirectory(path.resolve(root, policyRoot), "governance policy root");
  assertPathInside(root, policyPath, "policyRoot");
  assertPathInside(root, path.resolve(root, verificationRegistry), "verificationRegistry");
  return {
    path: contractPath,
    root,
    contract: {
      ...contract,
      policyRoot,
      verificationRegistry,
      policyPath,
    },
  };
}

/** 将客户项目显式连接到独立治理仓库，并把映射写到项目外部 registry。 */
export async function attachGovernanceRepository(projectRoot, options = {}) {
  const candidate = await prepareExternalConnection(projectRoot, options);
  if (existsSync(path.join(candidate.project, ".wildarrange"))) {
    throw new Error("project-local .wildarrange runtime state exists; attach requires a project without local runtime state");
  }
  return commitExternalConnection(candidate);
}

/** 解析项目当前三根；没有外部连接时保持 legacy 单根模式。 */
export async function resolveWorkspaceContext(projectRoot, options = {}) {
  const requestedRoot = await canonicalExistingDirectory(projectRoot, "project root");
  const stateHome = path.resolve(options.stateHome || defaultWildArrangeStateHome(options.env));
  const registryPath = path.join(stateHome, "registry.json");
  const registry = await readWorkspaceRegistry(registryPath);
  // 任务 worktree 建在 runtimeRoot 之下：此时项目根取注册项目根，不能把 worktree 当项目。
  const taskWorktreeEntry = findRegisteredRuntimeContaining(registry, requestedRoot);
  const project = taskWorktreeEntry
    ? await canonicalExistingDirectory(taskWorktreeEntry.projectRoot, "project root")
    : await resolveWorkspaceProjectRoot(requestedRoot, registry);
  const identity = await resolveProjectIdentity(project);

  if (options.legacy === true) {
    const runtimeRoot = path.join(project, ".wildarrange");
    return bindWorkspaceContext(workspaceContext({
      projectId: identity.projectId,
      projectRoot: project,
      projectIdentitySource: identity.source,
      governanceId: null,
      governanceRoot: null,
      runtimeRoot,
      contractPath: null,
      attachedAt: null,
    }, null, registryPath, "legacy"));
  }

  const entry = registry.projects[identity.projectId];
  if (!entry) {
    const runtimeRoot = path.join(project, ".wildarrange");
    return bindWorkspaceContext(workspaceContext({
      projectId: identity.projectId,
      projectRoot: project,
      projectIdentitySource: identity.source,
      governanceId: null,
      governanceRoot: null,
      runtimeRoot,
      contractPath: null,
      attachedAt: null,
    }, null, registryPath, "legacy"));
  }

  const governance = await loadGovernanceContract(entry.governanceRoot);
  assertSeparateRoot(project, governance.root, "governance root");
  assertSeparateRoot(project, entry.runtimeRoot, "runtime root");
  assertSeparateRoot(governance.root, entry.runtimeRoot, "runtime root");
  // linked worktree 与主 checkout 共用 git common-dir，因此共享 projectId 与
  // runtime；但本次命令的 projectRoot 必须保持当前 worktree，而非首次 attach 路径。
  return bindWorkspaceContext(workspaceContext({ ...entry, projectRoot: project }, governance.contract, registryPath, "external"));
}

/** 返回 runtimeRoot 包含 candidate 的已注册项目（即 candidate 位于任务 worktree 等运行态子树内）。 */
function findRegisteredRuntimeContaining(registry, candidate) {
  return Object.values(registry.projects || {}).find((entry) => {
    if (typeof entry?.runtimeRoot !== "string" || typeof entry?.projectRoot !== "string") return false;
    let runtimeRoot = path.resolve(entry.runtimeRoot);
    try { runtimeRoot = realpathSync.native(runtimeRoot); } catch { /* 运行态尚未创建时按原路径比较 */ }
    return pathIsInside(runtimeRoot, candidate);
  }) || null;
}

/**
 * 外置 Hook 的执行根：cwd 所在 Git toplevel（项目子目录、任务 worktree、外部 linked worktree），
 * 非 Git 项目回到已注册项目根；不属于该项目的 cwd 原样返回。
 */
export async function resolveExecutionRoot(context, cwd) {
  const start = path.resolve(cwd);
  const top = await runCommandFile("git", ["-C", start, "rev-parse", "--show-toplevel"], start, 15_000).catch(() => null);
  if (top?.exitCode === 0 && top.stdout.trim()) {
    const toplevel = await realpath(top.stdout.trim()).catch(() => path.resolve(top.stdout.trim()));
    const sameProject = pathIsInside(context.projectRoot, toplevel)
      || pathIsInside(context.runtimeRoot, toplevel)
      || (await resolveProjectIdentity(toplevel).catch(() => null))?.projectId === context.projectId;
    if (sameProject) return toplevel;
  }
  return pathIsInside(context.projectRoot, start) ? context.projectRoot : start;
}

/**
 * Hook 可能从项目子目录启动。Git 项目统一回到当前 worktree 顶层；非 Git
 * 项目只接受 registry 中已登记且包含当前目录的最长根，避免全局 Hook 猜项目。
 */
async function resolveWorkspaceProjectRoot(requestedRoot, registry) {
  const registered = Object.values(registry.projects || {})
    .map((entry) => entry?.projectRoot)
    .filter((value) => typeof value === "string" && pathIsInside(value, requestedRoot))
    .sort((left, right) => right.length - left.length)[0];
  if (registered) return canonicalExistingDirectory(registered, "project root");

  const topLevel = await runCommandFile("git", ["-C", requestedRoot, "rev-parse", "--show-toplevel"], requestedRoot, 15_000);
  if (topLevel.exitCode === 0 && topLevel.stdout.trim()) {
    const identity = await resolveProjectIdentity(requestedRoot);
    if (registry.projects?.[identity.projectId]) {
      return canonicalExistingDirectory(topLevel.stdout.trim(), "project root");
    }
  }
  return requestedRoot;
}

/** 绑定完整工作区上下文，供规则扫描与长寿命宿主读取。 */
function bindWorkspaceContext(context) {
  const projectRoot = workspaceRootKey(context.projectRoot);
  bindWildArrangeRuntimeRoot(projectRoot, context.runtimeRoot, context.mode === "external" ? {
    rootDir: context.governanceRoot,
    configPath: path.posix.join(context.governanceContract.policyRoot, "wildarrange.config.json"),
    registryPath: context.governanceContract.verificationRegistry,
  } : null);
  BOUND_CONTEXTS.set(projectRoot, context);
  return context;
}

/** 返回当前进程已绑定的工作区上下文。 */
export function getBoundWorkspaceContext(projectRoot) {
  return BOUND_CONTEXTS.get(workspaceRootKey(projectRoot)) || null;
}

/** 解析任务唯一可写仓库根；治理任务在未连接时 fail-closed。 */
export function resolveTaskRepositoryRoot(projectRoot, task = {}) {
  const context = getBoundWorkspaceContext(projectRoot);
  const target = task.repositoryTarget || "project";
  if (target === "project") return context?.projectRoot || path.resolve(projectRoot);
  if (target === "governance" && context?.mode === "external" && context.governanceRoot) {
    return context.governanceRoot;
  }
  throw new Error(`task ${task.id || "unknown"} targets governance repository but no external governance workspace is bound`);
}

/** 清除完整上下文绑定；runtime-store 的路径绑定由其独立测试接口清理。 */
export function clearWorkspaceContext(projectRoot) {
  return BOUND_CONTEXTS.delete(workspaceRootKey(projectRoot));
}

function workspaceRootKey(rootDir) {
  const absolute = path.resolve(rootDir);
  try {
    return normalizeForComparison(realpathSync.native(absolute));
  } catch {
    return normalizeForComparison(absolute);
  }
}

/** 使用 Git common-dir（否则项目 realpath）生成本机项目身份。 */
async function resolveProjectIdentity(projectRoot) {
  const project = await canonicalExistingDirectory(projectRoot, "project root");
  const result = await runCommandFile("git", ["-C", project, "rev-parse", "--git-common-dir"], project, 15_000);
  if (result.exitCode === 0 && result.stdout.trim()) {
    const candidate = path.isAbsolute(result.stdout.trim())
      ? result.stdout.trim()
      : path.resolve(project, result.stdout.trim());
    const commonDir = await realpath(candidate).catch(() => path.resolve(candidate));
    return { projectId: stableId("project", commonDir), source: "git_common_dir", identityPath: commonDir };
  }
  return { projectId: stableId("project", project), source: "project_realpath", identityPath: project };
}

/** registry 路径及其当前内容，供诊断与测试使用。 */
async function readWorkspaceRegistry(registryPath) {
  const registry = await readJson(registryPath, null);
  if (!registry) return { schemaVersion: WORKSPACE_REGISTRY_VERSION, projects: {} };
  if (registry.schemaVersion !== WORKSPACE_REGISTRY_VERSION || !registry.projects || typeof registry.projects !== "object" || Array.isArray(registry.projects)) {
    throw new Error("workspace registry is invalid");
  }
  return registry;
}

/**
 * 读取外置治理仓库的验证注册表。连接后的计划导入必须使用这里返回的
 * planDefaults，并把 registry digest 与双仓 revision 固化为任务证据。
 */
export async function loadGovernanceVerificationDefaults(projectRoot) {
  const context = getBoundWorkspaceContext(projectRoot);
  if (!context || context.mode !== "external") return null;
  const registryPath = path.resolve(context.governanceRoot, context.governanceContract.verificationRegistry);
  assertPathInside(context.governanceRoot, registryPath, "verificationRegistry");
  const registry = await readJson(registryPath, null);
  if (!registry) throw new Error(`external governance verification registry is missing: ${registryPath}`);
  if (registry.kind !== "verification_registry" || registry.schemaVersion !== 1) {
    throw new Error("external governance verification registry must be kind=verification_registry schemaVersion=1");
  }
  const { digest, ...unsigned } = registry;
  const actualDigest = digestCanonical(unsigned);
  if (typeof digest !== "string" || digest !== actualDigest) {
    throw new Error("external governance verification registry digest mismatch");
  }
  const planDefaults = registry.planDefaults || {};
  for (const field of ["verify_commands", "standards_commands", "review_commands"]) {
    if (!Array.isArray(planDefaults[field]) || planDefaults[field].some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error(`external governance verification registry ${field} must be an array of commands`);
    }
  }
  const [projectRevision, governanceRevision] = await Promise.all([
    inspectGitRevision(context.projectRoot),
    inspectGitRevision(context.governanceRoot),
  ]);
  if (governanceRevision.available && governanceRevision.clean !== true) {
    throw new Error("external governance repository has uncommitted changes; commit or revert them before importing a project plan");
  }
  return {
    registryPath,
    registryRelativePath: context.governanceContract.verificationRegistry,
    registryDigest: digest,
    planDefaults: {
      verify_commands: [...planDefaults.verify_commands],
      standards_commands: [...planDefaults.standards_commands],
      review_commands: [...planDefaults.review_commands],
    },
    projectRevision,
    governanceRevision,
  };
}

async function prepareExternalConnection(projectRoot, options) {
  const project = await canonicalExistingDirectory(projectRoot, "project root");
  const governance = await loadGovernanceContract(requiredText(options.governanceRoot, "governance root"));
  assertSeparateRoot(project, governance.root, "governance root");
  const identity = await resolveProjectIdentity(project);
  const stateHome = path.resolve(options.stateHome || defaultWildArrangeStateHome(options.env));
  const runtimeRoot = path.resolve(options.runtimeRoot || path.join(stateHome, "projects", identity.projectId, "runtime"));
  assertSeparateRoot(project, runtimeRoot, "runtime root");
  assertSeparateRoot(governance.root, runtimeRoot, "runtime root");
  return {
    project,
    governance,
    identity,
    stateHome,
    runtimeRoot,
    registryPath: path.join(stateHome, "registry.json"),
  };
}

async function commitExternalConnection(candidate) {
  const registry = await readWorkspaceRegistry(candidate.registryPath);
  const entry = {
    projectId: candidate.identity.projectId,
    projectRoot: candidate.project,
    projectIdentitySource: candidate.identity.source,
    governanceId: stableId("governance", candidate.governance.root),
    governanceRoot: candidate.governance.root,
    runtimeRoot: candidate.runtimeRoot,
    contractPath: candidate.governance.path,
    attachedAt: new Date().toISOString(),
  };
  registry.projects[candidate.identity.projectId] = entry;
  await mkdir(candidate.stateHome, { recursive: true });
  await writeJsonAtomic(candidate.registryPath, registry);
  return bindWorkspaceContext(workspaceContext(entry, candidate.governance.contract, candidate.registryPath, "external"));
}

function workspaceContextView(context) {
  return {
    mode: context.mode,
    projectId: context.projectId,
    governanceId: context.governanceId,
    projectRoot: context.projectRoot,
    governanceRoot: context.governanceRoot,
    runtimeRoot: context.runtimeRoot,
    registryPath: context.registryPath,
  };
}

async function inspectGitRevision(rootDir) {
  const topLevel = await runCommandFile("git", ["-C", rootDir, "rev-parse", "--show-toplevel"], rootDir, 15_000);
  if (topLevel.exitCode !== 0) return { available: false, sha: null, clean: null };
  const [rootReal, topLevelReal] = await Promise.all([
    realpath(rootDir).catch(() => path.resolve(rootDir)),
    realpath(topLevel.stdout.trim()).catch(() => path.resolve(topLevel.stdout.trim())),
  ]);
  if (normalizeForComparison(rootReal) !== normalizeForComparison(topLevelReal)) {
    return { available: false, sha: null, clean: null, reason: "root is not the Git toplevel" };
  }
  const head = await runCommandFile("git", ["-C", rootDir, "rev-parse", "HEAD"], rootDir, 15_000);
  if (head.exitCode !== 0) return { available: false, sha: null, clean: null };
  const status = await runCommandFile("git", ["-C", rootDir, "status", "--porcelain"], rootDir, 15_000);
  return {
    available: status.exitCode === 0,
    sha: head.stdout.trim(),
    clean: status.exitCode === 0 ? status.stdout.trim().length === 0 : null,
  };
}

function workspaceContext(entry, contract, registryPath, mode) {
  return {
    mode,
    attached: mode === "external",
    projectRoot: entry.projectRoot,
    governanceRoot: entry.governanceRoot,
    runtimeRoot: path.resolve(entry.runtimeRoot),
    projectId: entry.projectId,
    governanceId: entry.governanceId,
    projectIdentitySource: entry.projectIdentitySource,
    governanceContract: contract,
    governanceContractPath: entry.contractPath,
    registryPath,
    attachedAt: entry.attachedAt,
  };
}

async function canonicalExistingDirectory(value, label) {
  const absolute = path.resolve(requiredText(value, label));
  if (!existsSync(absolute)) throw new Error(`${label} does not exist: ${absolute}`);
  return realpath(absolute);
}

function assertSeparateRoot(containerRoot, candidateRoot, label) {
  const container = path.resolve(containerRoot);
  const candidate = path.resolve(candidateRoot);
  if (pathIsInside(container, candidate) || pathIsInside(candidate, container)) {
    throw new Error(`${label} must be separate from ${container}`);
  }
}

function assertPathInside(rootDir, candidate, label) {
  if (!pathIsInside(rootDir, candidate)) throw new Error(`${label} escapes the governance repository`);
}

function pathIsInside(rootDir, candidate) {
  const root = normalizeForComparison(path.resolve(rootDir));
  const target = normalizeForComparison(path.resolve(candidate));
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function normalizeForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) throw new Error(`${label} must be a relative path`);
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error(`${label} escapes the governance repository`);
  return normalized.split(path.sep).join("/");
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function stableId(kind, value) {
  return `${kind}_${createHash("sha256").update(normalizeForComparison(value)).digest("hex").slice(0, 24)}`;
}
