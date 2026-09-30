// =============================================================================
// 文件名称：adoption-git-reconcile.mjs
// 所属模块：orchestration
// 作用说明：
//   adoption 的 Git 对账：commit A（批准前 HEAD）/ B（应用后）锚点、卡片实时快照、产物 digest 与 appliedEffects 校验。
// =============================================================================
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { invokeCapability } from "../capabilities/gateway.mjs";
import { resolveGovernancePaths } from "../infra/runtime-store.mjs";
import * as verificationRegistry from "../infra/verification-registry.mjs";
import { digestCanonical, digestGitComparableContent, fingerprintCard, gitTreeContains } from "../infra/verification-registry.mjs";
import { readGitHead } from "../infra/git-diff.mjs";

/** 捕获 Dashboard 批准卡片的实时指纹快照。 */
export async function captureLiveApprovalSnapshot(rootDir, card) {
  const envelope = await invokeCapability("verification-governance-card-snapshot", { rootDir, options: { card } });
  if (envelope.error) throw new Error(envelope.error.message || "verification card snapshot failed");
  const snapshot = envelope.evidence;
  return {
    ...snapshot,
    headSha: await captureProjectHeadSha(rootDir),
  };
}

/** 读取当前 Git HEAD SHA 作为 adoption 锚点 A。 */
export async function captureProjectHeadSha(rootDir) {
  if (!existsSync(path.join(rootDir, ".git"))) return null;
  const head = await readGitHead(rootDir).catch(() => ({ available: false, sha: null }));
  return head.available ? head.sha : null;
}

/** 计算批准卡内容指纹，用于与快照比对。 */
export function fingerprintLiveCard(card) {
  const clone = JSON.parse(JSON.stringify({ ...card, fingerprint: "" }));
  delete clone.status;
  return fingerprintCard(clone);
}

