/**
 * Adoption Dashboard panel: ViewModel, HTML/JS and write-API input checks.
 * Interface does not import capabilities or apply patches itself.
 */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  applyApprovedCards,
  cancelAdoption,
  decideAdoptionCard,
  isSensitiveAdoptionCard,
  loadAdoptionViewModel,
  recoverAdoption,
  reconcileAdoption,
} from "../orchestration/adoption.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { evaluateRegistryFreshness, readLocator, readVerificationInventory } from "../infra/verification-registry.mjs";
import { readJson } from "../infra/runtime-store.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GOVERNANCE_EXCLUDES = new Set([".git", ".wildarrange", "node_modules", ".tmp", "dist", "build", "coverage"]);
const GOVERNANCE_GROUPS = [
  { id: "gates", label: "质量门", title: "交付检查链", description: "测试、改动范围、独立复核、验收证明和完成入账。" },
  { id: "tests", label: "自动测试", title: "行为与边界测试", description: "项目测试、静态检查及其真实执行入口。" },
  { id: "product", label: "产品文档", title: "目标与使用说明", description: "产品概念、开发计划和使用说明。" },
  { id: "architecture", label: "架构", title: "模块与依赖地图", description: "模块职责、依赖关系和产品总图。" },
  { id: "rules", label: "项目规范", title: "Agent 行动边界", description: "根规范和各目录就近生效的维护约定。" },
  { id: "automation", label: "自动化入口", title: "宿主、CI 与 Hook", description: "宿主适配器、持续集成和自动拦截入口。" },
];
const GOVERNANCE_LEDGERS = [
  { id: "registry", label: "门单", title: "检查规则", description: "交付前必须经过哪些测试、复核和质量门。", locatorKey: "registryPath" },
  { id: "bootstrap", label: "测试单", title: "执行基线", description: "这些检查以哪个版本、哪套配置为准。", locatorKey: "bootstrapPath" },
  { id: "inventory", label: "资产单", title: "治理资产", description: "项目当前使用、归档、删除或暂缓的治理内容。", locatorKey: "inventoryPath" },
];

export const ADOPTION_NAV_BUTTON = `<button data-view="adoption" data-label="项目治理"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 7h16M4 12h10M4 17h7"/><path d="M16 14l3 3 5-6"/></svg><span>项目治理</span></button>`;

export const ADOPTION_VIEW_HTML = `
        <div class="view" data-view-panel="adoption">
          <h1 class="section-title">项目治理</h1>
          <p class="section-intro">集中查看这个项目靠哪些规则、文档和自动检查保持可维护。这里只展示状态，不代替 GitHub 的最终权限操作。</p>
          <div class="section-kicker">治理总账</div>
          <div class="governance-ledger-grid" id="governanceLedgers"><span class="muted">正在读取治理总账</span></div>
          <div class="section-kicker">项目文件</div>
          <div class="governance-grid" id="governanceGrid" style="margin-bottom:18px"><span class="muted">正在读取治理文件</span></div>
          <section id="governancePreview" hidden><div class="panel-head"><div><div class="eyebrow" id="previewGroup">文件预览</div><h2 id="previewPath"></h2></div><button id="copyGovernancePath">复制路径</button></div><pre id="previewContent"></pre></section>
          <section id="governanceCleanup" hidden>
            <div class="panel-head">
              <div>
                <div class="eyebrow">治理问题整理</div>
                <h2 id="adoptionSessionTitle">治理问题待处理</h2>
                <p id="adoptionNext" class="muted">这里仅在发现重复、过期或冲突的治理资产时出现。</p>
              </div>
              <div class="form-row">
                <button id="adoptionApply">执行已批准项</button>
                <button id="adoptionReconcile">对账</button>
                <button id="adoptionCancel">取消会话</button>
              </div>
            </div>
            <div id="adoptionSummary" class="muted">正在读取</div>
          </section>
          <div id="adoptionCards" class="stack" style="margin-top:18px"></div>
        </div>
`;

