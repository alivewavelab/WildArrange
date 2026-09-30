// =============================================================================
// 文件名称：adoption-panel-view.mjs
// 所属模块：interface
// 作用说明：
//   Adoption（项目治理接管）面板的前端片段：侧栏导航按钮、主视图 HTML 与内嵌浏览器脚本。
//   纯字符串常量，由 dashboard-view.mjs 嵌入整页；对应的 /api/adoption/* 后端见 adoption-panel.mjs。
// =============================================================================

/** Dashboard 侧栏「项目治理 / 审批 / 归档」导航按钮 HTML 片段。 */
export const ADOPTION_NAV_BUTTON = `<button data-view="adoption" data-label="项目治理"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 7h16M4 12h10M4 17h7"/><path d="M16 14l3 3 5-6"/></svg><span>项目治理</span></button>
        <button class="nav-subitem" data-view="approvals" data-label="审批"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 4h14v16H5z"/><path d="M8 9l2 2 5-5M8 15h8"/></svg><span>审批</span><span class="nav-count" id="approvalNavCount" hidden>0</span></button>
        <button class="nav-subitem" data-view="archives" data-label="归档"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 7h16v13H4zM3 4h18v3H3z"/><path d="M9 11h6"/></svg><span>归档</span></button>`;

/** Adoption 主视图 HTML（治理总账、文件网格、整理会话与卡片列表）。 */
export const ADOPTION_VIEW_HTML = `
        <div class="view" data-view-panel="adoption">
          <h1 class="section-title">项目治理</h1>
          <p class="section-intro">集中查看这个项目靠哪些规则、文档和自动检查保持可维护。这里只展示状态，不代替 GitHub 的最终权限操作。</p>
          <div class="section-kicker">治理总账</div>
          <div class="governance-ledger-grid" id="governanceLedgers"><span class="muted">正在读取治理总账</span></div>
          <div class="section-kicker">项目文件</div>
          <div class="governance-grid" id="governanceGrid" style="margin-bottom:18px"><span class="muted">正在读取治理文件</span></div>
          <section id="governancePreview" hidden><div class="panel-head"><div><div class="eyebrow" id="previewGroup">文件预览</div><h2 id="previewPath"></h2></div><button id="copyGovernancePath">复制路径</button></div><pre id="previewContent"></pre></section>
        </div>
        <div class="view" data-view-panel="approvals">
          <h1 class="section-title">审批</h1>
          <p class="section-intro">旧项目初始化时，系统只扫描并提出建议，不会静默收录、归档或删除。你可以选择批准当前建议、不采用，或者暂缓决定。</p>
          <div class="approval-tabs" role="tablist" aria-label="审批状态">
            <button class="approval-tab active" data-adoption-filter="pending" role="tab" aria-selected="true">待处理 <span id="approvalPendingCount">0</span></button>
            <button class="approval-tab" data-adoption-filter="approved" role="tab" aria-selected="false">已批准 <span id="approvalApprovedCount">0</span></button>
          </div>
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
          <div id="adoptionCards" class="approval-groups" style="margin-top:18px"></div>
        </div>
        <div class="view" data-view-panel="archives">
          <h1 class="section-title">归档</h1>
          <p class="section-intro">查找已经退出日常入口的治理资产、删除记录，以及暂缓或拒绝的历史判断。这里复用资产单，只读展示，不产生另一套记录。</p>
          <div class="archive-toolbar">
            <label for="archiveSearch">搜索历史记录</label>
            <input id="archiveSearch" type="search" placeholder="输入文件路径、作用或原因">
            <span class="muted" id="archiveCount">0 项</span>
          </div>
          <div id="archiveList" class="archive-list"><span class="muted">正在读取归档</span></div>
        </div>
`;

