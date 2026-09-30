// =============================================================================
// 文件名称：workspace-context.mjs
// 所属模块：infra
// 作用说明：
//   解析客户项目根、独立治理仓库根与本机运行态根；维护外部项目连接表。
//
// 【运行原理速读】
//   project identity → external registry → validated three-root context
//   → bindWildArrangeRuntimeRoot。未连接项目没有运行态，解析结果为 null。
// =============================================================================
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommandFile } from "./command-runner.mjs";
import { buildArmedConfig } from "./runtime-config.mjs";
import { buildRegistryFromCards, digestCanonical } from "./verification-registry.mjs";
import {
  bindWildArrangeRuntimeRoot,
  readJson,
  writeJsonAtomic,
} from "./runtime-store.mjs";

const WORKSPACE_REGISTRY_VERSION = 1;
const GOVERNANCE_CONTRACT_FILE = "wildarrange-governance.json";
const BOUND_CONTEXTS = new Map();
/** 治理仓 policy/ 下补建的政策模板：source 为 linear pack project-init 内文件，target 为 policy 相对路径。 */
const POLICY_TEMPLATE_DIR = fileURLToPath(new URL("../../packs/wildarrange-linear/project-init/", import.meta.url));
const POLICY_TEMPLATES = [
  { source: "AGENTS.template.md", target: "AGENTS.md" },
  { source: "code-and-interface-conventions.md", target: "code-and-interface-conventions.md" },
  { source: "testing-and-acceptance.md", target: "testing-and-acceptance.md" },
];

/**
 * 在独立目录创建最小治理仓库骨架；只创建缺失文件，不覆盖已有政策。
 * options.scaffoldConfig：额外生成 policy/wildarrange.config.json（默认武装质量门）。
 * options.initGit：治理目录还不是 Git 仓时 git init 并提交初始 commit（已是 Git 仓则跳过）。
 */
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
    ...await Promise.all(POLICY_TEMPLATES.map(async (template) => ({
      path: path.join(governanceRoot, "policy", template.target),
      value: await readFile(path.join(POLICY_TEMPLATE_DIR, template.source), "utf8"),
    }))),
    {
      path: path.join(governanceRoot, "verification", "registry.json"),
      value: `${JSON.stringify(buildRegistryFromCards([]), null, 2)}\n`,
    },
    ...(options.scaffoldConfig === true ? [{
      path: path.join(governanceRoot, "policy", "wildarrange.config.json"),
      value: `${JSON.stringify(buildArmedConfig(), null, 2)}\n`,
    }] : []),
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
  const git = options.initGit === true ? await ensureGovernanceGitRepository(governanceRoot, options.defaultBranch) : null;
  return {
    kind: "governance_repository_initialized",
    governanceRoot,
    created,
    preserved,
    gitInitialized: git?.initialized === true,
    ...(git ? { git } : {}),
    attached: false,
  };
}

/** 治理目录不是 Git 仓时 git init 并提交初始 commit；已是 Git 仓则不动它。 */
async function ensureGovernanceGitRepository(governanceRoot, defaultBranch) {
  if (existsSync(path.join(governanceRoot, ".git"))) return { initialized: false, skipped: "already_a_git_repository" };
  const run = async (args) => {
    const result = await runCommandFile("git", ["-C", governanceRoot, ...args], governanceRoot, 30_000);
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed in governance repository: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  await run(["init", "-q", "-b", defaultBranch || "main"]);
  await run(["add", "-A"]);
  // 用户没配 Git 身份时用产品占位身份，避免初始提交在新机器上失败
  const identity = [];
  for (const [key, fallback] of [["user.name", "WildArrange"], ["user.email", "wildarrange@localhost"]]) {
    const configured = await runCommandFile("git", ["-C", governanceRoot, "config", key], governanceRoot, 15_000);
    if (configured.exitCode !== 0 || !configured.stdout.trim()) identity.push("-c", `${key}=${fallback}`);
  }
  await run([...identity, "commit", "-q", "-m", "chore: initialize WildArrange governance repository"]);
  return { initialized: true, head: await run(["rev-parse", "HEAD"]) };
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
  return commitExternalConnection(candidate);
}

/** 解析项目当前三根；项目尚未连接外置治理时返回 null（调用方决定报错或静默）。 */
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

  const entry = registry.projects[identity.projectId];
  if (!entry) return null;

  const governance = await loadGovernanceContract(entry.governanceRoot);
  assertSeparateRoot(project, governance.root, "governance root");
  assertSeparateRoot(project, entry.runtimeRoot, "runtime root");
  assertSeparateRoot(governance.root, entry.runtimeRoot, "runtime root");
  // linked worktree 与主 checkout 共用 git common-dir，因此共享 projectId 与
  // runtime；但本次命令的 projectRoot 必须保持当前 worktree，而非首次 attach 路径。
  return bindWorkspaceContext(workspaceContext({ ...entry, projectRoot: project }, governance.contract, registryPath));
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
  bindWildArrangeRuntimeRoot(projectRoot, context.runtimeRoot, {
    rootDir: context.governanceRoot,
    configPath: path.posix.join(context.governanceContract.policyRoot, "wildarrange.config.json"),
    registryPath: context.governanceContract.verificationRegistry,
  });
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
  if (target === "governance" && context?.governanceRoot) {
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
  if (!context) return null;
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
  if (!governanceRevision.available) {
    // 治理仓没有 Git HEAD 时，双仓绑定要到验收末端才失败并白耗一次尝试；这里提前拦截并给出下一步
    throw new Error(`external governance repository has no Git HEAD (${context.governanceRoot}); run \`git -C "${context.governanceRoot}" init && git -C "${context.governanceRoot}" add -A && git -C "${context.governanceRoot}" commit -m init\`, then import the plan again`);
  }
  if (governanceRevision.clean !== true) {
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
  return bindWorkspaceContext(workspaceContext(entry, candidate.governance.contract, candidate.registryPath));
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

function workspaceContext(entry, contract, registryPath) {
  return {
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
