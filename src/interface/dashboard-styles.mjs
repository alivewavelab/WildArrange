// =============================================================================
// 文件名称：dashboard-styles.mjs
// 所属模块：interface
// 作用说明：
//   Dashboard 单页的全部 CSS（纯字符串常量，无插值）。由 dashboard-view.mjs 放入 <style>。
// =============================================================================

/** Dashboard 整页样式表（不含 <style> 标签；不可含反引号与 ${}）。 */
export const DASHBOARD_CSS = `
    :root {
      --ink: #17211d; --muted: #65706a; --paper: #f4f0e7; --panel: #fffdf7;
      --forest: #173d32; --forest-2: #245647; --mint: #bfe6cf; --signal: #ff6b42;
      --gold: #e8b85c; --line: rgba(23,33,29,.13); --good: #278052; --bad: #b43b2f;
      --warn: #a96c12; --shadow: 0 18px 58px rgba(36,44,38,.1); --radius: 20px;
    }
    * { box-sizing: border-box; }
    html { background: var(--paper); }
    body { margin: 0; min-width: 320px; overflow-x:hidden; color: var(--ink); background: radial-gradient(circle at 74% 9%, rgba(232,184,92,.18), transparent 30rem), var(--paper); font: 14px/1.55 "PingFang SC", "Hiragino Sans GB", sans-serif; -webkit-font-smoothing: antialiased; }
    button, input, textarea { font: inherit; }
    button { color: inherit; }
    .app { display: grid; grid-template-columns: 242px minmax(0,1fr); min-height: 100vh; }
    .rail { position: sticky; top: 0; height: 100vh; padding: 28px 22px; color: #eef7f0; background: linear-gradient(rgba(255,255,255,.026) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.026) 1px,transparent 1px),var(--forest); background-size: 22px 22px; overflow: hidden; }
    .rail::after { content: ""; position: absolute; width: 190px; height: 190px; right: -92px; bottom: 82px; border: 1px solid rgba(191,230,207,.2); border-radius: 50%; box-shadow: 0 0 0 24px rgba(191,230,207,.025),0 0 0 48px rgba(191,230,207,.025); }
    .brand { display: flex; align-items: center; gap: 12px; height:52px; margin-bottom: 34px; overflow:hidden; }
    .brand-wordmark { display:block; width:172px; height:52px; object-fit:cover; object-position:center; }
    .mark { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 13px; color: var(--forest); background: var(--mint); font: 800 20px/1 "Iowan Old Style",Georgia,serif; transform: rotate(-5deg); }
    .brand strong { display: block; font: 700 17px/1.1 "Iowan Old Style",Georgia,serif; }
    .brand small { display: block; margin-top: 4px; color: #a9c6b7; font-size: 10px; letter-spacing: .14em; }
    .nav-label,.eyebrow { color: #91b2a2; font-size: 10px; font-weight: 700; letter-spacing: .17em; text-transform: uppercase; }
    .nav { display: grid; gap: 8px; margin-top: 13px; }
    .nav button { display: flex; align-items: center; gap: 11px; width: 100%; padding: 11px 12px; border: 0; border-radius: 12px; color: #bcd0c6; background: transparent; text-align: left; cursor: pointer; transition: .2s ease; }
    .nav button:hover { color: #fff; background: rgba(255,255,255,.06); transform: translateX(2px); }
    .nav button.active { color: #fff; background: rgba(191,230,207,.13); box-shadow: inset 0 0 0 1px rgba(191,230,207,.12); }
    .nav button.nav-subitem { margin-top:-6px; padding-left:41px; font-size:12px; }
    .nav-count { display:inline-grid; place-items:center; min-width:20px; height:20px; margin-left:auto; padding:0 6px; color:#171715; background:var(--mint); font-size:10px; font-weight:900; }
    .nav svg { width: 18px; height: 18px; stroke-width: 1.8; }
    .rail-foot { position: absolute; left: 22px; right: 22px; bottom: 24px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.1); color: #a9c6b7; font-size: 11px; }
    .rail-foot i,.server-dot { display: inline-block; width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: #68d59e; box-shadow: 0 0 0 5px rgba(104,213,158,.1); }
    .shell { min-width: 0; }
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 24px clamp(24px,4vw,64px) 0; }
    .crumb { color: var(--muted); font-size: 12px; }
    .crumb b { color: var(--ink); }
    .top-actions { display: flex; align-items: center; gap: 9px; }
    .status-pill { display: flex; align-items: center; padding: 8px 12px; border: 1px solid var(--line); border-radius: 99px; background: rgba(255,253,247,.68); font-size: 11px; }
    main { padding: 30px clamp(24px,4vw,64px) 64px; }
    .view { display: none; }
    .view.active { display: block; animation: rise .38s both; }
    .hero { display: grid; grid-template-columns: minmax(0,1.35fr) minmax(250px,.65fr); gap: 28px; align-items: end; margin-bottom: 30px; }
    h1 { max-width: 780px; margin: 8px 0 12px; font: 700 clamp(34px,4.2vw,62px)/1.04 "Songti SC","STSong",serif; letter-spacing: -.045em; }
    .hero p { max-width: 680px; margin: 0; color: var(--muted); line-height: 1.8; }
    .hero-stamp { justify-self: end; width: min(100%,320px); padding: 20px 22px; border: 1px solid var(--line); border-radius: var(--radius); background: rgba(255,253,247,.68); box-shadow: 0 12px 38px rgba(62,72,65,.06); }
    .hero-stamp strong { display: block; margin: 5px 0 3px; font: 700 31px/1 "Iowan Old Style",Georgia,serif; }
    .hero-stamp small { color: var(--muted); }
    .pipeline { display: grid; grid-template-columns: repeat(4,1fr); gap: 7px; padding: 18px 20px; margin-bottom: 22px; border-radius: var(--radius); color: #fff; background: var(--forest); box-shadow: var(--shadow); }
    .step { position: relative; min-width: 0; padding: 9px 8px 8px; opacity: .48; }
    .step:not(:last-child)::after { content:""; position:absolute; top:18px; right:-7px; width:14px; height:1px; background:rgba(255,255,255,.22); }
    .step-head { display:flex; align-items:center; gap:8px; margin-bottom:9px; }
    .dot { width:9px; height:9px; border:2px solid #6e8d7f; border-radius:50%; }
    .step.done,.step.active { opacity: 1; }
    .step.done .dot { border-color:var(--mint); background:var(--mint); box-shadow:0 0 0 5px rgba(191,230,207,.1); }
    .step.active .dot { border-color:var(--gold); background:var(--gold); box-shadow:0 0 0 5px rgba(232,184,92,.13); }
    .step b { display:block; overflow:hidden; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
    .step small { color:#9ab7a8; font-size:9px; letter-spacing:.05em; }
    .dashboard-grid { display:grid; grid-template-columns:minmax(0,1.42fr) minmax(280px,.58fr); gap:22px; align-items:start; }
    .stack { display:grid; gap:22px; }
    section,.metric { border:1px solid var(--line); border-radius:var(--radius); background:rgba(255,253,247,.88); box-shadow:0 14px 46px rgba(52,61,55,.06); }
    section { padding:20px 22px; }
    .panel-head { display:flex; align-items:center; justify-content:space-between; gap:14px; margin-bottom:14px; }
    h2 { margin:0; font:700 19px/1.2 "Songti SC","STSong",serif; }
    h3 { margin:0 0 10px; font-size:13px; }
    .label { color:var(--muted); font-size:11px; }
    .value { margin-top:3px; font:700 25px/1 "Iowan Old Style",Georgia,serif; }
    .metrics { display:grid; grid-template-columns:repeat(4,minmax(100px,1fr)); gap:10px; margin-bottom:22px; }
    .metric { padding:14px; box-shadow:none; }
    .task-list { display:grid; gap:1px; margin:0 -22px -20px; }
    .task-card { display:grid; grid-template-columns:52px minmax(0,1fr) auto; gap:15px; align-items:center; padding:18px 22px; border-top:1px solid var(--line); background:transparent; }
    .task-id { display:grid; place-items:center; width:45px; height:45px; border:1px solid var(--line); border-radius:14px; color:var(--forest); background:#eef3ec; font:700 12px/1 "Iowan Old Style",Georgia,serif; }
    .task-title { margin-bottom:5px; font-weight:700; }
    .task-meta { color:var(--muted); font-size:11px; }
    .pill,.status-badge { display:inline-flex; align-items:center; padding:4px 8px; border-radius:99px; color:var(--forest-2); background:#e5f3e9; font-size:10px; font-weight:700; }
    .task-detail { grid-column:2/-1; display:none; padding:12px 0 2px; }
    .task-card.expanded .task-detail { display:block; }
    .workspace-list { display:grid; border-top:1px solid var(--line); }
    .workspace-row { display:grid; grid-template-columns:minmax(130px,.8fr) minmax(180px,1.2fr) minmax(180px,1fr) auto; gap:14px; align-items:center; padding:13px 0; border-bottom:1px solid var(--line); }
    .workspace-row:last-child { border-bottom:0; }
    .workspace-row code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .workspace-empty { padding:18px 0 4px; color:var(--muted); }
    .workspace-chip { color:var(--signal); font-size:10px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .attention-panel { color:#fff; background:var(--signal); border:0; }
    .attention-panel h2 { margin:8px 0 7px; font-size:21px; }
    .attention-panel .muted { color:rgba(255,255,255,.78); }
    .attention-panel .eyebrow { color:rgba(255,255,255,.7); }
    .attention-panel button { width:100%; margin-top:15px; color:var(--signal); background:#fff; border-color:#fff; font-weight:800; }
    .health-row { display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-top:1px solid var(--line); font-size:11px; }
    .health-row:first-child { border-top:0; }
    .health-row b { color:var(--good); }
    .grid { display:grid; gap:14px; }
    .two { grid-template-columns:minmax(0,1.35fr) minmax(300px,.65fr); align-items:start; }
    .ops { grid-template-columns:repeat(2,minmax(220px,1fr)); }
    .op-block { min-width:0; padding:15px; border:1px solid var(--line); border-radius:15px; background:#f8f5ed; }
    .label { color: var(--muted); font-size: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 9px 8px; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 12px; }
    code,pre,textarea { font-family:"SFMono-Regular",Menlo,Consolas,monospace; }
    .completed { color: var(--good); }
    .failed { color: var(--bad); }
    .draft, .pending, .verifying, .in_progress, .review_blocked, .needs_user_decision { color: var(--warn); }
    .muted { color: var(--muted); }
    pre { margin:0; overflow:auto; white-space:pre-wrap; word-break:break-word; padding:12px; max-height:460px; border-radius:12px; background:#eef0ea; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .notice { min-height: 20px; color: var(--muted); font-size: 12px; }
    .form-row { display: flex; gap: 8px; margin-bottom: 8px; }
    input,textarea,select { width:100%; min-width:0; padding:9px 10px; border:1px solid var(--line); border-radius:10px; color:var(--ink); background:#fff; }
    textarea { min-height:92px; resize:vertical; font-size:12px; }
    button { padding:8px 11px; border:1px solid var(--line); border-radius:10px; color:var(--ink); background:#fff; cursor:pointer; transition:.18s ease; }
    button:hover { transform:translateY(-1px); border-color:rgba(23,61,50,.35); }
    button.primary { color:#fff; background:var(--signal); border-color:var(--signal); font-weight:700; }
    button:disabled { cursor: not-allowed; opacity: 0.45; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; min-width: 180px; }
    .actions button { padding: 5px 8px; font-size: 12px; }
    .failure-box { margin-top:6px; padding:9px; border-left:3px solid var(--bad); border-radius:8px; background:#fff0ec; max-width:420px; }
    .review-box { margin-top:6px; padding:9px; border-left:3px solid var(--forest-2); border-radius:8px; background:#eaf2ed; max-width:420px; font-size:12px; }
    .review-box ul { margin: 6px 0 0 18px; padding: 0; }
    .ledger-toolbar { display:grid; grid-template-columns:minmax(180px,1.6fr) repeat(2,minmax(120px,.7fr)); gap:8px; margin-bottom:14px; }
    .decision-filters { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 14px; }
    .decision-filters button { border-radius:999px; background:var(--surface-soft); }
    .decision-filters button.active { color:white; background:var(--ink); border-color:var(--ink); }
    .governance-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; align-items:stretch; }
    .governance-grid > section { height:480px; min-height:480px; display:flex; flex-direction:column; overflow:hidden; }
    .governance-grid > section > button { margin-top:8px; }
    .governance-file-list { display:grid; flex:1; min-height:0; gap:6px; margin-top:12px; padding-right:4px; overflow:auto; align-content:start; }
    .governance-file { width:100%; display:flex; justify-content:space-between; gap:12px; text-align:left; background:#f8f5ed; }
    .adoption-card { min-width:0; padding:20px 22px; border:1px solid var(--line); background:var(--panel); }
    .adoption-card > div,.adoption-detail,.adoption-detail-value { min-width:0; }
    .adoption-detail-value { overflow-wrap:anywhere; word-break:break-word; }
    .adoption-card .form-row { flex-wrap:wrap; margin-bottom:0; }
    .approval-tabs { display:flex; gap:0; margin:0 0 18px; border-bottom:1px solid var(--ink); }
    .approval-tab { min-width:132px; padding:12px 18px; border:0; border-right:1px solid var(--line); background:transparent; text-align:left; font-weight:800; }
    .approval-tab.active { color:#fff; background:var(--ink); }
    .approval-tab span { margin-left:8px; font-variant-numeric:tabular-nums; }
    .approval-empty { padding:28px 22px; }
    .approval-groups,.approval-items,.archive-list,.archive-entries { display:grid; gap:14px; }
    .approval-group { padding:0; overflow:hidden; border:1px solid var(--line); background:var(--panel); }
    .approval-group-head { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; padding:20px 22px 12px; }
    .approval-group-head h2,.approval-item-head h3,.archive-entry h3 { margin:5px 0; }
    .approval-group-paths { padding:0 22px 16px; color:var(--muted); overflow-wrap:anywhere; }
    .approval-group > details > summary,.approval-item-details > summary,.archive-entry > details > summary { padding:13px 22px; border-top:1px solid var(--line); cursor:pointer; font-weight:800; }
    .approval-items { padding:14px; border-top:1px solid var(--line); background:#ede9df; }
    .approval-item { padding:17px 18px; }
    .approval-item-head { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; }
    .approval-item-details { margin-top:12px; padding:4px 22px 2px; border-top:1px solid var(--line); }
    .archive-toolbar { display:grid; grid-template-columns:auto minmax(220px,520px) auto; align-items:center; gap:12px; margin-bottom:18px; }
    .archive-toolbar label { font-weight:800; }
    .archive-toolbar input { width:100%; padding:12px 14px; border:1px solid var(--line); background:var(--panel); }
    .archive-section { padding:0; border:1px solid var(--line); background:var(--panel); }
    .archive-section-head { display:flex; align-items:end; justify-content:space-between; gap:20px; padding:20px 22px; border-bottom:1px solid var(--line); }
    .archive-section-head h2 { margin:5px 0 0; }
    .archive-entries { padding:14px; }
    .archive-entry { padding:16px 18px; border:1px solid var(--line); background:#f8f5ed; }
    .archive-entry dl { display:grid; grid-template-columns:90px 1fr; gap:8px 12px; margin:0; padding:14px 22px; }
    .archive-entry dt { font-weight:800; }
    .archive-entry dd { margin:0; color:var(--muted); overflow-wrap:anywhere; }
    .section-kicker { margin:22px 0 10px; color:var(--muted); font-size:12px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; }
    .governance-ledger-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }
    .governance-ledger-grid > section { min-height:210px; display:flex; flex-direction:column; }
    .ledger-card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
    .ledger-card-head h2 { margin-bottom:0; }
    .ledger-count { display:block; margin-top:auto; padding-top:18px; font-size:22px; }
    .ledger-card-foot { min-height:38px; margin-top:14px; display:flex; align-items:center; }
    .log-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; align-items:stretch; }
    .log-grid > section { min-height:210px; }
    .activity-row { display:grid; grid-template-columns:150px minmax(0,1fr) auto; gap:14px; padding:12px 0; border-top:1px solid var(--line); }
    .activity-row:first-child { border-top:0; }
    .activity-row time,.activity-row small { color:var(--muted); }
    .ledger-board { display:grid; grid-template-columns:repeat(4,minmax(230px,1fr)); gap:12px; align-items:start; overflow-x:auto; padding-bottom:8px; }
    .ledger-column { min-width:230px; padding:12px; border:1px solid var(--line); border-radius:17px; background:rgba(231,227,216,.44); }
    .ledger-column-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }
    .ledger-column-head h2 { margin:0; font-size:15px; }
    .ledger-column-count { display:inline-grid; place-items:center; min-width:25px; height:25px; padding:0 7px; border-radius:99px; background:var(--paper); color:var(--forest); font-weight:900; font-size:11px; }
    .ledger-column-list { display:grid; gap:9px; }
    .ledger-column-empty { padding:18px 8px; text-align:center; color:var(--muted); font-size:12px; }
    .ledger-card { padding:14px; border:1px solid var(--line); border-radius:13px; background:#fffdf7; cursor:pointer; box-shadow:0 5px 14px rgba(25,57,47,.05); }
    .ledger-card-head { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:start; }
    .ledger-card h3 { margin:3px 0 6px; font-size:15px; }
    .ledger-card .task-detail { grid-column:auto; padding-top:14px; }
    .ledger-card.expanded .task-detail { display:block; }
    .ticket-meta { display:flex; flex-wrap:wrap; gap:6px 10px; color:var(--muted); font-size:11px; }
    .ticket-type { color:var(--forest); font-weight:800; }
    .attention-chip { display:inline-flex; align-items:center; padding:3px 7px; border-radius:99px; color:#9f2f1c; background:#ffe2da; font-size:10px; font-weight:900; }
    .history { display:grid; gap:7px; margin-top:8px; }
    .history-row { display:grid; grid-template-columns:150px 120px minmax(0,1fr); gap:10px; padding:7px 0; border-top:1px dashed var(--line); font-size:11px; }
    .failure-box pre {
      background: transparent;
      padding: 0;
      max-height: 160px;
      font-size: 12px;
    }
    .section-title { margin:0 0 18px; font:700 30px/1.1 "Songti SC","STSong",serif; }
    .section-intro { margin:-8px 0 22px; color:var(--muted); }
    .danger-count { display:inline-grid; place-items:center; min-width:20px; height:20px; padding:0 6px; margin-left:7px; border-radius:99px; color:#fff; background:var(--signal); font-size:10px; }
    @keyframes rise { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
    @media (max-width: 980px) { .app{grid-template-columns:76px minmax(0,1fr)} .rail{padding-inline:17px}.brand-text,.nav span,.nav-label,.rail-foot{display:none}.nav button,.nav button.nav-subitem{justify-content:center;padding:12px 0}.hero,.dashboard-grid{grid-template-columns:1fr}.hero-stamp{justify-self:stretch;width:100%}.ops,.two,.log-grid{grid-template-columns:1fr}.governance-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.governance-ledger-grid{grid-template-columns:1fr}.ledger-toolbar{grid-template-columns:1fr 1fr} }
    @media (max-width: 640px) { .governance-grid{grid-template-columns:1fr}.activity-row{grid-template-columns:1fr;gap:4px}.approval-group-head,.approval-item-head,.archive-section-head{display:grid}.archive-toolbar,.archive-entry dl{grid-template-columns:1fr} }
    /* Grid workbench theme: information hierarchy comes from rules and spacing. */
    :root { --ink:#141412; --muted:#6d6b64; --paper:#f2efe8; --panel:#f8f5ee; --forest:#171715; --forest-2:#262622; --mint:#d3482f; --signal:#d3482f; --gold:#d3482f; --line:#cbc6ba; --good:#24704d; --bad:#bd3528; --warn:#a56519; --shadow:none; --radius:0; }
    body { background:var(--paper); font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif; }
    .app { grid-template-columns:204px minmax(0,1fr); }
    .rail { padding:22px 18px; background:#171715; border-right:1px solid #353531; }
    .rail::after { display:none; }
    .nav button { border-radius:0; border-left:2px solid transparent; }
    .nav button:hover { transform:none; background:#22221f; }
    .nav button.active { color:#fff; background:#242421; border-left-color:var(--signal); box-shadow:none; }
    .topbar { min-height:64px; padding:0 clamp(24px,3vw,48px); border-bottom:1px solid var(--line); }
    main { padding:38px clamp(24px,3vw,48px) 64px; }
    .hero { grid-template-columns:minmax(0,1fr) 240px; align-items:stretch; gap:0; margin-bottom:0; border-top:1px solid var(--ink)!important; border-bottom:1px solid var(--ink)!important; }
    .hero>div:first-child { padding:28px 26px 30px 0; }
    h1 { font-family:Arial,"PingFang SC",sans-serif; font-weight:900; font-size:clamp(40px,5vw,72px); letter-spacing:-.06em; }
    h2,.section-title { font-family:Arial,"PingFang SC",sans-serif; font-weight:800; }
    .hero-stamp { width:auto; padding:25px 22px; border:0; border-left:1px solid var(--ink); background:transparent; box-shadow:none; }
    .hero-stamp strong { font-family:Arial,sans-serif; font-size:38px; }
    .pipeline { gap:0; margin:0 0 22px; padding:0; border-radius:0; color:var(--ink); background:transparent; border-bottom:1px solid var(--ink); box-shadow:none; }
    .step { padding:16px 14px; opacity:.58; border-right:1px solid var(--line); }
    .step:first-child { border-left:1px solid var(--ink); }
    .step:last-child { border-right:1px solid var(--ink); }
    .step:not(:last-child)::after { display:none; }
    .step small { color:var(--muted); }
    .step.done,.step.active { background:#ebe6dc; }
    section,.metric,.op-block { border-radius:0; background:var(--panel); box-shadow:none; }
    .attention-panel { background:var(--signal); }
    .task-id { border-radius:0; color:var(--ink); background:transparent; }
    .pill,.status-badge,.attention-chip { border-radius:0; }
    button,input,textarea,select,pre,.governance-file { border-radius:0; box-shadow:none; }
    button:hover { transform:none; border-color:var(--ink); }
    .ledger-column,.ledger-card { border-radius:0; box-shadow:none; }
    .ledger-board { gap:1px; background:var(--line); }
    .ledger-column { border:0; background:var(--panel); }
    .workspace-row code { font-size:11px; }
    @media (max-width: 900px) { .workspace-row{grid-template-columns:minmax(100px,.7fr) minmax(150px,1.3fr)}.workspace-row code{grid-column:span 1}.dashboard-grid{grid-template-columns:1fr} }
    @media (max-width: 640px) { .app{display:block}.rail{position:static;width:100%;height:auto;padding:10px 16px}.brand{margin:0}.brand-wordmark{width:150px}.nav,.nav-label,.rail-foot{display:none}.topbar{padding:14px 16px}.status-pill,.top-actions .notice{display:none}main{padding:24px 16px 44px}h1{font-size:39px}.hero{grid-template-columns:1fr}.hero-stamp{border-left:0;border-top:1px solid var(--ink)}.pipeline{grid-template-columns:repeat(2,minmax(0,1fr));overflow:hidden}.step small{display:block;overflow:hidden;text-overflow:ellipsis}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.task-card{grid-template-columns:44px minmax(0,1fr)}.task-card>.status-badge{display:none}.panel-head{align-items:flex-start}.panel-head .primary{padding-inline:9px;font-size:12px}.workspace-row{grid-template-columns:1fr}.workspace-row code{grid-column:auto} }
`;
