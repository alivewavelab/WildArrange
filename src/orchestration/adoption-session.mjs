// =============================================================================
// 文件名称：adoption-session.mjs
// 所属模块：orchestration
// 作用说明：
//   adoption 会话存储：会话/卡片/事务文件读写、锁、活动会话查找与维护标记。
// =============================================================================
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { inspectFileLock, withFileLock } from "../infra/file-lock.mjs";
import { readJson, resolveWildArrangePath, resolveGovernancePaths, writeJsonAtomic } from "../infra/runtime-store.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";
import { adoptionSessionDir, writeMaintenanceMarker } from "../infra/recovery-transaction.mjs";
import { readLocator, readVerificationInventory } from "../infra/verification-registry.mjs";

/** adoption 会话合法状态集合，供 reconcile/transition 校验。 */
const SESSION_STATES = new Set([
  "scanning",
  "reviewing",
  "ready",
  "applying",
  "awaiting_registry_commit",
  "awaiting_final_commit",
  "finalized",
  "needs_review",
  "recovery_required",
  "cancelled",
]);

/** 根据 cardId 生成 adoption resume 子命令提示。 */
export function preparedResumeAction(cardId) {
  return `运行 wildarrange adoption resume 以继续中断的事务 ${cardId}，不要重新 capture`;
}

/** 注册 adoption 维护 marker，阻止并发 wildarrange run。 */
export async function registerMaintenance(rootDir, session, files) {
  await withTaskStateLock(rootDir, `adoption:${session.sessionId}`, async () => {
    const activity = await detectActiveRun(rootDir);
    if (activity) {
      throw adoptionError("active_run", activity.message);
    }
    await writeMaintenanceMarker(rootDir, {
      sessionId: session.sessionId,
      status: "applying",
      cardCount: files.cards.length,
    });
  });
}

/** 检测是否有活跃 linear/parallel run 与 adoption 互斥。 */
async function detectActiveRun(rootDir) {
  const taskState = await loadTaskState(rootDir).catch(() => null);
  const busy = (taskState?.tasks || []).find((task) => ["in_progress", "verifying"].includes(task.status));
  if (busy) return { message: `活动任务 ${busy.id} 处于 ${busy.status}，不能同时接管` };
  const lock = await inspectFileLock(rootDir, resolveWildArrangePath(rootDir, "team", "tasks.lock"));
  if (lock.locked && lock.pidAlive && lock.owner && !String(lock.owner).startsWith("adoption")) {
    return { message: `任务锁由 ${lock.owner} 持有，不能同时接管` };
  }
  return null;
}

/** 在 adoption 文件锁内执行 fn，按 sessionId 串行化写操作。 */
export async function withAdoptionLock(rootDir, sessionId, fn) {
  const lockPath = resolveWildArrangePath(rootDir, "adoption", "adoption.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  return withFileLock(rootDir, lockPath, "adoption lock", `adoption:${sessionId}`, fn, { waitTimeoutMs: 15_000 });
}

/** 查找当前未完成的 adoption 会话指针。 */
export async function findActiveSession(rootDir) {
  const root = resolveWildArrangePath(rootDir, "adoption");
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const sessions = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const session = await readJson(path.join(root, entry.name, "session.json"), null);
    if (session?.sessionId) sessions.push(session);
  }
  sessions.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  return sessions[0] || null;
}

/** 读取 adoption 会话 JSON。 */
export async function loadSession(rootDir, sessionId) {
  if (sessionId) return readJson(path.join(adoptionSessionDir(rootDir, sessionId), "session.json"), null);
  return findActiveSession(rootDir);
}

/** 加载会话，不存在时抛 adoption 错误。 */
export async function requiredSession(rootDir, sessionId) {
  const session = await loadSession(rootDir, sessionId);
  if (!session) throw adoptionError("no_session", "没有可操作的 adoption 会话");
  return session;
}

/** 读取会话目录下 cards/transactions 等附属文件。 */
export async function readSessionFiles(rootDir, sessionId) {
  const dir = adoptionSessionDir(rootDir, sessionId);
  const session = await readJson(path.join(dir, "session.json"), null);
  const cards = (await readJson(path.join(dir, "cards.json"), { cards: [] })).cards || [];
  const approvals = (await readJson(path.join(dir, "approvals.json"), { approvals: {} })).approvals || {};
  const scan = await readJson(path.join(dir, "scan.json"), null);
  const inventory = session?.locator?.inventoryPath
    ? await readVerificationInventory(path.join(resolveGovernancePaths(rootDir).rootDir, session.locator.inventoryPath), null)
    : null;
  const transactions = {};
  let txnEntries = [];
  try {
    txnEntries = await readdir(path.join(dir, "transactions"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const cardId of txnEntries) {
    transactions[cardId] = await readJson(path.join(dir, "transactions", cardId, "manifest.json"), null);
  }
  return { session, cards, approvals, scan, transactions, inventory };
}

/** 原子写入 adoption 会话附属文件集合。 */
export async function writeSessionFiles(rootDir, session, files = {}) {
  if (!SESSION_STATES.has(session.status)) throw adoptionError("invalid_status", `invalid session status ${session.status}`);
  const dir = adoptionSessionDir(rootDir, session.sessionId);
  await writeJsonAtomic(path.join(dir, "session.json"), session);
  if (files.cards) await writeJsonAtomic(path.join(dir, "cards.json"), { cards: files.cards });
  if (files.approvals) await writeJsonAtomic(path.join(dir, "approvals.json"), { approvals: files.approvals });
  if (files.scan) await writeJsonAtomic(path.join(dir, "scan.json"), files.scan);
}

/** 从 cards 中取首张 approved 卡片的定位信息。 */
export function takeApprovedLocator(cards) {
  const card = (cards || []).find((item) => item.asset === "config_locator" && item.status === "approved" && item.patch?.value?.verificationGovernance);
  return card?.patch?.value?.verificationGovernance || null;
}

/** 返回建议下一张待处理卡片的定位信息。 */
export function suggestedLocator(cards) {
  const card = (cards || []).find((item) => item.asset === "config_locator" && item.patch?.value?.verificationGovernance);
  return card?.patch?.value?.verificationGovernance || readLocator({});
}

/** 在 transactions 列表中按 status 查找条目。 */
export function findTransaction(transactions, status) {
  for (const [cardId, txn] of Object.entries(transactions || {})) {
    if (txn?.status === status) return { cardId, txn };
  }
  return null;
}

/** 构造带 code 的 adoption 专用 Error。 */
export function adoptionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