/** Adoption 面板客户端脚本（内嵌于 dashboard-view，不可含反引号）。 */
export const ADOPTION_SCRIPT = `
    const ADOPTION_SENSITIVE = new Set(["merge", "delete", "archive"]);
    const APPROVAL_GROUPS = [
      { id: "ledgers", title: "治理账本", description: "Registry、Bootstrap、Inventory 的定位与登记。", assets: new Set(["config_locator", "verification_registry", "verification_bootstrap", "verification_inventory"]) },
      { id: "runtime", title: "Hook 与运行时质量门", description: "宿主拦截、运行时校验与交付前质量门。", assets: new Set(["host_hook", "runtime_gate"]) },
      { id: "checks", title: "静态检查", description: "格式、类型、架构与独立复核等静态入口。", assets: new Set(["static_check", "independent_review"]) },
      { id: "tests", title: "测试与夹具", description: "行为测试、边界测试以及测试夹具。", assets: new Set(["behavior_suite", "test_fixture"]) },
    ];
    let governancePreviewPath = "";
    let adoptionFilter = "pending";
    let latestAdoptionPayload = null;
    let archiveQuery = "";
    async function getJson(url) {
      const response = await dashboardFetch(url, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) throw new Error(payload.error || "Adoption failed");
      return payload;
    }
    async function loadAdoption() {
      const payload = await getJson("/api/adoption/session");
      renderAdoption(payload);
      renderArchive(payload);
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
      latestAdoptionPayload = payload;
      const session = payload.session;
      const cards = payload.cards || [];
      const approvedCards = cards.filter(function (card) { return card.status === "approved" || card.status === "applied"; });
      const pendingCards = cards.filter(function (card) { return card.status !== "approved" && card.status !== "applied"; });
      el("approvalPendingCount").textContent = pendingCards.length;
      el("approvalApprovedCount").textContent = approvedCards.length;
      const navCount = el("approvalNavCount");
      navCount.textContent = pendingCards.length;
      navCount.hidden = pendingCards.length === 0;
      document.querySelectorAll("[data-adoption-filter]").forEach(function (button) {
        const active = button.dataset.adoptionFilter === adoptionFilter;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
      });
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
      const visibleCards = adoptionFilter === "approved" ? approvedCards : pendingCards;
      if (!visibleCards.length) {
        host.innerHTML = '<section class="approval-empty"><strong>' + (adoptionFilter === "approved" ? "还没有已批准项" : "没有待处理审批") + '</strong><div class="muted">状态变化后会自动归入对应栏目。</div></section>';
      }
      for (const group of approvalGroupsFor(visibleCards)) {
        const section = document.createElement("section");
        section.className = "approval-group";
        const sensitiveCount = group.cards.filter(isSensitiveCard).length;
        const paths = group.cards.slice(0, 3).map(function (card) { return card.path || card.id; }).join("、");
        const more = group.cards.length > 3 ? " 等 " + group.cards.length + " 项" : "";
        section.innerHTML = '<div class="approval-group-head"><div><div class="eyebrow">' + esc(group.title) + '</div><h2>' + group.cards.length + ' 项判断</h2><p class="muted">' + esc(group.description) + '</p></div><span class="badge">' + (sensitiveCount ? sensitiveCount + ' 项需单独确认' : '可逐项处理') + '</span></div><div class="approval-group-paths">' + esc(paths + more) + '</div><details open><summary>收起 / 展开这组判断</summary><div class="approval-items"></div></details>';
        const groupHost = section.querySelector(".approval-items");
        for (const card of group.cards) groupHost.appendChild(renderApprovalCard(card, session));
        host.appendChild(section);
      }
      const nextApproved = cards.find((card) => card.status === "approved" && !card.appliedAt);
      const apply = el("adoptionApply");
      if (apply) apply.disabled = !session || (payload.pending || 0) > 0 || !nextApproved || !["ready", "applying"].includes(session.status);
      const reconcile = el("adoptionReconcile");
      if (reconcile) reconcile.disabled = !session || !["awaiting_registry_commit", "awaiting_final_commit", "recovery_required"].includes(session.status);
      const cancel = el("adoptionCancel");
      const hasAppliedChanges = cards.some((card) => card.appliedAt);
      if (cancel) cancel.disabled = !session || hasAppliedChanges || ["applying", "recovery_required", "awaiting_registry_commit", "awaiting_final_commit", "finalized", "cancelled"].includes(session.status);
      host.querySelectorAll("[data-adopt-decision]").forEach((button) => {
        button.addEventListener("click", async () => {
          const card = cards.find((item) => item.id === button.dataset.card);
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
    function approvalGroupsFor(cards) {
      const grouped = APPROVAL_GROUPS.map(function (definition) { return { ...definition, cards: [] }; });
      for (const card of cards) {
        // 未知或历史类资产仍归入治理账本，确保页面始终只有四个心智入口。
        const group = grouped.find(function (candidate) { return candidate.assets.has(card.asset); }) || grouped[0];
        group.cards.push(card);
      }
      return grouped.filter(function (group) { return group.cards.length > 0; });
    }
    function isSensitiveCard(card) {
      return ADOPTION_SENSITIVE.has(card.action)
        || /AGENTS\\.md|package\\.json|wildarrange\\.config\\.json/i.test(card.path || "")
        || (Array.isArray(card.verify) && card.verify.length > 0);
    }
    function renderApprovalCard(card, session) {
        const article = document.createElement("article");
        article.className = "adoption-card approval-item";
        const sensitive = isSensitiveCard(card);
        const unknown = (card.consumers || []).some((item) => item.grade === "unknown") || card.confidence === "unknown";
        const plain = plainCardCopy(card);
        const canDecide = session && (session.status === "reviewing" || session.status === "needs_review");
        const decisionCopy = decisionLabels(card.action);
        const actions = canDecide ? [
          '<button data-adopt-decision="approved" data-card="' + card.id + '">' + decisionCopy.approve + '</button>',
          '<button data-adopt-decision="rejected" data-card="' + card.id + '">' + decisionCopy.reject + '</button>',
          '<button data-adopt-decision="deferred" data-card="' + card.id + '">暂缓</button>',
          ...(card.status !== "pending" && card.status !== "stale" ? ['<button data-adopt-decision="pending" data-card="' + card.id + '">撤销决定</button>'] : []),
        ] : [];
        const explanation = explainCard(card);
        const details = Object.entries(explanation).map(([label, value]) => {
          const shown = Array.isArray(value)
            ? (value.length ? value.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("；") : "无")
            : (value || "无");
          return '<div class="adoption-detail" style="margin-top:10px"><strong>' + esc(label) + '</strong><div class="muted adoption-detail-value" style="margin-top:4px;white-space:pre-wrap">' + esc(shown) + '</div></div>';
        }).join("");
        const heading = actionName(card.action) + " · " + statusName(card.status) + (sensitive ? " · 需要单独确认" : "");
        if (unknown && (card.action === "merge" || card.action === "delete" || card.action === "archive")) {
          article.innerHTML = '<div class="approval-item-head"><div><span class="badge warn">证据不足</span><h3>' + esc(plain.title) + '</h3><p class="muted"><code>' + esc((card.repositoryTarget === "governance" ? "治理仓库 / " : "") + (card.path || card.id)) + '</code> · ' + esc(heading) + '</p></div></div><p>现在还没查清它是否仍被使用，所以系统只保留原样，不允许归档、合并或删除。</p><div class="approval-item-details">' + details + '</div>';
        } else {
          article.innerHTML = '<div class="approval-item-head"><div><span class="badge">' + esc(actionName(card.action)) + '</span><h3>' + esc(plain.title) + '</h3><p class="muted"><code>' + esc((card.repositoryTarget === "governance" ? "治理仓库 / " : "") + (card.path || card.id)) + '</code> · ' + esc(statusName(card.status) + (sensitive ? " · 需要单独确认" : "")) + '</p></div>' + (actions.length ? '<div class="form-row">' + actions.join("") + '</div>' : '') + '</div><div class="approval-item-details">' + details + '</div>';
        }
        return article;
    }
    function renderArchive(payload) {
      const views = payload.inventory?.views || {};
      const currentCards = payload.cards || [];
      const sections = [
        { title: "历史归档", description: "已退出日常入口，但仍可追溯和恢复。", items: views.historicalArchives || [] },
        { title: "删除记录", description: "保留删除动作、原因与恢复线索。", items: views.deletedTombstones || [] },
        { title: "暂缓与拒绝", description: "没有进入正式治理资产的历史判断。", items: (views.deferredConfirmations || []).concat(currentCards.filter(function (card) { return card.status === "deferred" || card.status === "rejected"; })) },
      ];
      const query = archiveQuery.trim().toLowerCase();
      let total = 0;
      const html = sections.map(function (section) {
        const unique = new Map();
        for (const item of section.items) unique.set(item.id || ((item.action || "") + ":" + (item.path || "")), item);
        const items = Array.from(unique.values()).filter(function (item) {
          return !query || [item.path, item.id, item.purpose, item.reason, item.owner, item.action, item.status].join(" ").toLowerCase().includes(query);
        });
        total += items.length;
        if (!items.length) return "";
        const entries = items.map(function (item) {
          return '<article class="archive-entry"><div><span class="badge">' + esc(actionName(item.action)) + ' · ' + esc(statusName(item.status)) + '</span><h3>' + esc(item.path || item.id || "未命名记录") + '</h3><p class="muted">' + esc(item.purpose || item.reason || "未填写说明") + '</p></div><details><summary>查看记录</summary><dl><dt>原因</dt><dd>' + esc(item.reason || "未说明") + '</dd><dt>完成后</dt><dd>' + esc(item.afterState || "保持原状") + '</dd><dt>恢复方法</dt><dd>' + esc(item.rollback || "无需恢复") + '</dd></dl></details></article>';
        }).join("");
        return '<section class="archive-section"><div class="archive-section-head"><div><div class="eyebrow">' + esc(section.title) + '</div><h2>' + items.length + ' 项</h2></div><p class="muted">' + esc(section.description) + '</p></div><div class="archive-entries">' + entries + '</div></section>';
      }).join("");
      el("archiveCount").textContent = total + " 项";
      el("archiveList").innerHTML = html || '<section class="approval-empty"><strong>' + (query ? "没有匹配记录" : "还没有归档记录") + '</strong><div class="muted">归档、删除、暂缓或拒绝后会自动出现在这里。</div></section>';
    }
    el("archiveSearch").addEventListener("input", function (event) {
      archiveQuery = event.target.value;
      if (latestAdoptionPayload) renderArchive(latestAdoptionPayload);
    });
    document.querySelectorAll("[data-adoption-filter]").forEach(function (button) {
      button.addEventListener("click", function () {
        adoptionFilter = button.dataset.adoptionFilter;
        if (latestAdoptionPayload) renderAdoption(latestAdoptionPayload);
      });
    });
    function explainCard(card) {
      const plain = plainCardCopy(card);
      return {
        这是干什么的: plain.what,
        点批准后: plain.after,
        可能的影响: plain.risk,
        为什么建议这样做: plain.why,
        反悔怎么办: plain.undo,
        "给开发者看的位置和依据": plain.technical,
      };
    }
    function plainCardCopy(card) {
      const filePath = card.path || "未命名文件";
      const command = card.patch?.command || (Array.isArray(card.verify) ? card.verify[0] : "") || "";
      const sources = Array.from(new Set((card.consumers || []).map(function (item) { return item.by; }).filter(Boolean)));
      const technical = ["文件位置：" + filePath];
      if (command) technical.push("相关命令：" + command);
      if (sources.length) technical.push("发现来源：" + sources.join("、"));
      const evidence = (Array.isArray(card.evidence) ? card.evidence : []).filter(function (item) { return typeof item === "string" && item.trim(); });
      if (evidence.length) technical.push("扫描依据：" + evidence.join("；"));

      if (card.action === "archive") return {
        title: "把这份旧资料移到历史归档",
        what: "像把不再日常使用的资料移进档案室：平时不再出现，但以后仍能找到。",
        after: "文件会移到项目的归档目录，并留下可追溯记录。",
        risk: "如果它其实仍在被使用，移动后相关说明或流程可能找不到它；证据不足时系统不会允许执行。",
        why: "扫描发现它已有替代文件，且没有发现仍在使用它的明确证据。",
        undo: card.rollback || "把文件从归档目录移回原位置。",
        technical: technical.join("；"),
      };
      if (card.action === "delete") return {
        title: "删除这份已经确认无用的治理资料",
        what: "移除一份确认不再需要的文件，同时留下删除记录。",
        after: "目标文件会被删除，资产单会记录删除原因和恢复线索。",
        risk: "这是不可忽略的改动；判断错误可能让依赖它的流程失效，因此必须单独确认。",
        why: "扫描判断它已被替代且没有有效使用者。",
        undo: card.rollback || "按删除记录恢复原文件。",
        technical: technical.join("；"),
      };
      if (card.asset === "config_locator") return {
        title: "告诉系统三份治理清单放在哪里",
        what: "像给三本账贴上书架编号：告诉系统“检查规则、执行基线、治理资产清单”以后分别去哪里找。",
        after: "只在配置中增加三个文件位置；不会立刻创建这些清单，也不会启动任何检查。",
        risk: "风险很低，不会改变现有质量门。只有位置写错时，后续系统会找不到对应清单。",
        why: "当前项目还没有登记这三份清单的固定位置，后续无法稳定生成和查找它们。",
        undo: "删除配置里的治理清单位置设置即可恢复。",
        technical: technical.concat("这只是位置配置，不会直接拦截任务").join("；"),
      };
      if (card.asset === "host_hook") {
        const hostName = filePath.startsWith(".codex/") ? "Codex" : filePath.startsWith(".cursor/") ? "Cursor" : "当前工具";
        return {
          title: "登记 " + hostName + " 的操作拦截入口",
          what: "把现有拦截文件记到账本里，方便以后知道“哪个文件负责在操作发生前检查规则”。",
          after: "只新增一条目录记录；不会移动、改写或重新安装这个拦截文件。",
          risk: "风险很低。即使登记说明不够准确，也只影响后续提示，不会改变当前拦截行为。",
          why: "扫描发现了这个拦截入口，但治理清单里还没有它。",
          undo: "从治理清单中移除这条目录记录；原文件保持不变。",
          technical: technical.join("；"),
        };
      }
      if (card.asset === "runtime_gate") return {
        title: "登记项目现有的运行时质量门",
        what: "把项目已经在用的运行时检查记到账本里，避免以后维护时漏掉它。",
        after: "只登记检查入口的位置和用途，不会修改它现在怎么拦截。",
        risk: "风险很低；登记内容不准确时，只会让后续维护建议产生偏差。",
        why: "扫描发现项目已有运行时检查，但治理清单还不知道它在哪里。",
        undo: "从治理清单中移除这条记录；现有质量门保持不变。",
        technical: technical.join("；"),
      };
      if (card.asset === "static_check") return {
        title: "把现有代码检查纳入交付流程",
        what: "让以后完成任务时先跑一次项目已有的代码检查，像交作业前先做格式和结构自检。",
        after: "未来任务交付前会运行“" + (command || "项目代码检查") + "”；这次批准本身不会立即运行命令。",
        risk: "如果这条检查本身不稳定，未来交付会被它挡住；不会直接修改业务代码。",
        why: "项目脚本已经在使用这项检查，但它还没有被正式登记为交付步骤。",
        undo: "从交付检查清单中移除这条命令。",
        technical: technical.join("；"),
      };
      if (card.asset === "behavior_suite") return {
        title: "把这组自动测试纳入交付流程",
        what: "让以后每次交付前都运行项目现有测试，确认主要功能没有被改坏。",
        after: "未来任务交付前会运行“" + (command || "项目测试") + "”；这次批准不会立即执行测试。",
        risk: "测试失败时会阻止任务被标记为完成，这是质量门的正常作用。",
        why: "扫描发现了这组测试，但正式交付清单里还没有登记。",
        undo: "从交付测试清单中移除这条命令；测试文件本身不会被删除。",
        technical: technical.join("；"),
      };
      if (card.asset === "test_fixture") return {
        title: "登记测试使用的模拟工具",
        what: "告诉系统这个文件是测试用的“假对象”，供测试模拟外部程序，不把它当成正式功能或单独测试。",
        after: "只记录它的位置和用途，不复制、不执行、也不修改文件。",
        risk: "风险很低；只增加一条说明记录。",
        why: "以后查看测试资产时，需要知道哪些文件只是测试辅助材料。",
        undo: "移除这条目录记录；原测试文件保持不变。",
        technical: technical.join("；"),
      };
      return {
        title: "处理这项尚未分类的治理内容",
        what: "系统发现它可能与项目质量管理有关，但目前没有足够信息把它归入常见类别。",
        after: "只会执行这张卡明确写出的建议；不会顺带修改其他文件。",
        risk: isSensitiveCard(card) ? "这项操作可能改变或移走文件，因此必须单独确认。" : "没有发现会直接改变项目行为的高风险影响。",
        why: "旧项目扫描发现了这项内容，需要由你决定是否纳入治理。",
        undo: "按这张卡记录的恢复方法撤销；如果没有执行，项目不会发生变化。",
        technical: technical.concat(card.purpose ? "原始用途：" + card.purpose : [], card.reason ? "原始原因：" + card.reason : []).join("；"),
      };
    }
    function decisionLabels(action) {
      if (action === "adopt" || action === "change") return { approve: "批准收录", reject: "不收录" };
      if (action === "archive") return { approve: "批准归档", reject: "不归档" };
      if (action === "delete") return { approve: "批准删除", reject: "不删除" };
      if (action === "merge") return { approve: "批准合并", reject: "不合并" };
      return { approve: "批准建议", reject: "不采用" };
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
    if (location.hash.startsWith("#archives")) switchView("archives");
    else if (location.hash.startsWith("#approvals")) switchView("approvals");
    else if (location.hash.startsWith("#adoption")) switchView("adoption");
    loadGovernanceFiles().catch((error) => {
      el("governanceGrid").textContent = error instanceof Error ? error.message : String(error);
    });
    loadAdoption().catch((error) => {
      const next = document.getElementById("adoptionNext");
      if (next) next.textContent = error instanceof Error ? error.message : String(error);
    });
`;
