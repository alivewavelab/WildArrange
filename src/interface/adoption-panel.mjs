// =============================================================================
// 文件名称：adoption-panel.mjs
// 所属模块：interface
// 作用说明：
//   Adoption（项目治理接管）Dashboard 面板：治理文件索引、会话卡片 UI 与 /api/adoption/* 路由。
//   写操作委托 orchestration/adoption；本模块不直接 apply 补丁或改 capabilities。
//
// 【运行原理速读】
//   可以把它想成「老项目治理接管的 Web 前台」：
//
//   · 谁调用？
//     dashboard.mjs 委托 tryHandleAdoptionApi；前端片段见 adoption-panel-view.mjs。
//
//   · 它做了什么？
//     ① buildGovernanceFileIndex 扫描并分组治理文件 ② 只读预览与决策/apply API
//     ③ 前端脚本逐卡批准、单卡 apply、reconcile/recover。
//
//   · 安全边界？
//     文件预览限 512KB、路径必须在项目内且属于治理分组；敏感卡需额外确认。
// =============================================================================
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { applyApprovedCards } from "../orchestration/adoption-apply.mjs";
import {
  cancelAdoption,
  decideAdoptionCard,
  loadAdoptionViewModel,
  recoverAdoption,
  reconcileAdoption,
} from "../orchestration/adoption.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { evaluateRegistryFreshness, readLocator, readVerificationInventory } from "../infra/verification-registry.mjs";
import { readJson, resolveGovernancePaths } from "../infra/runtime-store.mjs";
import { SAFE_ID, readJsonBody, sendJson } from "./http-utils.mjs";

// --- 治理文件分组常量 ---

/** 治理文件索引扫描时跳过的目录名。 */
const GOVERNANCE_EXCLUDES = new Set([".git", "node_modules", ".tmp", "dist", "build", "coverage"]);
/** 治理文件 UI 分组定义（id/label/描述）。 */
const GOVERNANCE_GROUPS = [
  { id: "gates", label: "质量门", title: "交付检查链", description: "测试、改动范围、独立复核、验收证明和完成入账。" },
  { id: "tests", label: "自动测试", title: "行为与边界测试", description: "项目测试、静态检查及其真实执行入口。" },
  { id: "product", label: "产品文档", title: "目标与使用说明", description: "产品概念、开发计划和使用说明。" },
  { id: "architecture", label: "架构", title: "模块与依赖地图", description: "模块职责、依赖关系和产品总图。" },
  { id: "rules", label: "项目规范", title: "Agent 行动边界", description: "根规范和各目录就近生效的维护约定。" },
  { id: "automation", label: "自动化入口", title: "宿主、CI 与 Hook", description: "宿主适配器、持续集成和自动拦截入口。" },
];
/** 验证治理三台账（registry/bootstrap/inventory）在面板中的展示元数据。 */
const GOVERNANCE_LEDGERS = [
  { id: "registry", label: "门单", title: "检查规则", description: "交付前必须经过哪些测试、复核和质量门。", locatorKey: "registryPath" },
  { id: "bootstrap", label: "测试单", title: "执行基线", description: "这些检查以哪个版本、哪套配置为准。", locatorKey: "bootstrapPath" },
  { id: "inventory", label: "资产单", title: "治理资产", description: "项目当前使用、归档、删除或暂缓的治理内容。", locatorKey: "inventoryPath" },
];

// --- 治理文件索引 ---

/** 扫描项目治理相关文件并按 gates/tests/product 等分组，附带 registry 三账 freshness。 */
export async function buildGovernanceFileIndex(rootDir) {
  const files = await listProjectFiles(rootDir);
  const configResult = await loadWildArrangeConfig(rootDir).catch(() => ({ config: {} }));
  const locator = readLocator(configResult.config);
  const governance = resolveGovernancePaths(rootDir);
  const freshness = await evaluateRegistryFreshness(rootDir, { config: configResult.config });
  const registry = locator.registryPath ? await readJson(path.join(governance.rootDir, locator.registryPath), null) : null;
  const bootstrap = locator.bootstrapPath ? await readJson(path.join(governance.rootDir, locator.bootstrapPath), null) : null;
  const inventory = locator.inventoryPath ? await readVerificationInventory(path.join(governance.rootDir, locator.inventoryPath), null) : null;
  const values = { registry, bootstrap, inventory };
  const ledgers = GOVERNANCE_LEDGERS.map((ledger) => {
    const value = values[ledger.id];
    return {
      id: ledger.id,
      label: ledger.label,
      title: ledger.title,
      description: ledger.description,
      path: locator[ledger.locatorKey] ? (governance.registryPath ? "governance/" : "") + locator[ledger.locatorKey] : null,
      exists: Boolean(value),
      stale: Boolean(value) && freshness.stale === true,
      summary: governanceLedgerSummary(ledger.id, value),
    };
  });
  const groups = GOVERNANCE_GROUPS.map((group) => ({
    ...group,
    files: files.filter((file) => governanceGroupFor(file.path) === group.id),
  }));
  return { kind: "wildarrange_governance_files", freshness, ledgers, groups };
}

