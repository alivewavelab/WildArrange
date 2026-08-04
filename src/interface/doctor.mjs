import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_HELIX_CONFIG,
  loadHelixConfig,
} from "../infra/runtime-config.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import {
  ensureHelixDirs,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { readVerifiedLedgerEntries, verifyLedger } from "../infra/ledger.mjs";
import { isPossibleNoopTask, isTrivialCommand } from "../infra/task-predicates.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";
import { listRuntimeStateBackups, verifyConfigBaseline, verifyRuntimeState } from "../infra/security.mjs";

const COMPLETION_LEDGER_EVENT_TYPES = new Set([
  "task_verified",
  "node_checkpoint_completed",
  "parallel_agent_admission_completed",
]);

export async function runDoctor(rootDir) {
  await ensureHelixDirs(rootDir);
  const findings = [];

  const configSection = await checkConfigStructure(rootDir, findings);
  const completionSection = await checkCompletionIntegrity(rootDir, findings);
  const ledgerSection = await checkLedgerIntegrity(rootDir, findings);
  const backupSection = await checkLedgerAgainstBackup(rootDir, findings);
  const baselineSection = await checkConfigBaseline(rootDir, findings);
  const stateSection = await checkRuntimeState(rootDir, findings);
  const governanceSection = await checkRepositoryGovernance(rootDir, findings);

  const report = {
    kind: "doctor_report",
    at: nowIso(),
    ok: findings.every((finding) => finding.severity !== "error"),
    errorCount: findings.filter((finding) => finding.severity === "error").length,
    warnCount: findings.filter((finding) => finding.severity === "warn").length,
    findings,
    sections: {
      config: configSection,
      completionAudit: completionSection,
      ledger: ledgerSection,
      ledgerBackupCrossCheck: backupSection,
      configBaseline: baselineSection,
      runtimeState: stateSection,
      repositoryGovernance: governanceSection,
    },
  };

  const jsonPath = resolveHelixPath(rootDir, "reports", "doctor.json");
  const mdPath = resolveHelixPath(rootDir, "reports", "doctor.md");
  report.reportJsonPath = path.relative(rootDir, jsonPath);
  report.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, report);
  await writeFile(mdPath, renderDoctorMarkdown(report), "utf8");
  await appendLedger(rootDir, {
    type: "doctor_completed",
    ok: report.ok,
    errorCount: report.errorCount,
    warnCount: report.warnCount,
    reportPath: report.reportMdPath,
  });
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
  const taskState = await loadTaskState(rootDir);
  if (!taskState) {
    return { checkedCompleted: 0, note: "no imported plan" };
  }
  const ledgerTaskEvents = await collectCompletionLedgerEvents(rootDir);
  const completedTasks = (taskState.tasks || []).filter((task) => task.status === "completed");
  let audited = 0;
  for (const task of completedTasks) {
    audited += 1;
    const checkpointPath = resolveHelixPath(rootDir, "checkpoints", `${taskState.planId}-${task.id}.json`);
    if (!existsSync(checkpointPath)) {
      addFinding(findings, "error", "completion_audit", `task ${task.id} is completed but has no checkpoint file; task state may have been edited by hand`, { taskId: task.id, expectedPath: path.relative(rootDir, checkpointPath) });
    }
    const acceptancePath = resolveHelixPath(rootDir, "reports", "acceptance", `${taskState.planId}-${task.id}.json`);
    if (!existsSync(acceptancePath)) {
      addFinding(findings, "error", "completion_audit", `task ${task.id} is completed but has no acceptance proof report`, { taskId: task.id, expectedPath: path.relative(rootDir, acceptancePath) });
    }
    if (!ledgerTaskEvents.has(task.id)) {
      addFinding(findings, "error", "completion_audit", `task ${task.id} is completed but the ledger has no completion event for it`, { taskId: task.id });
    }
    if (!Array.isArray(task.verify_commands) || task.verify_commands.length === 0) {
      addFinding(findings, "error", "completion_audit", `task ${task.id} is completed with empty verify_commands`, { taskId: task.id });
    } else if (task.verify_commands.every(isTrivialCommand)) {
      addFinding(findings, "warn", "completion_audit", `task ${task.id} is completed but every verify command is trivial (e.g. \`true\`); the verification proves nothing`, { taskId: task.id });
    }
    if (isPossibleNoopTask(task)) {
      addFinding(findings, "warn", "completion_audit", `task ${task.id} looks like a no-op task (trivial worker + trivial verifier + no writable paths)`, { taskId: task.id });
    }
  }

  // 反向不一致（cross-review P2, round 4, 2026-07-21）：
  // 1) 未完成任务却已有账本完成事件 → 完成事务被中断，canonical 落盘失败。
  //    这是可恢复状态：helix run 会自动裁决卡在 verifying 的任务。
  let orphanCompletionEvents = 0;
  for (const task of taskState.tasks || []) {
    if (task.status === "completed") continue;
    if (ledgerTaskEvents.has(task.id)) {
      orphanCompletionEvents += 1;
      addFinding(findings, "warn", "completion_audit", `task ${task.id} is ${task.status} but the ledger already has a completion event; the completion transaction was interrupted before the canonical state was saved — run \`helix run\` (or \`helix node checkpoint --task ${task.id}\`) to adjudicate it`, { taskId: task.id, taskStatus: task.status });
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
  const canonicalStatus = new Map((taskState.tasks || []).map((task) => [task.id, task.status]));
  let derivedDivergences = 0;
  const planPath = resolveHelixPath(rootDir, "plans", `${taskState.planId}.json`);
  if (existsSync(planPath)) {
    const plan = await readJson(planPath);
    for (const planTask of plan?.tasks || []) {
      const canonical = canonicalStatus.get(planTask.id);
      if (canonical && planTask.status !== canonical) {
        derivedDivergences += 1;
        addFinding(findings, "warn", "completion_audit", `task ${planTask.id} status diverges between canonical tasks.json (${canonical}) and plan JSON (${planTask.status}); tasks.json is authoritative — the plan mirror was written by an interrupted transaction`, { taskId: planTask.id, canonical, planStatus: planTask.status });
      }
    }
  }
  const markdownPath = resolveHelixPath(rootDir, "team", "tasks.md");
  if (existsSync(markdownPath)) {
    const markdownStatus = parseTasksMarkdownStatuses(await readFile(markdownPath, "utf8"));
    for (const [taskId, mdStatus] of markdownStatus) {
      const canonical = canonicalStatus.get(taskId);
      if (canonical && mdStatus !== canonical) {
        derivedDivergences += 1;
        addFinding(findings, "warn", "completion_audit", `task ${taskId} status diverges between canonical tasks.json (${canonical}) and tasks.md (${mdStatus}); tasks.json is authoritative`, { taskId, canonical, markdownStatus: mdStatus });
      }
    }
  }

  return { checkedCompleted: audited, totalTasks: (taskState.tasks || []).length, planId: taskState.planId, orphanCompletionEvents, sideEffectFailures, derivedDivergences };
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

async function collectCompletionLedgerEvents(rootDir) {
  const taskIds = new Set();
  // 只统计通过 hash 链校验的条目，手工追加的伪造完成事件不算证据
  const entries = await readVerifiedLedgerEntries(rootDir);
  for (const entry of entries) {
    if (!COMPLETION_LEDGER_EVENT_TYPES.has(entry.type) || !entry.taskId) continue;
    // 并行 admission 事件对失败结局也会写同名类型并带 status 字段；
    // 只有真正 completed 的结局才算完成证据。
    if (entry.type === "parallel_agent_admission_completed" && entry.status && entry.status !== "completed") continue;
    taskIds.add(entry.taskId);
  }
  return taskIds;
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
  lines.push(`- Config source: ${report.sections.config.sourcePath}`);
  lines.push(`- Completed tasks audited: ${report.sections.completionAudit.checkedCompleted}`);
  lines.push(`- Ledger entries checked: ${report.sections.ledger.checked} (legacy: ${report.sections.ledger.legacy})`);
  if (report.sections.ledgerBackupCrossCheck.checked) {
    lines.push(`- Ledger vs backup ${report.sections.ledgerBackupCrossCheck.backupId}: ${report.sections.ledgerBackupCrossCheck.prefixIntact ? "history intact" : "HISTORY DIVERGED"}`);
  } else {
    lines.push(`- Ledger vs backup: not checked (${report.sections.ledgerBackupCrossCheck.reason})`);
  }
  lines.push(`- Config baseline: ${report.sections.configBaseline.status}`);
  lines.push(`- Runtime state: ${report.sections.runtimeState.status}`);
  if (report.sections.repositoryGovernance.checked) {
    lines.push(`- Repository governance: ${report.sections.repositoryGovernance.status} (${report.sections.repositoryGovernance.findingCount} findings)`);
  } else {
    lines.push("- Repository governance: not run");
  }
  return `${lines.join("\n")}\n`;
}
