/**
 * Adoption Dashboard panel: ViewModel, HTML/JS and write-API input checks.
 * Interface does not import capabilities or apply patches itself.
 */
import {
  applyApprovedCards,
  cancelAdoption,
  decideAdoptionCard,
  isSensitiveAdoptionCard,
  loadAdoptionViewModel,
  recoverAdoption,
  reconcileAdoption,
} from "../orchestration/adoption.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const ADOPTION_NAV_BUTTON = `<button data-view="adoption" data-label="验证接管"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 7h16M4 12h10M4 17h7"/><path d="M16 14l3 3 5-6"/></svg><span>验证接管</span></button>`;

export const ADOPTION_VIEW_HTML = `
        <div class="view" data-view-panel="adoption">
          <h1 class="section-title">验证治理接管</h1>
          <p class="section-intro">每张卡说明资产是什么、谁在用、为什么处理、完成后怎样、最大后果和恢复方法。签字只在本页进行。</p>
          <section>
            <div class="panel-head">
              <div>
                <div class="eyebrow">会话</div>
                <h2 id="adoptionSessionTitle">没有进行中的接管</h2>
                <p id="adoptionNext" class="muted">需要时运行 <code>wildarrange adoption start</code>。</p>
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
    function renderAdoption(payload) {
      const session = payload.session;
      el("adoptionSessionTitle").textContent = session ? (session.sessionId + " · " + session.status) : "没有进行中的接管";
      el("adoptionNext").textContent = payload.nextAction || session?.nextAction || "需要时运行 wildarrange adoption start";
      el("adoptionSummary").textContent = session
        ? "待决策 " + (payload.pending || 0) + " · 已批准 " + (payload.approved || 0) + " · 过期 " + (payload.stale || 0)
        : "当前没有 adoption 会话";
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
    loadAdoption().catch((error) => {
      const next = document.getElementById("adoptionNext");
      if (next) next.textContent = error instanceof Error ? error.message : String(error);
    });
`;

export async function tryHandleAdoptionApi(request, response, url, rootDir) {
  if (!url.pathname.startsWith("/api/adoption/")) return false;
  try {
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
      : ["card_stale", "sensitive_card", "invalid_decision", "invalid_id", "invalid_json"].includes(error?.code)
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
