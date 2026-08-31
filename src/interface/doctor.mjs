import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_HELIX_CONFIG,
  loadHelixConfig,
} from "../infra/runtime-config.mjs";
import {
  ensureHelixDirs,
  nowIso,
  readJson,
  resolveLegacyTaskAcceptancePath,
  resolveLegacyTaskCheckpointPath,
  resolveHelixPath,
  resolveTaskAcceptancePath,
  resolveTaskCheckpointPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { readVerifiedLedgerEntries, verifyLedger } from "../infra/ledger.mjs";
import { isPossibleNoopTask, isTrivialCommand } from "../infra/task-predicates.mjs";
import { loadTaskLedger, loadTaskState, taskRef } from "../infra/task-state-store.mjs";
import { listRuntimeStateBackups, verifyConfigBaseline, verifyRuntimeState } from "../infra/security.mjs";
import { evaluateGateArming } from "../infra/gate-arming.mjs";
import { normalizeRelativePath } from "../infra/path-match.mjs";
import { projectDecisionStats } from "./decisions.mjs";

const COMPLETION_LEDGER_EVENT_TYPES = new Set([
  "task_verified",
  "node_checkpoint_completed",
  "parallel_agent_admission_completed",
]);

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
];

export async function runDoctor(rootDir) {
  await ensureHelixDirs(rootDir);
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

  const jsonPath = resolveHelixPath(rootDir, "reports", "doctor.json");
  const mdPath = resolveHelixPath(rootDir, "reports", "doctor.md");
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
  const { config, sourcePath } = await loadHelixConfig(rootDir);
  const knownTopLevelKeys = new Set(Object.keys(DEFAULT_HELIX_CONFIG));
  const knownInjectionPoints = new Set(Object.keys(DEFAULT_HELIX_CONFIG.injectionPoints));
  const rawConfigs = [
    await readJson(path.join(rootDir, "helix.config.json"), null),
    await readJson(resolveHelixPath(rootDir, "config.json"), null),
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

  const registry = await readJson(resolveHelixPath(rootDir, "prompt-pack.json"), null);
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
        // .helix/ 下的挂载是运行时生成的；带模板变量的路径也无法静态检查
        if (markdownPath.includes("{") || markdownPath.startsWith(".helix/")) continue;
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
    addFinding(findings, "warn", "config", "prompt pack registry missing; run `helix init` to install it");
  }

  return {
    sourcePath,
    unknownTopLevelKeys,
    unknownInjectionPoints,
    unregisteredSkillCount: unregisteredSkills.length,
    missingMarkdownMountCount: missingMarkdownMounts.length,
  };
}