export const ADOPTION_SCRIPT = `
    const ADOPTION_SENSITIVE = new Set(["merge", "delete", "archive"]);
    let governancePreviewPath = "";
    async function getJson(url) {
      const response = await dashboardFetch(url, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) throw new Error(payload.error || "Adoption failed");
      return payload;
    }
    async function loadAdoption() {
      const payload = await getJson("/api/adoption/session");
      renderAdoption(payload);
      return payload;
    }
    async function loadGovernanceFiles() {
      const payload = await getJson("/api/adoption/governance");
      el("governanceLedgers").innerHTML = payload.ledgers.map(function (ledger) {
        const stateClass = ledger.exists ? (ledger.stale ? "warn" : "ok") : "muted";
        const stateText = ledger.exists ? (ledger.stale ? "需要更新" : "已建立") : "尚未建立";
        const action = ledger.path ? '<button data-governance-file="' + esc(ledger.path) + '">查看内容</button>' : '<span class="muted">接管后自动生成</span>';
        return '<section><div class="ledger-card-head"><div><div class="eyebrow">' + esc(ledger.label) + '</div><h2>' + esc(ledger.title) + '</h2></div><span class="badge ' + stateClass + '">' + stateText + '</span></div><p class="muted">' + esc(ledger.description) + '</p><strong class="ledger-count">' + esc(ledger.summary) + '</strong><div class="ledger-card-foot">' + action + '</div></section>';
      }).join("");
      el("governanceGrid").innerHTML = payload.groups.map(function (group) {
        const files = group.files.map(function (file) {
          return '<button class="governance-file" data-governance-file="' + esc(file.path) + '"><code>' + esc(file.path) + '</code><span>' + Math.max(1, Math.round(file.sizeBytes / 1024)) + ' KB</span></button>';
        }).join("");
        return '<section><div class="eyebrow">' + esc(group.label) + '</div><h2>' + esc(group.title) + '</h2><p class="muted">' + esc(group.description) + '</p><button data-governance-group="' + esc(group.id) + '">' + group.files.length + ' 个文件</button><div class="governance-file-list" data-governance-list="' + esc(group.id) + '" hidden>' + (files || '<span class="muted">暂无文件</span>') + '</div></section>';
      }).join("");
    }
    async function openGovernanceFile(filePath) {
      const payload = await getJson("/api/adoption/file?path=" + encodeURIComponent(filePath));
      governancePreviewPath = payload.file.path;
      el("previewPath").textContent = payload.file.path;
      el("previewGroup").textContent = "只读文件预览";
      el("previewContent").textContent = payload.file.content;
      el("governancePreview").hidden = false;
      el("governancePreview").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    el("governanceLedgers").addEventListener("click", async function (event) {
      const fileButton = event.target.closest("button[data-governance-file]");
      if (fileButton) await openGovernanceFile(fileButton.dataset.governanceFile);
    });
    el("governanceGrid").addEventListener("click", async function (event) {
      const groupButton = event.target.closest("button[data-governance-group]");
      if (groupButton) {
        const list = el("governanceGrid").querySelector('[data-governance-list="' + groupButton.dataset.governanceGroup + '"]');
        if (list) list.hidden = !list.hidden;
        return;
      }
      const fileButton = event.target.closest("button[data-governance-file]");
      if (!fileButton) return;
      await openGovernanceFile(fileButton.dataset.governanceFile);
    });
    el("copyGovernancePath").addEventListener("click", async function () {
      if (!governancePreviewPath) return;
      await navigator.clipboard.writeText(governancePreviewPath);
      el("copyGovernancePath").textContent = "已复制";
    });
    function renderAdoption(payload) {
      const session = payload.session;
      const cleanup = el("governanceCleanup");
      if (cleanup) cleanup.hidden = !session;
      el("adoptionSessionTitle").textContent = session ? ("治理整理 · " + session.status) : "治理问题待处理";
      el("adoptionNext").textContent = session?.nextAction || "这里仅在发现治理问题时出现";
      el("adoptionSummary").textContent = session
        ? "待决策 " + (payload.pending || 0) + " · 已批准 " + (payload.approved || 0) + " · 过期 " + (payload.stale || 0)
        : "当前没有需要整理的治理问题";
      if (session) {
        el("adoptionSummary").textContent += " | scanned " + (session.scannedAt || "unknown")
          + " | HEAD " + (session.scanHeadSha || "non-git")
          + " | WIP " + ((session.scanWipPaths || []).length)
          + " | fingerprint " + (session.universeFingerprint || "missing");
      }
      const host = el("adoptionCards");
      host.innerHTML = "";
      for (const card of payload.cards || []) {
        const article = document.createElement("article");
        article.className = "task-card";
        const sensitive = ADOPTION_SENSITIVE.has(card.action) || /AGENTS\\.md|package\\.json|wildarrange\\.config\\.json/i.test(card.path || "") || (Array.isArray(card.verify) && card.verify.length > 0);
        const unknown = (card.consumers || []).some((item) => item.grade === "unknown") || card.confidence === "unknown";
        const canDecide = session && (session.status === "reviewing" || session.status === "needs_review");
        const actions = canDecide ? [
          '<button data-adopt-decision="approved" data-card="' + card.id + '">批准</button>',
          '<button data-adopt-decision="rejected" data-card="' + card.id + '">拒绝</button>',
          '<button data-adopt-decision="deferred" data-card="' + card.id + '">暂缓</button>',
        ] : [];
        const explanation = explainCard(card);
        const details = Object.entries(explanation).map(([label, value]) => {
          const shown = Array.isArray(value)
            ? (value.length ? value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("；") : "无")
            : (value || "无");
          return '<div style="margin-top:10px"><strong>' + esc(label) + '</strong><div class="muted" style="margin-top:4px;white-space:pre-wrap">' + esc(shown) + '</div></div>';
        }).join("");
        const heading = actionName(card.action) + " · " + statusName(card.status) + (sensitive ? " · 需要单独确认" : "");
        if (unknown && (card.action === "merge" || card.action === "delete" || card.action === "archive")) {
          article.innerHTML = '<div><span class="badge warn">证据不足</span><h3>' + esc(heading) + '</h3><p>当前只保留原样，不提供归档、合并或删除。</p>' + details + '</div>';
        } else {
          article.innerHTML = '<div><span class="badge">' + esc(card.id) + '</span><h3>' + esc(heading) + '</h3>' + details + (actions.length ? '<div class="form-row" style="margin-top:14px">' + actions.join("") + '</div>' : '') + '</div>';
        }
        host.appendChild(article);
      }
      const nextApproved = (payload.cards || []).find((card) => card.status === "approved" && !card.appliedAt);
      const apply = el("adoptionApply");
      if (apply) apply.disabled = !session || (payload.pending || 0) > 0 || !nextApproved || !["ready", "applying"].includes(session.status);
      const reconcile = el("adoptionReconcile");
      if (reconcile) reconcile.disabled = !session || !["awaiting_registry_commit", "awaiting_final_commit", "recovery_required"].includes(session.status);
      const cancel = el("adoptionCancel");
      const hasAppliedChanges = (payload.cards || []).some((card) => card.appliedAt);
      if (cancel) cancel.disabled = !session || hasAppliedChanges || ["applying", "recovery_required", "awaiting_registry_commit", "awaiting_final_commit", "finalized", "cancelled"].includes(session.status);
      host.querySelectorAll("[data-adopt-decision]").forEach((button) => {
        button.addEventListener("click", async () => {
          const card = (payload.cards || []).find((item) => item.id === button.dataset.card);
          await postJson("/api/adoption/decision", {
            sessionId: payload.session.sessionId,
            cardId: card.id,
            decision: button.dataset.adoptDecision,
            fingerprint: card.fingerprint,
          });
          await loadAdoption();
        });
      });
    }
    function explainCard(card) {
      return {
        是什么: card.asset + " @ " + card.path,
        作用: card.purpose,
        谁在使用: card.consumers,
        为什么: card.reason,
        完成后怎样: card.afterState,
        最大后果: card.maxConsequence,
        恢复方法: card.rollback,
        证据: card.evidence,
        映射损失: card.mappingLoss,
        验证: card.verify,
      };
    }
    function actionName(value) {
      return ({ adopt: "新增登记", change: "修改接入", merge: "合并重复项", archive: "归档", delete: "删除", defer: "暂缓" })[value] || value || "未知动作";
    }
    function statusName(value) {
      return ({ pending: "等待判断", approved: "已批准", rejected: "已拒绝", deferred: "已暂缓", applied: "已执行", stale: "证据已变化" })[value] || value || "未知状态";
    }
    document.getElementById("adoptionApply")?.addEventListener("click", async () => {
      const current = await getJson("/api/adoption/session");
      if (!current.session) return;
      if ((current.pending || 0) > 0) {
        el("adoptionNext").textContent = "先判完 " + current.pending + " 张卡";
        return;
      }
      const next = (current.cards || []).find((card) => card.status === "approved" && !card.appliedAt);
      if (!next) return;
      try {
        await postJson("/api/adoption/apply", { sessionId: current.session.sessionId, cardId: next.id });
        await loadAdoption();
      } catch (error) {
        el("adoptionNext").textContent = error instanceof Error ? error.message : String(error);
      }
    });
    document.getElementById("adoptionReconcile")?.addEventListener("click", async () => {
      const current = await getJson("/api/adoption/session");
      const endpoint = current.session?.status === "recovery_required" ? "/api/adoption/recover" : "/api/adoption/reconcile";
      await postJson(endpoint, { sessionId: current.session?.sessionId });
      await loadAdoption();
    });
    document.getElementById("adoptionCancel")?.addEventListener("click", async () => {
      const current = await getJson("/api/adoption/session");
      if (!current.session) return;
      await postJson("/api/adoption/cancel", { sessionId: current.session.sessionId });
      await loadAdoption();
    });
    if (location.hash.startsWith("#adoption")) {
      document.querySelectorAll("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === "adoption"));
      document.querySelectorAll(".nav [data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === "adoption"));
    }
    loadGovernanceFiles().catch((error) => {
      el("governanceGrid").textContent = error instanceof Error ? error.message : String(error);
    });
    loadAdoption().catch((error) => {
      const next = document.getElementById("adoptionNext");
      if (next) next.textContent = error instanceof Error ? error.message : String(error);
    });
`;