/** 按 registry/bootstrap/inventory 类型生成治理总账卡片的人类可读摘要。 */
function governanceLedgerSummary(id, value) {
  if (!value) return "0 项";
  if (id === "registry") {
    const commands = Object.values(value.planDefaults || {}).flat().length;
    return `${commands + (value.runtimeGates || []).length + (value.hostHooks || []).length} 条规则`;
  }
  if (id === "bootstrap") return value.baselineRef ? "1 个执行基线" : "基线待确认";
  const views = value.views || {};
  const count = Object.values(views).reduce((total, items) => total + (Array.isArray(items) ? items.length : 0), 0);
  return `${count} 项资产`;
}

/** 递归扫描项目根，收集属于治理分组的文件路径与体积（排除 node_modules 等）。 */
async function listProjectFiles(rootDir) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (GOVERNANCE_EXCLUDES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(rootDir, absolute).replaceAll("\\", "/");
      if (!governanceGroupFor(relative)) continue;
      const info = await stat(absolute);
      result.push({ path: relative, sizeBytes: info.size, updatedAt: info.mtime.toISOString() });
    }
  }
  await visit(rootDir);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

/** 按路径模式将相对路径映射到 gates/tests/product 等治理分组 id；不匹配返回 null。 */
function governanceGroupFor(relativePath) {
  const value = String(relativePath || "").replaceAll("\\", "/");
  if (/verification-(registry|bootstrap)\.json$|verification-inventory\.(json|html)$/i.test(value)) return "gates";
  if (/(^|\/)AGENTS\.md$/i.test(value)) return "rules";
  if (/^(doc\/project-architecture\.md|docs\/product\/architecture-overview\.html)/i.test(value)) return "architecture";
  if (/^(test\/|tests\/|package\.json$)|\.(test|spec)\.[cm]?[jt]s$/i.test(value)) return "tests";
  if (/^(wildarrange\.config\.json|src\/capabilities\/(verify|scope-guard|review-gate|acceptance-proof|checkpoint)\.mjs)$/i.test(value)) return "gates";
  if (/^(README(?:\.en)?\.md|doc\/.*\.(md|html))$/i.test(value)) return "product";
  if (/^(\.github\/workflows\/|\.cursor\/|\.codex\/|\.kimi-code\/|src\/interface\/.*(?:adapter|hook).*\.mjs$)/i.test(value)) return "automation";
  return null;
}

// --- 只读预览 ---

/** 只读读取治理文件预览；校验分组归属、路径逃逸与 512KB 体积上限。 */
async function readGovernancePreview(rootDir, requestedPath) {
  let relative = String(requestedPath || "").replaceAll("\\", "/");
  const governance = resolveGovernancePaths(rootDir);
  let externalArtifact = false;
  if (governance.registryPath && relative.startsWith("governance/")) {
    const locator = readLocator((await loadWildArrangeConfig(rootDir)).config);
    relative = relative.slice("governance/".length);
    externalArtifact = [locator.registryPath, locator.bootstrapPath, locator.inventoryPath].includes(relative);
    if (!externalArtifact) throw Object.assign(new Error("未登记的治理文件"), { code: "invalid_path" });
    rootDir = governance.rootDir;
  }
  if (!externalArtifact && !governanceGroupFor(relative)) throw Object.assign(new Error("该文件不属于项目治理范围"), { code: "invalid_path" });
  const root = path.resolve(rootDir);
  const absolute = path.resolve(root, relative);
  // 符号链接解析前：拒绝 .. 或绝对路径逃出项目根。
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error("文件路径超出项目范围"), { code: "invalid_path" });
  const actual = await realpath(absolute);
  // realpath 后再次校验，防止软链指向项目外。
  if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error("文件真实路径超出项目范围"), { code: "invalid_path" });
  const info = await stat(actual);
  if (!info.isFile()) throw Object.assign(new Error("目标不是文件"), { code: "invalid_path" });
  if (info.size > 512_000) throw Object.assign(new Error("文件过大，请复制路径后使用编辑器打开"), { code: "file_too_large" });
  return { path: relative, content: await readFile(actual, "utf8"), sizeBytes: info.size, updatedAt: info.mtime.toISOString() };
}

// --- Adoption HTTP API ---