async function checkCompletionIntegrity(rootDir, findings) {
  const taskLedger = await loadTaskLedger(rootDir);
  if (!taskLedger) {
    return { checkedCompleted: 0, note: "no imported plan" };
  }
  const tasks = taskLedger.tasks || [];
  const completionEvents = await collectCompletionLedgerEvents(rootDir, tasks);
  for (const ambiguous of completionEvents.ambiguousLegacy) {
    addFinding(
      findings,
      "error",
      "completion_audit",
      `legacy completion event for task ${ambiguous.taskId} has no planId and cannot be assigned to a current Plan; current candidates: ${ambiguous.planIds.join(", ")}`,
      {
        code: "ambiguous_legacy_completion_event",
        taskId: ambiguous.taskId,
        planIds: ambiguous.planIds,
        eventTypes: ambiguous.eventTypes,
      },
    );
  }
  const completedTasks = tasks.filter((task) => task.status === "completed");
  let audited = 0;
  let revalidationRequired = 0;
  for (const task of tasks) {
    if (task.completionRevalidation?.required !== true) continue;
    revalidationRequired += 1;
    const migrated = Boolean(task.completionRevalidation.migratedAt);
    addFinding(findings, migrated ? "warn" : "error", "completion_audit", `task ${task.ref || taskRef(task.planId, task.id)} was marked completed by legacy state but lacks the current proof chain; ${migrated ? "migration safely moved it to needs_user_decision" : "run state migrate, then revalidate it through the normal delivery pipeline"}`, {
      planId: task.planId,
      taskId: task.id,
      taskRef: task.ref || taskRef(task.planId, task.id),
      previousStatus: task.completionRevalidation.previousStatus,
      migratedAt: task.completionRevalidation.migratedAt || null,
    });
  }
  for (const task of completedTasks) {
    audited += 1;
    const planId = task.planId || taskLedger.activePlanId;
    const ref = taskRef(planId, task.id);
    const checkpointPath = resolveTaskCheckpointPath(rootDir, planId, task.id);
    const checkpoint = await readTaskEvidenceJson(rootDir, "checkpoint", planId, task.id);
    if (!checkpoint) {
      addFinding(findings, "error", "completion_audit", `task ${ref} is completed but has no checkpoint file; task state may have been edited by hand`, { planId, taskId: task.id, taskRef: ref, expectedPath: path.relative(rootDir, checkpointPath) });
    }
    const acceptancePath = resolveTaskAcceptancePath(rootDir, planId, task.id, "json");
    const acceptance = await readTaskEvidenceJson(rootDir, "acceptance", planId, task.id);
    if (!acceptance) {
      addFinding(findings, "error", "completion_audit", `task ${ref} is completed but has no acceptance proof report`, { planId, taskId: task.id, taskRef: ref, expectedPath: path.relative(rootDir, acceptancePath) });
    }
    if (!completionEvents.refs.has(ref)) {
      addFinding(findings, "error", "completion_audit", `task ${ref} is completed but the ledger has no completion event for it`, { planId, taskId: task.id, taskRef: ref });
    }
    if (!Array.isArray(task.verify_commands) || task.verify_commands.length === 0) {
      addFinding(findings, "error", "completion_audit", `task ${ref} is completed with empty verify_commands`, { planId, taskId: task.id, taskRef: ref });
    } else if (task.verify_commands.every(isTrivialCommand)) {
      addFinding(findings, "warn", "completion_audit", `task ${ref} is completed but every verify command is trivial (e.g. \`true\`); the verification proves nothing`, { planId, taskId: task.id, taskRef: ref });
    }
    if (isPossibleNoopTask(task)) {
      addFinding(findings, "warn", "completion_audit", `task ${ref} looks like a no-op task (trivial worker + trivial verifier + no writable paths)`, { planId, taskId: task.id, taskRef: ref });
    }
  }

  // 反向不一致（cross-review P2, round 4, 2026-07-21）：
  // 1) 未完成任务却已有账本完成事件 → 完成事务被中断，canonical 落盘失败。
  //    这是可恢复状态：helix run 会自动裁决卡在 verifying 的任务。
  let orphanCompletionEvents = 0;
  for (const task of tasks) {
    if (task.status === "completed") continue;
    const planId = task.planId || taskLedger.activePlanId;
    const ref = taskRef(planId, task.id);
    if (completionEvents.refs.has(ref)) {
      orphanCompletionEvents += 1;
      addFinding(findings, "warn", "completion_audit", `task ${ref} is ${task.status} but the ledger already has a completion event; the completion transaction was interrupted before the canonical state was saved — activate plan ${planId}, then run \`helix run\` (or \`helix node checkpoint --task ${task.id}\`) to adjudicate it`, { planId, taskId: task.id, taskRef: ref, taskStatus: task.status });
    }
  }

  // 2) 完成后置副产物（快照/总结）写失败：完成状态本身不回退，但失败会
  //    以 completion_side_effect_failed 事件入账（round 5, 2026-07-21），
  //    doctor 把它们晒出来，避免"完成了但快照缺失"永远无人知晓。
  let sideEffectFailures = 0;
  for (const entry of await readVerifiedLedgerEntries(rootDir)) {
    if (entry.type !== "completion_side_effect_failed") continue;
    sideEffectFailures += 1;
    addFinding(findings, "warn", "completion_audit", `task ${entry.taskId} completed but a post-completion side effect failed (${entry.error || "unknown error"}); the snapshot/summary for that completion may be missing`, { taskId: entry.taskId });
  }

  // 3) 派生视图（plan JSON / tasks.md）与 canonical tasks.json 的状态分叉。
  const canonicalStatus = new Map(tasks.map((task) => [taskRef(task.planId || taskLedger.activePlanId, task.id), task.status]));
  let derivedDivergences = 0;
  const planIds = [...new Set(tasks.map((task) => task.planId).filter(Boolean))];
  for (const planId of planIds) {
    const planPath = resolveHelixPath(rootDir, "plans", `${planId}.json`);
    if (existsSync(planPath)) {
      const plan = await readJson(planPath);
      for (const planTask of plan?.tasks || []) {
        const ref = taskRef(planId, planTask.id);
        const canonical = canonicalStatus.get(ref);
        if (canonical && planTask.status !== canonical) {
          derivedDivergences += 1;
          addFinding(findings, "warn", "completion_audit", `task ${ref} status diverges between canonical tasks.json (${canonical}) and plan JSON (${planTask.status}); tasks.json is authoritative — the plan mirror was written by an interrupted transaction`, { planId, taskId: planTask.id, taskRef: ref, canonical, planStatus: planTask.status });
        }
      }
    }
  }
  const markdownPath = resolveHelixPath(rootDir, "team", "tasks.md");
  if (existsSync(markdownPath)) {
    const markdownStatus = parseTasksMarkdownStatuses(await readFile(markdownPath, "utf8"));
    for (const [taskId, mdStatus] of markdownStatus) {
      const ref = taskRef(taskLedger.activePlanId, taskId);
      const canonical = canonicalStatus.get(ref);
      if (canonical && mdStatus !== canonical) {
        derivedDivergences += 1;
        addFinding(findings, "warn", "completion_audit", `task ${ref} status diverges between canonical tasks.json (${canonical}) and tasks.md (${mdStatus}); tasks.json is authoritative`, { planId: taskLedger.activePlanId, taskId, taskRef: ref, canonical, markdownStatus: mdStatus });
      }
    }
  }

  return {
    checkedCompleted: audited,
    totalTasks: tasks.length,
    planCount: planIds.length,
    activePlanId: taskLedger.activePlanId,
    revalidationRequired,
    ambiguousLegacyCompletionEvents: completionEvents.ambiguousLegacy.length,
    orphanCompletionEvents,
    sideEffectFailures,
    derivedDivergences,
  };
}