/** 比较 expected/actual 批准快照是否一致。 */
export function snapshotsMatch(expected, actual) {
  if (!expected || !actual) return false;
  if (expected.targetDigest !== actual.targetDigest) return false;
  if (expected.evidenceDigest !== actual.evidenceDigest) return false;
  if ((expected.headSha || null) !== (actual.headSha || null)) return false;
  const left = expected.dependencyDigests || {};
  const right = actual.dependencyDigests || {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/** 计算项目内相对路径文件的 UTF-8 内容哈希。 */
async function fileUtf8Digest(rootDir, relativePath) {
  if (!relativePath) return null;
  const absolutePath = path.join(resolveGovernancePaths(rootDir).rootDir, relativePath);
  if (!existsSync(absolutePath)) return null;
  try {
    return digestGitComparableContent(await readFile(absolutePath));
  } catch (error) {
    if (["EISDIR", "ENOENT", "EACCES", "EPERM"].includes(error?.code)) return null;
    throw error;
  }
}

/** 从 artifact 错误映射 recovery 下一步提示。 */
export function artifactFailureNextAction(error, fallback) {
  return error?.next_action || error?.nextAction || fallback;
}

/** 采集本轮写入制品的路径与 digest 列表。 */
export async function captureWrittenArtifactDigests(rootDir, session, locator = {}) {
  const registryDigest = await fileUtf8Digest(rootDir, locator.registryPath);
  if (registryDigest) session.registryDigest = registryDigest;
  const bootstrapDigest = await fileUtf8Digest(rootDir, locator.bootstrapPath);
  if (bootstrapDigest) session.bootstrapDigest = bootstrapDigest;
  const inventoryDigest = await fileUtf8Digest(rootDir, locator.inventoryPath);
  if (inventoryDigest) session.inventoryDigest = inventoryDigest;
  const locatorFile = session.locatorFile || resolveGovernancePaths(rootDir).configPath;
  const locatorDigest = await fileUtf8Digest(rootDir, locatorFile);
  if (locatorDigest) {
    session.locatorDigest = locatorDigest;
    session.locatorFile = locatorFile;
  }
}

/** 将会话内制品 digest 持久化到 inventory。 */
export async function rememberArtifactDigests(rootDir, session, locator = {}) {
  if (!session.registryDigest) {
    const digest = await fileUtf8Digest(rootDir, locator.registryPath);
    if (digest) session.registryDigest = digest;
  }
  if (!session.bootstrapDigest) {
    const digest = await fileUtf8Digest(rootDir, locator.bootstrapPath);
    if (digest) session.bootstrapDigest = digest;
  }
  if (!session.inventoryDigest) {
    const digest = await fileUtf8Digest(rootDir, locator.inventoryPath);
    if (digest) session.inventoryDigest = digest;
  }
  if (!session.locatorDigest) {
    const locatorFile = session.locatorFile || resolveGovernancePaths(rootDir).configPath;
    const digest = await fileUtf8Digest(rootDir, locatorFile);
    if (digest) {
      session.locatorDigest = digest;
      session.locatorFile = locatorFile;
    }
  }
}

/** 在会话 appliedEffects 中记录单卡 postimage。 */
export function recordAppliedEffect(session, cardId, postimage = []) {
  const paths = (postimage || []).map((item) => ({
    path: item.path,
    repositoryTarget: item.repositoryTarget || "project",
    digest: item.gitDigest || item.digest,
    presence: item.digest === "missing" ? "absent" : "present",
  }));
  const rest = (session.appliedEffects || []).filter((item) => item.cardId !== cardId);
  session.appliedEffects = [...rest, { cardId, paths }];
}

/** 按当前 HEAD 刷新 locator 对应 appliedEffect。 */
export async function refreshLocatorAppliedEffect(rootDir, session) {
  const locatorFile = session.locatorFile || resolveGovernancePaths(rootDir).configPath;
  const digest = session.locatorDigest || await fileUtf8Digest(rootDir, locatorFile);
  if (!digest) return;
  for (const effect of session.appliedEffects || []) {
    for (const entry of effect.paths || []) {
      if ((entry.repositoryTarget === "governance" || resolveGovernancePaths(rootDir).rootDir === rootDir) && normalizeAdoptionPath(entry.path) === normalizeAdoptionPath(locatorFile)) {
        entry.digest = digest;
        entry.presence = "present";
      }
    }
  }
}

/** 校验 appliedEffects 是否与给定 HEAD 一致。 */
export async function appliedEffectsMatchHead(rootDir, session, headSha) {
  if (!headSha) return false;
  const projectHead = resolveGovernancePaths(rootDir).rootDir === rootDir ? headSha : (await readGitHead(rootDir)).sha;
  for (const effect of session.appliedEffects || []) {
    for (const entry of effect.paths || []) {
      if (!entry?.path) continue;
      const targetRoot = entry.repositoryTarget === "governance" ? resolveGovernancePaths(rootDir).rootDir : rootDir;
      const targetHead = entry.repositoryTarget === "governance" ? headSha : projectHead;
      if (entry.presence === "absent") {
        if (await gitTreeContains(targetRoot, entry.path, targetHead)) return false;
        continue;
      }
      const match = await gitBlobDigestEqualsIfAvailable(targetRoot, entry.path, targetHead, entry.digest);
      if (match !== true) return false;
    }
  }
  return true;
}

/** 检查 inventory 内嵌 digest 声明自洽。 */
export function inventoryDigestSelfConsistent(inventory) {
  if (!inventory || typeof inventory !== "object" || !inventory.digest) return false;
  const { digest: _digest, ...rest } = inventory;
  return inventory.digest === digestCanonical(rest);
}

/** 归一化 adoption 涉及的相对路径。 */
function normalizeAdoptionPath(relativePath) {
  return String(relativePath || "").replaceAll("\\", "/");
}

/** 若 Git 可用则比对 blob digest 与期望值。 */
export async function gitBlobDigestEqualsIfAvailable(rootDir, relativePath, ref, expectedDigest) {
  const compare = verificationRegistry.gitBlobDigestEquals;
  if (typeof compare !== "function") return null;
  if (!relativePath || !ref || !expectedDigest) return false;
  return compare(rootDir, relativePath, ref, expectedDigest);
}

/** 将 mismatch diagnostics 格式化为人类可读标签列表。 */
export function mismatchLabels(diagnostics) {
  return Object.entries(diagnostics || {})
    .filter(([key, value]) => !["phase", "gitAvailable"].includes(key) && value !== "matched")
    .map(([key]) => key);
}
