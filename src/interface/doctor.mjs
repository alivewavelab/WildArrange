import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_WILDARRANGE_CONFIG } from "../infra/default-config.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import {
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
  hashContent,
} from "../infra/runtime-store.mjs";
import { readVerifiedLedgerEntries, verifyLedger } from "../infra/ledger.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";
import { listRuntimeStateBackups, verifyConfigBaseline, verifyRuntimeState } from "../infra/security.mjs";
import { evaluateGateArming } from "../infra/gate-arming.mjs";
import { evaluateRegistryFreshness } from "../infra/verification-registry.mjs";
import { normalizeRelativePath } from "../infra/path-match.mjs";
import { projectDecisionStats } from "./decisions.mjs";
import { checkCompletionIntegrity } from "./doctor-completion.mjs";

// 诊断与门控分离：每个检查独立 try/catch，单项崩溃只把自己的分项标红，
// 其余分项照常输出；doctor 不再写 hash 链 ledger（诊断不该抢门控的锁）。
const SECTION_CHECKS = [
  ["config", checkConfigStructure],
  ["gateArming", checkGateArming],
  ["adapters", checkAdapters],
  ["completionAudit", checkCompletionIntegrity],
  ["ledger", checkLedgerIntegrity],
  ["ledgerBackupCrossCheck", checkLedgerAgainstBackup],
  ["configBaseline", checkConfigBaseline],
  ["runtimeState", checkRuntimeState],
  ["repositoryGovernance", checkRepositoryGovernance],
  ["decisionHealth", checkDecisionHealth],
  ["registryFreshness", checkRegistryFreshness],
];

export async function runDoctor(rootDir) {
  await ensureWildArrangeDirs(rootDir);
  const findings = [];
  const sections = {};

  for (const [name, check] of SECTION_CHECKS) {
    try {
      sections[name] = await check(rootDir, findings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addFinding(findings, "error", name, `doctor check "${name}" itself failed: ${message}`, { checkFailed: true });
      sections[name] = { status: "check_failed", error: message };
    }
  }

  const report = {
    kind: "doctor_report",
    at: nowIso(),
    ok: findings.every((finding) => finding.severity !== "error"),
    errorCount: findings.filter((finding) => finding.severity === "error").length,
    warnCount: findings.filter((finding) => finding.severity === "warn").length,
    findings,
    sections,
  };

  const jsonPath = resolveWildArrangePath(rootDir, "reports", "doctor.json");
  const mdPath = resolveWildArrangePath(rootDir, "reports", "doctor.md");
  report.reportJsonPath = path.relative(rootDir, jsonPath);
  report.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, report);
  await writeFile(mdPath, renderDoctorMarkdown(report), "utf8");
  return report;
}

function addFinding(findings, severity, section, message, extra = {}) {
  findings.push({ severity, section, message, ...extra });
}

async function checkConfigStructure(rootDir, findings) {
  const { config, sourcePath } = await loadWildArrangeConfig(rootDir);
  const knownTopLevelKeys = new Set(Object.keys(DEFAULT_WILDARRANGE_CONFIG));
  const knownInjectionPoints = new Set(Object.keys(DEFAULT_WILDARRANGE_CONFIG.injectionPoints));
  const rawConfigs = [
    await readJson(path.join(rootDir, "wildarrange.config.json"), null),
    await readJson(resolveWildArrangePath(rootDir, "config.json"), null),
  ].filter(Boolean);

  const unknownTopLevelKeys = [];
  const unknownInjectionPoints = [];
  for (const rawConfig of rawConfigs) {
    for (const key of Object.keys(rawConfig)) {
      if (!knownTopLevelKeys.has(key) && !unknownTopLevelKeys.includes(key)) unknownTopLevelKeys.push(key);
    }
    for (const pointName of Object.keys(rawConfig.injectionPoints || {})) {
      if (!knownInjectionPoints.has(pointName) && !unknownInjectionPoints.includes(pointName)) unknownInjectionPoints.push(pointName);
    }
  }
  for (const key of unknownTopLevelKeys) {
    addFinding(findings, "warn", "config", `unknown top-level config key "${key}"; possible typo, it is silently ignored`, { key });
  }
  for (const pointName of unknownInjectionPoints) {
    addFinding(findings, "warn", "config", `unknown injection point "${pointName}"; it will never be mounted`, { point: pointName });
  }

  const registry = await readJson(resolveWildArrangePath(rootDir, "prompt-pack.json"), null);
  const registeredSkills = new Set(Object.keys(registry?.skills || {}));
  const unregisteredSkills = [];
  const missingMarkdownMounts = [];
  if (registry) {
    for (const [pointName, point] of Object.entries(config.injectionPoints || {})) {
      for (const skillName of point?.skills || []) {
        if (!registeredSkills.has(skillName)) {
          unregisteredSkills.push({ point: pointName, skill: skillName });
          addFinding(findings, "warn", "config", `injection point "${pointName}" references unregistered skill "${skillName}"; it is silently skipped`, { point: pointName, skill: skillName });
        }
      }
      for (const markdownPath of point?.markdown || []) {
        // .wildarrange/ 下的挂载是运行时生成的；带模板变量的路径也无法静态检查
        if (markdownPath.includes("{") || markdownPath.startsWith(".wildarrange/")) continue;
        if (!existsSync(path.join(rootDir, markdownPath))) {
          missingMarkdownMounts.push({ point: pointName, path: markdownPath });
          addFinding(findings, "warn", "config", `injection point "${pointName}" mounts missing markdown "${markdownPath}"; it is silently skipped`, { point: pointName, path: markdownPath });
        }
      }
    }
    for (const [stage, skillNames] of Object.entries(config.skillMatcher?.stageBoosts || {})) {
      for (const skillName of skillNames || []) {
        if (!registeredSkills.has(skillName)) {
          addFinding(findings, "warn", "config", `skillMatcher.stageBoosts.${stage} references unregistered skill "${skillName}"`, { stage, skill: skillName });
        }
      }
    }
  } else {
    addFinding(findings, "warn", "config", "prompt pack registry missing; run `wildarrange init` to install it");
  }

  return {
    sourcePath,
    unknownTopLevelKeys,
    unknownInjectionPoints,
    unregisteredSkillCount: unregisteredSkills.length,
    missingMarkdownMountCount: missingMarkdownMounts.length,
  };
}