async function readTaskEvidenceJson(rootDir, kind, planId, taskId) {
  const canonicalPath = kind === "checkpoint"
    ? resolveTaskCheckpointPath(rootDir, planId, taskId)
    : resolveTaskAcceptancePath(rootDir, planId, taskId, "json");
  const canonical = await readJson(canonicalPath, null);
  if (canonical?.planId === planId && canonical?.taskId === taskId) return canonical;
  const legacyPath = kind === "checkpoint"
    ? resolveLegacyTaskCheckpointPath(rootDir, planId, taskId)
    : resolveLegacyTaskAcceptancePath(rootDir, planId, taskId, "json");
  const legacy = await readJson(legacyPath, null);
  return legacy?.planId === planId && legacy?.taskId === taskId ? legacy : null;
}

function parseTasksMarkdownStatuses(markdown) {
  const statuses = new Map();
  let currentTaskId = null;
  for (const line of markdown.split("\n")) {
    const checkboxMatch = line.match(/^- \[[x ]\] (\S+)\. /);
    if (checkboxMatch) {
      currentTaskId = checkboxMatch[1];
      continue;
    }
    const statusMatch = line.match(/^ {2}- Status: (\S+)/);
    if (statusMatch && currentTaskId) {
      statuses.set(currentTaskId, statusMatch[1]);
      currentTaskId = null;
    }
  }
  return statuses;
}