/**
 * 处理 /api/adoption/* 请求；非 adoption 路径返回 false 由 dashboard 继续路由。
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {URL} url
 * @param {string} rootDir
 * @returns {Promise<boolean>} 已处理为 true，否则 false
 */
export async function tryHandleAdoptionApi(request, response, url, rootDir) {
  if (!url.pathname.startsWith("/api/adoption/")) return false;
  try {
    if (request.method === "GET" && url.pathname === "/api/adoption/governance") {
      sendJson(response, 200, { ok: true, ...(await buildGovernanceFileIndex(rootDir)) });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/adoption/file") {
      sendJson(response, 200, { ok: true, file: await readGovernancePreview(rootDir, url.searchParams.get("path")) });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/adoption/session") {
      sendJson(response, 200, await loadAdoptionViewModel(rootDir, {
        sessionId: validOptionalId(url.searchParams.get("session"), "sessionId"),
      }));
      return true;
    }
    // 写操作统一 POST；GET 之外的非 POST 方法直接 405。
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    const body = await readJsonBody(request);
    const sessionId = validOptionalId(body.sessionId, "sessionId");
    if (url.pathname === "/api/adoption/decision") {
      validateId(body.cardId, "cardId");
      const result = await decideAdoptionCard(rootDir, {
        sessionId,
        cardId: body.cardId,
        decision: body.decision,
        fingerprint: body.fingerprint,
        decisions: body.decisions,
      });
      sendJson(response, 200, { ok: true, result });
      return true;
    }
    if (url.pathname === "/api/adoption/apply") {
      if (Array.isArray(body.cardIds) && body.cardIds.length !== 1) {
        sendJson(response, 400, { ok: false, error: "一次只 Apply 一张卡", status: "single_card_required" });
        return true;
      }
      const cardId = body.cardId || (Array.isArray(body.cardIds) ? body.cardIds[0] : undefined);
      if (!cardId) {
        sendJson(response, 400, { ok: false, error: "一次只 Apply 一张卡", status: "single_card_required" });
        return true;
      }
      validateId(cardId, "cardId");
      const result = await applyApprovedCards(rootDir, { sessionId, cardId });
      // orchestration 层拒绝批量 apply：接口层映射为 400 而非 409。
      if (result?.status === "single_card_required") {
        sendJson(response, 400, { ok: false, error: result.nextAction || "一次只 Apply 一张卡", status: "single_card_required" });
        return true;
      }
      // 会话状态不允许 apply（仍有 pending、applying 等）→ 409 冲突。
      if (result?.ok === false) {
        sendJson(response, 409, {
          ok: false,
          error: result.nextAction || result.status,
          status: result.status,
          pending: result.pending,
        });
        return true;
      }
      sendJson(response, 200, { ok: true, result });
      return true;
    }
    if (url.pathname === "/api/adoption/reconcile") {
      const result = await reconcileAdoption(rootDir, { sessionId });
      sendJson(response, 200, { ok: true, result });
      return true;
    }
    if (url.pathname === "/api/adoption/recover") {
      const result = await recoverAdoption(rootDir, { sessionId });
      // recover 失败表示事务仍卡在 recovery_required，HTTP 409 提示前端继续对账而非重试 apply。
      sendJson(response, result.ok === false ? 409 : 200, { ok: result.ok !== false, result, error: result.error });
      return true;
    }
    if (url.pathname === "/api/adoption/cancel") {
      const result = await cancelAdoption(rootDir, { sessionId });
      sendJson(response, 200, { ok: true, result });
      return true;
    }
    sendJson(response, 404, { ok: false, error: "not_found" });
    return true;
  } catch (error) {
    // 按 orchestration 抛出的 error.code 映射 HTTP 状态：413 体积、400 参数、409 会话冲突、500 未知。
    const status = error?.code === "payload_too_large"
      ? 413
      : error?.code === "file_too_large"
        ? 413
        : ["card_stale", "sensitive_card", "invalid_decision", "invalid_id", "invalid_json", "invalid_path"].includes(error?.code)
        ? 400
        : ["session_not_reviewable", "session_not_applicable", "session_applying", "applied_changes_exist", "recovery_required", "recovery_not_required"].includes(error?.code)
          ? 409
          : 500;
    sendJson(response, status, { ok: false, error: error instanceof Error ? error.message : String(error), code: error?.code || null });
    return true;
  }
}

/** 校验 sessionId/cardId 等必填 id；不合法时抛 code=invalid_id。 */
function validateId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    const error = new Error(`invalid ${label}`);
    error.code = "invalid_id";
    throw error;
  }
}

/** 可选 id：空值返回 undefined，有值则走 validateId。 */
function validOptionalId(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  validateId(value, label);
  return value;
}