export async function buildGovernanceFileIndex(rootDir) {
  const files = await listProjectFiles(rootDir);
  const configResult = await loadWildArrangeConfig(rootDir).catch(() => ({ config: {} }));
  const locator = readLocator(configResult.config);
  const freshness = await evaluateRegistryFreshness(rootDir, { config: configResult.config });
  const registry = locator.registryPath ? await readJson(path.join(rootDir, locator.registryPath), null) : null;
  const bootstrap = locator.bootstrapPath ? await readJson(path.join(rootDir, locator.bootstrapPath), null) : null;
  const inventory = locator.inventoryPath ? await readVerificationInventory(path.join(rootDir, locator.inventoryPath), null) : null;
  const values = { registry, bootstrap, inventory };
  const ledgers = GOVERNANCE_LEDGERS.map((ledger) => {
    const value = values[ledger.id];
    return {
      id: ledger.id,
      label: ledger.label,
      title: ledger.title,
      description: ledger.description,
      path: locator[ledger.locatorKey] || null,
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

function governanceGroupFor(relativePath) {
  const value = String(relativePath || "").replaceAll("\\", "/");
  if (/verification-(registry|bootstrap)\.json$|verification-inventory\.(json|html)$/i.test(value)) return "gates";
  if (/(^|\/)AGENTS\.md$/i.test(value)) return "rules";
  if (/^(doc\/project-architecture\.md|docs\/product\/architecture-overview\.html|tooling\/arch-module-graph\/)/i.test(value)) return "architecture";
  if (/^(test\/|tests\/|package\.json$)|\.(test|spec)\.[cm]?[jt]s$/i.test(value)) return "tests";
  if (/^(wildarrange\.config\.json|src\/capabilities\/(verify|scope-guard|review-gate|acceptance-proof|checkpoint)\.mjs)$/i.test(value)) return "gates";
  if (/^(README(?:\.en)?\.md|doc\/.*\.(md|html))$/i.test(value)) return "product";
  if (/^(\.github\/workflows\/|\.cursor\/|\.codex\/|\.kimi-code\/|src\/interface\/.*(?:adapter|hook).*\.mjs$)/i.test(value)) return "automation";
  return null;
}

async function readGovernancePreview(rootDir, requestedPath) {
  const relative = String(requestedPath || "").replaceAll("\\", "/");
  if (!governanceGroupFor(relative)) throw Object.assign(new Error("该文件不属于项目治理范围"), { code: "invalid_path" });
  const root = path.resolve(rootDir);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error("文件路径超出项目范围"), { code: "invalid_path" });
  const actual = await realpath(absolute);
  if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) throw Object.assign(new Error("文件真实路径超出项目范围"), { code: "invalid_path" });
  const info = await stat(actual);
  if (!info.isFile()) throw Object.assign(new Error("目标不是文件"), { code: "invalid_path" });
  if (info.size > 512_000) throw Object.assign(new Error("文件过大，请复制路径后使用编辑器打开"), { code: "file_too_large" });
  return { path: relative, content: await readFile(actual, "utf8"), sizeBytes: info.size, updatedAt: info.mtime.toISOString() };
}

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
      if (result?.status === "single_card_required") {
        sendJson(response, 400, { ok: false, error: result.nextAction || "一次只 Apply 一张卡", status: "single_card_required" });
        return true;
      }
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

export function describeAdoptionCard(card) {
  return {
    id: card.id,
    sensitive: isSensitiveAdoptionCard(card),
    allowsDangerous: !((card.consumers || []).some((item) => item.grade === "unknown") || card.confidence === "unknown"),
  };
}

function validateId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    const error = new Error(`invalid ${label}`);
    error.code = "invalid_id";
    throw error;
  }
}

function validOptionalId(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  validateId(value, label);
  return value;
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      bodyBytes += chunk.length;
      if (bodyBytes > 64_000) {
        settled = true;
        reject(Object.assign(new Error("request body too large"), { code: "payload_too_large" }));
        return;
      }
      body += chunk.toString();
    });
    request.on("end", () => {
      if (settled) return;
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("invalid json"), { code: "invalid_json" }));
      }
    });
    request.on("error", reject);
  });
}