async function collectCompletionLedgerEvents(rootDir, tasks) {
  const refs = new Set();
  const planIdsByTaskId = new Map();
  for (const task of tasks) {
    if (!task.id || !task.planId) continue;
    if (!planIdsByTaskId.has(task.id)) planIdsByTaskId.set(task.id, new Set());
    planIdsByTaskId.get(task.id).add(task.planId);
  }
  const ambiguousByTaskId = new Map();
  // 只统计通过 hash 链校验的条目，手工追加的伪造完成事件不算证据
  const entries = await readVerifiedLedgerEntries(rootDir);
  for (const entry of entries) {
    if (!COMPLETION_LEDGER_EVENT_TYPES.has(entry.type) || !entry.taskId) continue;
    // 并行 admission 事件对失败结局也会写同名类型并带 status 字段；
    // 只有真正 completed 的结局才算完成证据。
    if (entry.type === "parallel_agent_admission_completed" && entry.status && entry.status !== "completed") continue;
    if (entry.planId) {
      refs.add(taskRef(entry.planId, entry.taskId));
      continue;
    }
    const candidatePlanIds = planIdsByTaskId.get(entry.taskId) || new Set();
    // Unscoped legacy events can never prove a current Plan completion. Even
    // when taskId is currently unique, an archived older Plan may have reused
    // it; inferring from today's ledger would silently transfer old evidence.
    if (candidatePlanIds.size > 0) {
      const current = ambiguousByTaskId.get(entry.taskId) || {
        taskId: entry.taskId,
        planIds: [...candidatePlanIds].sort(),
        eventTypes: new Set(),
      };
      current.eventTypes.add(entry.type);
      ambiguousByTaskId.set(entry.taskId, current);
    }
  }
  return {
    refs,
    ambiguousLegacy: [...ambiguousByTaskId.values()].map((entry) => ({
      ...entry,
      eventTypes: [...entry.eventTypes].sort(),
    })),
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
    addFinding(findings, "warn", "ledger_backup", "no runtime state backup found; run `helix state backup` so ledger rewrites can be detected");
    return { checked: false, reason: "no_backup" };
  }
  const latest = backups[backups.length - 1];
  const backupLedgerPath = resolveHelixPath(rootDir, "backups", latest.backupId, ".helix", "ledger.jsonl");
  if (!existsSync(backupLedgerPath)) {
    return { checked: false, reason: "backup_has_no_ledger", backupId: latest.backupId };
  }
  const backupLines = await readLedgerLines(backupLedgerPath);
  const currentLines = await readLedgerLines(resolveHelixPath(rootDir, "ledger.jsonl"));
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
    addFinding(findings, "warn", "config_baseline", "no config baseline; run `helix config baseline` after reviewing config so weakening edits can be detected");
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
  const { config } = await loadHelixConfig(rootDir);
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
  const { config, sourcePath } = await loadHelixConfig(rootDir);
  if (!sourcePath) {
    return { status: "skipped", reason: "no helix.config.json; adapter checks only run for configured projects" };
  }
  const targets = [];
  const cursorEnabled = config.adapters?.cursor?.enabled === true;
  const codexEnabled = config.adapters?.codex?.enabled === true;
  const kimiEnabled = config.adapters?.kimi?.enabled === true;

  if (cursorEnabled) {
    const hooksPath = path.join(rootDir, ".cursor", "hooks.json");
    const bridgePath = path.join(rootDir, ".cursor", "hooks", "wildarrange-hook-bridge.mjs");
    if (!existsSync(hooksPath)) {
      addFinding(findings, "warn", "adapters", "config 启用了 Cursor adapter 但 .cursor/hooks.json 不存在，本机没有硬拦截", { target: "cursor", nextAction: "node ./bin/helix.mjs adapter install --target cursor" });
      targets.push({ target: "cursor", installed: false });
    } else {
      const raw = await readFile(hooksPath, "utf8").catch(() => "");
      const referencesBridge = raw.includes("wildarrange-hook-bridge");
      const bridgeExists = existsSync(bridgePath);
      if (!referencesBridge || !bridgeExists) {
        addFinding(findings, "warn", "adapters", ".cursor/hooks.json 未引用 bridge 或 bridge 文件缺失，硬拦截不完整", { target: "cursor", nextAction: "重新运行 node ./bin/helix.mjs adapter install --target cursor" });
      }
      targets.push({ target: "cursor", installed: referencesBridge && bridgeExists });
    }
  }
  if (codexEnabled) {
    const codexHooks = path.join(rootDir, ".codex", "hooks.json");
    const installed = existsSync(codexHooks);
    if (!installed) {
      addFinding(findings, "warn", "adapters", "config 启用了 Codex adapter 但 .codex/hooks.json 不存在，本机没有硬拦截", { target: "codex", nextAction: "node ./bin/helix.mjs adapter install --target codex" });
    }
    targets.push({ target: "codex", installed });
  }
  if (kimiEnabled) {
    const kimiBridge = resolveHelixPath(rootDir, "adapters", "kimi", "plugin", "hooks", "wildarrange-hook-bridge.mjs");
    const installed = existsSync(kimiBridge);
    if (!installed) {
      addFinding(findings, "warn", "adapters", "config 启用了 Kimi adapter 但 plugin bridge 不存在", { target: "kimi", nextAction: "node ./bin/helix.mjs adapter install --target kimi" });
    }
    targets.push({ target: "kimi", installed });
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
  const legacyCursorRule = path.join(rulesDir, ["helix", "flow.mdc"].join(""));
  if (existsSync(legacyCursorRule)) {
    const relativePath = normalizeRelativePath(path.relative(rootDir, legacyCursorRule));
    legacyManagedRules.push({ path: relativePath });
    addFinding(findings, "warn", "adapters", `legacy managed Cursor rule ${relativePath} is still active and may be injected alongside wildarrange.mdc`, {
      target: "cursor",
      path: relativePath,
      nextAction: "node ./bin/helix.mjs adapter install --target cursor",
    });
  }

  const uninstalled = targets.filter((target) => !target.installed).length;
  return {
    status: uninstalled > 0 || staleRules.length > 0 || legacyManagedRules.length > 0 ? "warn" : "ok",
    targets,
    staleRules,
    legacyManagedRules,
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

async function checkRepositoryGovernance(rootDir, findings) {
  const reportPath = resolveHelixPath(rootDir, "reports", "governance", "latest.json");
  const report = await readJson(reportPath, null);
  if (!report) {
    return { checked: false, status: "not_run", findingCount: 0 };
  }
  const findingCount = Array.isArray(report.findings) ? report.findings.length : 0;
  if (report.status === "fail") {
    addFinding(findings, "error", "repository_governance", `latest repository governance audit failed with ${findingCount} finding(s); run \`helix governance audit\` after repairs`, { reportPath: path.relative(rootDir, reportPath) });
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
  lines.push(`- Adapters: ${sectionValue(report.sections.adapters, (s) => s.status === "skipped" ? `skipped (${s.reason})` : `${(s.targets || []).map((target) => `${target.target}:${target.installed ? "installed" : "MISSING"}`).join(", ") || "none enabled"}${(s.staleRules || []).length ? `, stale rules: ${s.staleRules.length}` : ""}`)}`);
  lines.push(`- Completed tasks audited: ${sectionValue(report.sections.completionAudit, (s) => s.checkedCompleted)}`);
  lines.push(`- Ledger entries checked: ${sectionValue(report.sections.ledger, (s) => `${s.checked} (legacy: ${s.legacy})`)}`);
  lines.push(`- Ledger vs backup: ${sectionValue(report.sections.ledgerBackupCrossCheck, (s) => s.checked ? `${s.backupId}: ${s.prefixIntact ? "history intact" : "HISTORY DIVERGED"}` : `not checked (${s.reason})`)}`);
  lines.push(`- Config baseline: ${sectionValue(report.sections.configBaseline, (s) => s.status)}`);
  lines.push(`- Runtime state: ${sectionValue(report.sections.runtimeState, (s) => s.status)}`);
  lines.push(`- Repository governance: ${sectionValue(report.sections.repositoryGovernance, (s) => s.checked ? `${s.status} (${s.findingCount} findings)` : "not run")}`);
  lines.push(`- Decision health: ${sectionValue(report.sections.decisionHealth, (s) => `${s.totalDecisions} decisions, never-fired gates: ${(s.neverFiredGates || []).join(", ") || "none"}, annotations: ${s.annotations?.total ?? 0} (orphans: ${s.annotations?.unmatchedCount ?? 0})`)}`);
  return `${lines.join("\n")}\n`;
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