async function checkLedgerIntegrity(rootDir, findings) {
  const result = await verifyLedger(rootDir);
  if (!result.ok) {
    for (const failure of result.failures) {
      addFinding(findings, "error", "ledger", `ledger line ${failure.line} failed verification: ${failure.reason}`, { line: failure.line, reason: failure.reason });
    }
  }
  return { ok: result.ok, checked: result.checked, legacy: result.legacy, failureCount: result.failures.length };
}

async function checkLedgerAgainstBackup(rootDir, findings) {
  const backups = await listRuntimeStateBackups(rootDir);
  if (backups.length === 0) {
    addFinding(findings, "warn", "ledger_backup", "no runtime state backup found; run `wildarrange state backup` so ledger rewrites can be detected");
    return { checked: false, reason: "no_backup" };
  }
  const latest = backups[backups.length - 1];
  const backupLedgerPath = resolveWildArrangePath(rootDir, "backups", latest.backupId, ".wildarrange", "ledger.jsonl");
  if (!existsSync(backupLedgerPath)) {
    return { checked: false, reason: "backup_has_no_ledger", backupId: latest.backupId };
  }
  const backupLines = await readLedgerLines(backupLedgerPath);
  const currentLines = await readLedgerLines(resolveWildArrangePath(rootDir, "ledger.jsonl"));
  let prefixIntact = currentLines.length >= backupLines.length;
  let firstDivergence = null;
  if (prefixIntact) {
    for (let index = 0; index < backupLines.length; index += 1) {
      if (backupLines[index] !== currentLines[index]) {
        prefixIntact = false;
        firstDivergence = index + 1;
        break;
      }
    }
  }
  if (!prefixIntact) {
    addFinding(findings, "error", "ledger_backup", `current ledger no longer contains the backed-up history from ${latest.backupId} (${latest.at}); the ledger may have been rewritten or truncated`, {
      backupId: latest.backupId,
      backupAt: latest.at,
      firstDivergenceLine: firstDivergence,
      backupLineCount: backupLines.length,
      currentLineCount: currentLines.length,
    });
  }
  return {
    checked: true,
    backupId: latest.backupId,
    backupAt: latest.at,
    prefixIntact,
    backupLineCount: backupLines.length,
    currentLineCount: currentLines.length,
  };
}

async function readLedgerLines(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    return content.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function checkConfigBaseline(rootDir, findings) {
  const result = await verifyConfigBaseline(rootDir);
  if (result.status === "missing_baseline") {
    addFinding(findings, "warn", "config_baseline", "no config baseline; run `wildarrange config baseline` after reviewing config so weakening edits can be detected");
  } else if (!result.ok) {
    for (const failure of result.failures) {
      addFinding(findings, "error", "config_baseline", `config drift detected on ${failure.path}: ${failure.reason}`, { path: failure.path, reason: failure.reason });
    }
  }
  return { status: result.status, failureCount: (result.failures || []).length };
}

async function checkRuntimeState(rootDir, findings) {
  const result = await verifyRuntimeState(rootDir);
  if (!result.ok) {
    for (const failure of result.failures) {
      addFinding(findings, "error", "runtime_state", `required runtime state file missing: ${failure.path}`, { path: failure.path });
    }
  }
  return { status: result.status, failureCount: (result.failures || []).length };
}

// 门武装分项：门未武装时 acceptance-proof 的 review_not_tautological 会把任务
// 挡在 completed 之外——doctor 必须把这件事摆到台面上，而不是埋在 status JSON 里。
async function checkGateArming(rootDir, findings) {
  const { config } = await loadWildArrangeConfig(rootDir);
  const taskState = await loadTaskState(rootDir).catch(() => null);
  const arming = evaluateGateArming({ config, tasks: taskState?.tasks || [] });
  for (const issue of arming.issues) {
    addFinding(findings, "warn", "gate_arming", `${issue.message}${issue.next_action ? `（${issue.next_action}）` : ""}`, { code: issue.code });
  }
  return { status: arming.armed ? "ok" : "warn", armed: arming.armed, issueCount: arming.issues.length };
}

// Adapter 分项：硬拦截装没装、装得对不对，必须有体检。`.cursor/` 不进 git，
// 团队成员各自跑 adapter install，漏装的人机器上 AI 不受约束——这里兜底发现。
async function checkAdapters(rootDir, findings) {
  const { config, sourcePath } = await loadWildArrangeConfig(rootDir);
  if (!sourcePath) {
    return { status: "skipped", reason: "no wildarrange.config.json; adapter checks only run for configured projects" };
  }
  const targets = [];
  const cursorEnabled = config.adapters?.cursor?.enabled === true;
  const codexEnabled = config.adapters?.codex?.enabled === true;
  const kimiEnabled = config.adapters?.kimi?.enabled === true;

  if (cursorEnabled) {
    const hooksPath = path.join(rootDir, ".cursor", "hooks.json");
    const bridgePath = path.join(rootDir, ".cursor", "hooks", "wildarrange-hook-bridge.mjs");
    if (!existsSync(hooksPath)) {
      addFinding(findings, "warn", "adapters", "config 启用了 Cursor adapter 但 .cursor/hooks.json 不存在，本机没有硬拦截", { target: "cursor", nextAction: "node ./bin/wildarrange.mjs adapter install --target cursor" });
      targets.push({ target: "cursor", configured: false });
    } else {
      const raw = await readFile(hooksPath, "utf8").catch(() => "");
      const referencesBridge = raw.includes("wildarrange-hook-bridge");
      const bridgeExists = existsSync(bridgePath);
      if (!referencesBridge || !bridgeExists) {
        addFinding(findings, "warn", "adapters", ".cursor/hooks.json 未引用 bridge 或 bridge 文件缺失，硬拦截不完整", { target: "cursor", nextAction: "重新运行 node ./bin/wildarrange.mjs adapter install --target cursor" });
      }
      targets.push({ target: "cursor", configured: referencesBridge && bridgeExists });
    }
  }
  if (codexEnabled) {
    const codexHooks = path.join(rootDir, ".codex", "hooks.json");
    const configured = existsSync(codexHooks);
    if (!configured) {
      addFinding(findings, "error", "adapters", "config 启用了 Codex adapter 但 .codex/hooks.json 不存在，Codex 治理未配置", { target: "codex", code: "codex_hook_not_configured", nextAction: "node ./bin/wildarrange.mjs adapter install --target codex" });
      targets.push({ target: "codex", configured: false, activation: "not_configured" });
    } else {
      const activation = await inspectCodexHookExecution(rootDir, codexHooks);
      if (activation.status !== "execution_observed") {
        addFinding(findings, "error", "adapters", "Codex Hook 文件已生成，但没有当前 Hook 配置被宿主实际执行的回执；不能认定治理已生效", {
          target: "codex",
          code: "codex_hook_activation_unverified",
          nextAction: "Codex 桌面版请打开设置 > Hooks，审查、信任并启用本项目 Hook；Codex CLI 请执行 /hooks。然后新开或继续一个任务，再运行 wildarrange doctor",
        });
      }
      targets.push({ target: "codex", configured: true, activation: activation.status, lastObservedAt: activation.lastObservedAt, lastEvent: activation.lastEvent, sessionId: activation.sessionId });
    }
  }
  if (kimiEnabled) {
    const kimiBridge = resolveWildArrangePath(rootDir, "adapters", "kimi", "plugin", "hooks", "wildarrange-hook-bridge.mjs");
    const configured = existsSync(kimiBridge);
    if (!configured) {
      addFinding(findings, "warn", "adapters", "config 启用了 Kimi adapter 但 plugin bridge 不存在", { target: "kimi", nextAction: "node ./bin/wildarrange.mjs adapter install --target kimi" });
    }
    targets.push({ target: "kimi", configured });
  }

  // 陈旧规则检测：规则文件里指向不存在绝对路径的命令（如换机/换用户名后的
  // 残留）会静默失效——注入给每个 Agent 的治理规则指向一条跑不通的路径。
  const rulesDir = path.join(rootDir, ".cursor", "rules");
  const staleRules = [];
  const legacyManagedRules = [];
  if (existsSync(rulesDir)) {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(rulesDir)) {
      if (!entry.endsWith(".mdc")) continue;
      const content = await readFile(path.join(rulesDir, entry), "utf8").catch(() => "");
      for (const match of content.matchAll(/\/Users\/[^\s"')`]+/g)) {
        if (!existsSync(match[0])) staleRules.push({ file: `.cursor/rules/${entry}`, missingPath: match[0] });
      }
    }
  }
  for (const stale of staleRules) {
    addFinding(findings, "warn", "adapters", `${stale.file} 引用了不存在的路径 ${stale.missingPath}（规则会静默失效）`, { target: "cursor", nextAction: "修正为相对路径或当前机器的有效路径" });
  }
  // 旧版受管规则文件名（已退役），仍存在于 rules 目录时提示重新安装。
  const legacyCursorRule = path.join(rulesDir, "wildarrangeflow.mdc");
  if (existsSync(legacyCursorRule)) {
    const relativePath = normalizeRelativePath(path.relative(rootDir, legacyCursorRule));
    legacyManagedRules.push({ path: relativePath });
    addFinding(findings, "warn", "adapters", `legacy managed Cursor rule ${relativePath} is still active and may be injected alongside wildarrange.mdc`, {
      target: "cursor",
      path: relativePath,
      nextAction: "node ./bin/wildarrange.mjs adapter install --target cursor",
    });
  }

  const unconfigured = targets.filter((target) => !target.configured).length;
  const activationUnverified = targets.filter((target) => target.target === "codex" && target.activation !== "execution_observed").length;
  return {
    status: activationUnverified > 0 ? "error" : (unconfigured > 0 || staleRules.length > 0 || legacyManagedRules.length > 0 ? "warn" : "ok"),
    targets,
    staleRules,
    legacyManagedRules,
  };
}

async function inspectCodexHookExecution(rootDir, hooksPath) {
  const currentDigest = hashContent(await readFile(hooksPath, "utf8"));
  const entries = await readVerifiedLedgerEntries(rootDir);
  const latest = entries
    .filter((entry) => entry.type === "hook_injection_run"
      && entry.hostAdapter === "codex"
      && entry.hookConfigDigest === currentDigest)
    .at(-1);
  if (!latest) return { status: "unverified", lastObservedAt: null, lastEvent: null, sessionId: null };
  return {
    status: "execution_observed",
    lastObservedAt: latest.at,
    lastEvent: latest.event || null,
    sessionId: latest.sessionId || null,
  };
}

// 周期健康摘要：门决策计数（纯计数不出率）、坏行与孤儿标注预警。
async function checkDecisionHealth(rootDir, findings) {
  const stats = await projectDecisionStats(rootDir);
  if (stats.skippedLines > 0) {
    addFinding(findings, "warn", "decision_health", `decisions.jsonl has ${stats.skippedLines} corrupt line(s) skipped on read`, { skippedLines: stats.skippedLines });
  }
  if (stats.annotations.unmatchedCount > 0) {
    addFinding(findings, "warn", "decision_health", `${stats.annotations.unmatchedCount} annotation(s) point at decisions no longer present (log truncated?)`, { unmatchedCount: stats.annotations.unmatchedCount });
  }
  return {
    status: "ok",
    totalDecisions: stats.total,
    gates: stats.gates.map((gate) => ({ gate: gate.gate, total: gate.total, decisions: gate.decisions })),
    neverFiredGates: stats.neverFiredGates,
    annotations: { total: stats.annotations.total, unmatchedCount: stats.annotations.unmatchedCount },
  };
}

async function checkRegistryFreshness(rootDir, findings) {
  const result = await evaluateRegistryFreshness(rootDir);
  if (result.stale) {
    addFinding(findings, "warn", "registry_freshness", `${result.reason}${result.nextAction ? `；下一步：${result.nextAction}` : ""}`, {
      status: result.status,
      nextAction: result.nextAction,
    });
  }
  return result;
}

async function checkRepositoryGovernance(rootDir, findings) {
  const reportPath = resolveWildArrangePath(rootDir, "reports", "governance", "latest.json");
  const report = await readJson(reportPath, null);
  if (!report) {
    return { checked: false, status: "not_run", findingCount: 0 };
  }
  const findingCount = Array.isArray(report.findings) ? report.findings.length : 0;
  if (report.status === "fail") {
    addFinding(findings, "error", "repository_governance", `latest repository governance audit failed with ${findingCount} finding(s); run \`wildarrange governance audit\` after repairs`, { reportPath: path.relative(rootDir, reportPath) });
  } else if (report.status === "warn") {
    addFinding(findings, "warn", "repository_governance", `latest repository governance audit has ${findingCount} warning finding(s)`, { reportPath: path.relative(rootDir, reportPath) });
  }
  return {
    checked: true,
    status: report.status || "unknown",
    findingCount,
    at: report.at || null,
    reportPath: path.relative(rootDir, reportPath),
  };
}

function renderDoctorMarkdown(report) {
  const lines = [
    "# WildArrange Doctor Report",
    "",
    `Generated: ${report.at}`,
    `Status: ${report.ok ? "PASS" : "FAIL"}`,
    `Errors: ${report.errorCount}; Warnings: ${report.warnCount}`,
    "",
    "## Findings",
    "",
  ];
  if (report.findings.length === 0) {
    lines.push("- None. Runtime state, ledger, and config look consistent.");
  } else {
    for (const finding of report.findings) {
      lines.push(`- [${finding.severity.toUpperCase()}] (${finding.section}) ${finding.message}`);
    }
  }
  lines.push("", "## Sections", "");
  lines.push(`- Config source: ${sectionValue(report.sections.config, (s) => s.sourcePath)}`);
  lines.push(`- Gate arming: ${sectionValue(report.sections.gateArming, (s) => s.armed ? "armed" : `NOT ARMED (${s.issueCount} issue(s))`)}`);
  lines.push(`- Adapters: ${sectionValue(report.sections.adapters, (s) => s.status === "skipped" ? `skipped (${s.reason})` : `${(s.targets || []).map(renderAdapterTarget).join(", ") || "none enabled"}${(s.staleRules || []).length ? `, stale rules: ${s.staleRules.length}` : ""}`)}`);
  lines.push(`- Completed tasks audited: ${sectionValue(report.sections.completionAudit, (s) => s.checkedCompleted)}`);
  lines.push(`- Ledger entries checked: ${sectionValue(report.sections.ledger, (s) => `${s.checked} (legacy: ${s.legacy})`)}`);
  lines.push(`- Ledger vs backup: ${sectionValue(report.sections.ledgerBackupCrossCheck, (s) => s.checked ? `${s.backupId}: ${s.prefixIntact ? "history intact" : "HISTORY DIVERGED"}` : `not checked (${s.reason})`)}`);
  lines.push(`- Config baseline: ${sectionValue(report.sections.configBaseline, (s) => s.status)}`);
  lines.push(`- Runtime state: ${sectionValue(report.sections.runtimeState, (s) => s.status)}`);
  lines.push(`- Repository governance: ${sectionValue(report.sections.repositoryGovernance, (s) => s.checked ? `${s.status} (${s.findingCount} findings)` : "not run")}`);
  lines.push(`- Decision health: ${sectionValue(report.sections.decisionHealth, (s) => `${s.totalDecisions} decisions, never-fired gates: ${(s.neverFiredGates || []).join(", ") || "none"}, annotations: ${s.annotations?.total ?? 0} (orphans: ${s.annotations?.unmatchedCount ?? 0})`)}`);
  lines.push(`- Registry freshness: ${sectionValue(report.sections.registryFreshness, (s) => s.stale ? `${s.status}: ${s.reason}` : (s.status || "not_adopted"))}`);
  return `${lines.join("\n")}\n`;
}

function renderAdapterTarget(target) {
  if (!target.configured) return `${target.target}:NOT CONFIGURED`;
  if (target.target === "codex") return `${target.target}:configured/${target.activation === "execution_observed" ? "execution observed" : "ACTIVATION UNVERIFIED"}`;
  return `${target.target}:configured`;
}

function sectionValue(section, render) {
  if (!section) return "not run";
  if (section.status === "check_failed") return `CHECK FAILED (${section.error})`;
  try {
    const value = render(section);
    return value === undefined || value === null ? "unknown" : String(value);
  } catch {
    return "unknown";
  }
}
