#!/usr/bin/env node
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { startDashboardServer } from "../src/interface/dashboard.mjs";
import { projectDecisions, projectDecisionStats } from "../src/interface/decisions.mjs";
import { projectTimeline } from "../src/interface/timeline.mjs";
import { COMMAND_REGISTRY, renderCommandsMarkdown, renderHelp } from "../src/interface/cli-help.mjs";
import {
  DEFAULT_PACKAGE_NAME,
  acceptTaskHandoff,
  admitParallelAgentResult,
  annotationStats,
  appendAnnotation,
  readAnnotations,
  buildArchivistPacket,
  buildAgentContext,
  cleanupParallelAgentRun,
  closeParallelAgentRun,
  retryParallelAgentRun,
  computeImpact,
  computeZoneTests,
  listRepoTests,
  continuationDirective,
  createSamplePlan,
  errorProtocolOf,
  formatErrorInline,
  createTeamTask,
  approvePlan,
  claimTeamTask,
  coordinationStatus,
  getTeamTask,
  importPlan,
  installAdapter,
  initRuntime,
  loadPlanApproval,
  listArchivistRouteSuggestions,
  listParallelAgentRuns,
  loadHelixConfig,
  listTeamTasks,
  matchSkills,
  parallelAgentStatus,
  prepareTaskHandoff,
  pushTaskHandoff,
  listTeamMessages,
  listChangeRequests,
  listPromptPack,
  listRuntimeStateBackups,
  readJson,
  recordReviewBlocker,
  recordTaskEvidence,
  registerCoordinationDevice,
  renderPromptPackEntry,
  resolvePromptVariant,
  resolveInjectionPoint,
  resolveArchivistRouteSuggestion,
  resolveChangeRequest,
  restoreRuntimeStateBackup,
  resumeReport,
  reviewChangeRequest,
  runArchivistRouter,
  runDoctor,
  routeRequest,
  runInjectionHook,
  runParallelAgents,
  runRepositoryGovernanceAudit,
  runWorkflowNode,
  runNextTask,
  runSuspicionReview,
  runWorkflow,
  scopeGuard,
  sendTeamMessage,
  scanProjectRules,
  statusReport,
  steerWorkflow,
  takeoverTaskOwnership,
  uninstallAdapter,
  verifyLedger,
  verifyConfigBaseline,
  verifyRuntimeState,
  restoreAdapterBackup,
  writeConfigBaseline,
  writeDefaultHelixConfig,
  writeRuntimeStateBackup,
  writeWorkflowSummary,
} from "../src/helix-core.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function printHelp({ all = false } = {}) {
  console.log(renderHelp({ all }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const rootDir = process.cwd();

  if (!command || command === "help" || command === "--help") {
    printHelp({ all: args.all === true || args._[1] === "--all" });
    return;
  }

  if (command === "docs" && args._[1] === "commands") {
    const markdown = renderCommandsMarkdown();
    if (args.write === true) {
      const target = path.join(rootDir, "doc", "generated", "commands.md");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, markdown, "utf8");
      console.log(JSON.stringify({ ok: true, path: path.relative(rootDir, target), commands: COMMAND_REGISTRY.length }));
    } else {
      process.stdout.write(markdown);
    }
    return;
  }

  if (command === "init") {
    await initRuntime(rootDir);
    let samplePath = null;
    if (args.sample) {
      samplePath = await createSamplePlan(rootDir);
    }
    console.log(JSON.stringify({ ok: true, runtime: path.join(rootDir, ".helix"), samplePlan: samplePath }, null, 2));
    return;
  }

  if (command === "config") {
    const subcommand = args._[1];
    if (subcommand === "init") {
      await initRuntime(rootDir);
      console.log(JSON.stringify(await writeDefaultHelixConfig(rootDir, {
        root: Boolean(args.root),
        force: Boolean(args.force),
        armed: Boolean(args.armed),
      }), null, 2));
      return;
    }
    if (subcommand === "show") {
      console.log(JSON.stringify(await loadHelixConfig(rootDir), null, 2));
      return;
    }
    if (subcommand === "baseline") {
      console.log(JSON.stringify(await writeConfigBaseline(rootDir, {
        reason: args.reason && args.reason !== true ? args.reason : "manual",
      }), null, 2));
      return;
    }
    if (subcommand === "verify") {
      const result = await verifyConfigBaseline(rootDir);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    throw new Error("helix config requires init, show, baseline, or verify");
  }

  if (command === "adapter") {
    const subcommand = args._[1];
    if (subcommand === "install") {
      console.log(JSON.stringify(await installAdapter(rootDir, {
        target: args.target && args.target !== true ? args.target : "all",
        mode: args.mode && args.mode !== true ? args.mode : "local",
        packageName: args.package && args.package !== true ? args.package : DEFAULT_PACKAGE_NAME,
      }), null, 2));
      return;
    }
    if (subcommand === "uninstall") {
      console.log(JSON.stringify(await uninstallAdapter(rootDir, {
        target: args.target && args.target !== true ? args.target : "all",
      }), null, 2));
      return;
    }
    if (subcommand === "restore") {
      if (!args.backup || args.backup === true) throw new Error("helix adapter restore requires --backup <backupId>");
      console.log(JSON.stringify(await restoreAdapterBackup(rootDir, {
        backupId: args.backup,
      }), null, 2));
      return;
    }
    throw new Error("helix adapter requires install, uninstall, or restore");
  }

  if (command === "device") {
    const subcommand = args._[1];
    if (subcommand === "register") {
      console.log(JSON.stringify(await registerCoordinationDevice(rootDir, {
        name: args.name && args.name !== true ? args.name : undefined,
        force: Boolean(args.force),
      }), null, 2));
      return;
    }
    if (subcommand === "status") {
      console.log(JSON.stringify((await coordinationStatus(rootDir)).device, null, 2));
      return;
    }
    throw new Error("helix device requires register or status");
  }

  if (command === "coordination") {
    const subcommand = args._[1];
    if (subcommand === "status") {
      console.log(JSON.stringify(await coordinationStatus(rootDir), null, 2));
      return;
    }
    if (subcommand === "claim") {
      if (!args.task || args.task === true) throw new Error("helix coordination claim requires --task <taskId>");
      console.log(JSON.stringify(await claimTeamTask(rootDir, {
        taskId: args.task,
        owner: args.owner && args.owner !== true ? args.owner : undefined,
        forceCoordination: true,
      }), null, 2));
      return;
    }
    throw new Error("helix coordination requires status or claim");
  }

  if (command === "handoff") {
    const subcommand = args._[1];
    if (subcommand === "prepare") {
      if (!args.task || args.task === true) throw new Error("helix handoff prepare requires --task <taskId>");
      if (!args["to-device-id"] || args["to-device-id"] === true) throw new Error("helix handoff prepare requires --to-device-id <uuid>");
      console.log(JSON.stringify(await prepareTaskHandoff(rootDir, {
        taskId: args.task,
        toDeviceId: args["to-device-id"],
        toDeviceName: args["to-device-name"] && args["to-device-name"] !== true ? args["to-device-name"] : undefined,
        toOwner: args["to-owner"] && args["to-owner"] !== true ? args["to-owner"] : undefined,
      }), null, 2));
      return;
    }
    if (subcommand === "push") {
      if (!args.task || args.task === true) throw new Error("helix handoff push requires --task <taskId>");
      console.log(JSON.stringify(await pushTaskHandoff(rootDir, { taskId: args.task }), null, 2));
      return;
    }
    if (subcommand === "accept") {
      if (!args.task || args.task === true) throw new Error("helix handoff accept requires --task <taskId>");
      console.log(JSON.stringify(await acceptTaskHandoff(rootDir, {
        taskId: args.task,
        planId: args.plan && args.plan !== true ? args.plan : undefined,
      }), null, 2));
      return;
    }
    if (subcommand === "takeover") {
      if (!args.plan || args.plan === true) throw new Error("helix handoff takeover requires --plan <planId>");
      if (!args.task || args.task === true) throw new Error("helix handoff takeover requires --task <taskId>");
      if (!args["expected-device-id"] || args["expected-device-id"] === true) throw new Error("helix handoff takeover requires --expected-device-id <uuid>");
      console.log(JSON.stringify(await takeoverTaskOwnership(rootDir, {
        planId: args.plan,
        taskId: args.task,
        expectedDeviceId: args["expected-device-id"],
        owner: args.owner && args.owner !== true ? args.owner : undefined,
        reason: args.reason,
      }), null, 2));
      return;
    }
    throw new Error("helix handoff requires prepare, push, accept, or takeover");
  }

  if (command === "injection") {
    const subcommand = args._[1];
    if (subcommand === "show") {
      if (!args.point || args.point === true) throw new Error("helix injection show requires --point <name>");
      console.log(JSON.stringify(await resolveInjectionPoint(rootDir, args.point, {
        agent: args.agent && args.agent !== true ? args.agent : "",
        taskId: args.task && args.task !== true ? args.task : "",
        planId: args.plan && args.plan !== true ? args.plan : "",
      }, {
        text: args.text && args.text !== true ? args.text : "",
        stage: args.stage && args.stage !== true ? args.stage : "",
      }), null, 2));
      return;
    }
    throw new Error("helix injection requires show");
  }

  if (command === "hook") {
    const subcommand = args._[1];
    if (subcommand === "run") {
      const payload = args.from && args.from !== true
        ? await readJson(path.resolve(rootDir, args.from))
        : JSON.parse(await readAllStdin());
      const result = await runInjectionHook(rootDir, payload);
      if (args.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        process.stdout.write(result.output);
      }
      return;
    }
    throw new Error("helix hook requires run");
  }

  if (command === "plan") {
    if (args._[1] === "approve") {
      await initRuntime(rootDir);
      const result = await approvePlan(rootDir, {
        planId: args.plan && args.plan !== true ? args.plan : undefined,
        approver: args.by && args.by !== true ? args.by : undefined,
        note: args.note && args.note !== true ? args.note : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (!args.from) throw new Error("helix plan requires --from <plan.json>（或 helix plan approve 确认已导入计划）");
    await initRuntime(rootDir);
    const plan = await importPlan(rootDir, path.resolve(rootDir, args.from));
    const approval = await loadPlanApproval(rootDir);
    console.log(JSON.stringify({
      ok: true,
      planId: plan.id,
      taskCount: plan.tasks.length,
      approvalRequired: approval.required,
      approvalStatus: approval.status,
      nextStep: approval.required && approval.status !== "approved"
        ? "计划待开发者确认；确认后才可 run。执行 node ./bin/helix.mjs plan approve 或在编辑器里用 /helix-approve。"
        : "可直接 node ./bin/helix.mjs run。",
    }, null, 2));
    return;
  }

  if (command === "run") {
    const runStartedAt = new Date().toISOString();
    const result = await runNextTask(rootDir);
    console.log(JSON.stringify(result, null, 2));
    // 汇报分级（reporting.verbosity）：run 结束在 stderr 输出一次门决策
    // 汇总，stdout 的 JSON 契约不变。verbose=逐门三行投影；normal=一行；
    // quiet=不输出。框架初期默认 verbose，让人能审判每一条门决策。
    // 汇总只含本次 run 的决策（since=run 开始时间），不混历史记录。
    const { config } = await loadHelixConfig(rootDir);
    const verbosity = config.reporting?.verbosity || "verbose";
    const taskId = result.task?.id || result.taskId || null;
    if (verbosity !== "quiet") {
      if (verbosity === "verbose" && taskId) {
        const projection = await projectDecisions(rootDir, { taskId, since: runStartedAt, limit: 15 });
        process.stderr.write(`\n[门决策汇总] ${projection.text}\n`);
      } else {
        process.stderr.write(`[run] ${taskId || "(no task)"} -> ${result.status}\n`);
      }
    }
    return;
  }

  if (command === "workflow") {
    if (!args.from && !args.sample) throw new Error("helix workflow requires --from <plan.json> or --sample");
    const result = await runWorkflow(rootDir, {
      planPath: args.from ? path.resolve(rootDir, args.from) : null,
      sample: Boolean(args.sample),
      maxSteps: Number.isInteger(Number(args.maxSteps)) ? Number(args.maxSteps) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 2;
    return;
  }

  if (command === "parallel") {
    const subcommand = args._[1];
    if (subcommand === "run") {
      console.log(JSON.stringify(await runParallelAgents(rootDir, {
        maxAgents: args["max-agents"] && args["max-agents"] !== true ? Number(args["max-agents"]) : undefined,
        taskIds: args.task && args.task !== true ? String(args.task).split(",").map((item) => item.trim()).filter(Boolean) : [],
        agent: args.agent && args.agent !== true ? args.agent : undefined,
        adapter: args.adapter && args.adapter !== true ? args.adapter : undefined,
        isolation: args.isolation && args.isolation !== true ? args.isolation : undefined,
        command: args.command && args.command !== true ? args.command : undefined,
        timeoutMs: args.timeout && args.timeout !== true ? Number(args.timeout) : undefined,
        coordinate: Boolean(args.coordinate),
      }), null, 2));
      return;
    }
    if (subcommand === "list") {
      console.log(JSON.stringify(await listParallelAgentRuns(rootDir), null, 2));
      return;
    }
    if (subcommand === "status") {
      console.log(JSON.stringify(await parallelAgentStatus(rootDir, {
        runId: args.run && args.run !== true ? args.run : undefined,
      }), null, 2));
      return;
    }
    if (subcommand === "close") {
      if (!args.run || args.run === true) throw new Error("helix parallel close requires --run <runId>");
      console.log(JSON.stringify(await closeParallelAgentRun(rootDir, {
        runId: args.run,
        taskId: args.task && args.task !== true ? args.task : undefined,
        reason: args.reason && args.reason !== true ? args.reason : undefined,
      }), null, 2));
      return;
    }
    if (subcommand === "cleanup") {
      if (!args.run || args.run === true) throw new Error("helix parallel cleanup requires --run <runId>");
      console.log(JSON.stringify(await cleanupParallelAgentRun(rootDir, {
        runId: args.run,
      }), null, 2));
      return;
    }
    if (subcommand === "retry") {
      if (!args.run || args.run === true) throw new Error("helix parallel retry requires --run <runId>");
      console.log(JSON.stringify(await retryParallelAgentRun(rootDir, {
        runId: args.run,
        command: args.command && args.command !== true ? args.command : undefined,
        agent: args.agent && args.agent !== true ? args.agent : undefined,
        isolation: args.isolation && args.isolation !== true ? args.isolation : undefined,
        maxAgents: args["max-agents"] && args["max-agents"] !== true ? Number(args["max-agents"]) : undefined,
        timeoutMs: args.timeout && args.timeout !== true ? Number(args.timeout) : undefined,
      }), null, 2));
      return;
    }
    if (subcommand === "admit") {
      if (!args.run || args.run === true) throw new Error("helix parallel admit requires --run <runId>");
      if (!args.task || args.task === true) throw new Error("helix parallel admit requires --task <taskId>");
      console.log(JSON.stringify(await admitParallelAgentResult(rootDir, {
        runId: args.run,
        taskId: args.task,
      }), null, 2));
      return;
    }
    throw new Error("helix parallel requires run, admit, list, status, close, or cleanup");
  }

  if (command === "archivist") {
    const subcommand = args._[1];
    const turns = args.turns && args.turns !== true
      ? await readJson(path.resolve(rootDir, args.turns))
      : [];
    const options = {
      text: args.text && args.text !== true ? args.text : "",
      stage: args.stage && args.stage !== true ? args.stage : undefined,
      trigger: args.trigger && args.trigger !== true ? args.trigger : "cli",
      turns,
      force: Boolean(args.force),
    };
    if (subcommand === "packet") {
      console.log(JSON.stringify(await buildArchivistPacket(rootDir, options), null, 2));
      return;
    }
    if (subcommand === "run") {
      console.log(JSON.stringify(await runArchivistRouter(rootDir, options), null, 2));
      return;
    }
    if (subcommand === "suggestions") {
      const action = args._[2];
      if (action === "list") {
        console.log(JSON.stringify(await listArchivistRouteSuggestions(rootDir), null, 2));
        return;
      }
      if (action === "resolve") {
        if (!args.id || args.id === true) throw new Error("helix archivist suggestions resolve requires --id <id>");
        console.log(JSON.stringify(await resolveArchivistRouteSuggestion(rootDir, {
          id: args.id,
          decision: args.decision,
          evidence: args.evidence && args.evidence !== true ? args.evidence : "",
          rationale: args.rationale && args.rationale !== true ? args.rationale : "",
        }), null, 2));
        return;
      }
      throw new Error("helix archivist suggestions requires list or resolve");
    }
    throw new Error("helix archivist requires packet, run, or suggestions");
  }

  if (command === "node") {
    const nodeName = args._[1];
    if (!nodeName) throw new Error("helix node requires route, execute, verify, scope, review, checkpoint, or retry");
    const result = await runWorkflowNode(rootDir, nodeName, {
      taskId: args.task === true ? undefined : args.task,
      text: args.text === true ? undefined : args.text,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "status") {
    console.log(JSON.stringify(await statusReport(rootDir), null, 2));
    return;
  }

  if (command === "impact") {
    const changed = args._.slice(1);
    if (changed.length === 0) throw new Error("helix impact requires at least one changed file path, e.g. helix impact src/infra/ledger.mjs");
    console.log(JSON.stringify(await computeImpact(rootDir, changed), null, 2));
    return;
  }

  if (command === "decisions") {
    if (args._[1] === "stats") {
      console.log(JSON.stringify(await projectDecisionStats(rootDir), null, 2));
      return;
    }
    let limit = 50;
    if (args.limit !== undefined && args.limit !== true) {
      const parsed = Number(args.limit);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("helix decisions --limit must be a non-negative integer");
      }
      limit = parsed;
    }
    const projection = await projectDecisions(rootDir, {
      limit,
      taskId: args.task && args.task !== true ? args.task : undefined,
      gate: args.gate && args.gate !== true ? args.gate : undefined,
      annotatable: args.annotatable === true ? true : undefined,
      format: args.format === "json" ? "json" : undefined,
    });
    if (args.format === "json") {
      console.log(JSON.stringify(projection, null, 2));
    } else {
      console.log(projection.text);
    }
    return;
  }

  if (command === "timeline") {
    const projection = await projectTimeline(rootDir, {
      limit: Number.isInteger(Number(args.limit)) && args.limit !== true ? Number(args.limit) : 50,
      taskId: args.task && args.task !== true ? args.task : undefined,
      source: args.source && args.source !== true ? args.source : undefined,
      format: args.format === "json" ? "json" : undefined,
    });
    if (args.format === "json") {
      console.log(JSON.stringify(projection, null, 2));
    } else {
      process.stdout.write(`${projection.text}\n`);
    }
    return;
  }

  if (command === "review" && args._[1] === "suspicious") {
    const report = await runSuspicionReview(rootDir, {
      limit: Number.isInteger(Number(args.limit)) && args.limit !== true ? Number(args.limit) : undefined,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (command === "annotate") {
    const subcommand = args._[1];
    if (subcommand === "list") {
      const { records, skippedLines } = await readAnnotations(rootDir);
      const limit = Number.isInteger(Number(args.limit)) && args.limit !== true ? Number(args.limit) : 50;
      console.log(JSON.stringify({
        kind: "helix_annotations",
        total: records.length,
        shown: Math.min(records.length, limit),
        skippedLines,
        records: records.slice(-limit),
      }, null, 2));
      return;
    }
    if (subcommand === "stats") {
      console.log(JSON.stringify(await annotationStats(rootDir), null, 2));
      return;
    }
    const entry = await appendAnnotation(rootDir, {
      decisionId: args.decision && args.decision !== true ? args.decision : undefined,
      category: args.category && args.category !== true ? args.category : undefined,
      reason: args.reason && args.reason !== true ? args.reason : undefined,
      author: args.author && args.author !== true ? args.author : undefined,
    });
    console.log(JSON.stringify({ kind: "helix_annotation", recorded: entry }, null, 2));
    return;
  }

  if (command === "test") {
    // 分区/影响面测试选择：把"我改了哪"映射到最小应跑测试集，
    // 退出码透传 node --test，CI 与本地表现一致。
    const positional = args._.slice(1);
    if (args.zone && args.zone !== true && positional.length > 0) {
      throw new Error("helix test: --zone 与文件参数互斥，请只选一种选择方式");
    }
    let tests;
    let selectionNote;
    if (args.zone && args.zone !== true) {
      const report = await computeZoneTests(rootDir, args.zone);
      tests = report.testsToRun;
      selectionNote = report.summary;
    } else if (positional.length > 0) {
      const report = await computeImpact(rootDir, positional);
      tests = report.testsToRun;
      selectionNote = report.summary;
    } else {
      tests = await listRepoTests(rootDir);
      selectionNote = `全量测试 ${tests.length} 个`;
    }
    console.error(`[helix test] ${selectionNote}`);
    for (const file of tests) console.error(`[helix test]   ${file}`);
    // 继承 NODE_TEST_CONTEXT 时，子进程 node --test 会误以为自己是由
    // 外层 runner 启动的 IPC 子进程而空跑退出（exit 0、零测试）——从
    // 测试进程或 npm script 里调 helix test 必须剥掉这些 runner 私有变量。
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith("NODE_TEST_")) delete childEnv[key];
    }
    const run = spawnSync(process.execPath, ["--test", ...tests], { cwd: rootDir, stdio: "inherit", env: childEnv });
    process.exitCode = typeof run.status === "number" ? run.status : 1;
    return;
  }

  if (command === "summary") {
    console.log(JSON.stringify(await writeWorkflowSummary(rootDir, { reason: "cli" }), null, 2));
    return;
  }

  if (command === "continuation") {
    const subcommand = args._[1];
    if (subcommand === "check") {
      console.log(JSON.stringify(await continuationDirective(rootDir, {
        sessionId: args.session && args.session !== true ? args.session : undefined,
        source: "cli",
      }), null, 2));
      return;
    }
    throw new Error("helix continuation requires check");
  }

  if (command === "rules") {
    const subcommand = args._[1];
    if (subcommand === "collect") {
      const targetPaths = args.target && args.target !== true ? [args.target] : [];
      console.log(JSON.stringify(await scanProjectRules(rootDir, { targetPaths }), null, 2));
      return;
    }
    throw new Error("helix rules requires collect");
  }

  if (command === "governance") {
    const subcommand = args._[1];
    if (subcommand === "audit") {
      const result = await runRepositoryGovernanceAudit(rootDir, {
        changedOnly: Boolean(args["changed-only"]),
        force: Boolean(args.force),
      });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.pass ? 0 : 2;
      return;
    }
    throw new Error("helix governance requires audit");
  }

  if (command === "context") {
    const subcommand = args._[1];
    if (subcommand === "build") {
      console.log(JSON.stringify(await buildAgentContext(rootDir, {
        agent: args.agent && args.agent !== true ? args.agent : undefined,
        taskId: args.task && args.task !== true ? args.task : undefined,
      }), null, 2));
      return;
    }
    throw new Error("helix context requires build");
  }

  if (command === "evidence") {
    const subcommand = args._[1];
    if (subcommand === "record") {
      if (!args.task || args.task === true) throw new Error("helix evidence record requires --task <taskId>");
      if (!args.criterion || args.criterion === true) throw new Error("helix evidence record requires --criterion <criterionId>");
      console.log(JSON.stringify(await recordTaskEvidence(rootDir, {
        taskId: args.task,
        criterionId: args.criterion,
        status: args.status && args.status !== true ? args.status : "pass",
        evidence: args.evidence,
        source: args.source && args.source !== true ? args.source : "cli",
      }), null, 2));
      return;
    }
    throw new Error("helix evidence requires record");
  }

  if (command === "steer") {
    if (!args.from || args.from === true) throw new Error("helix steer requires --from <proposal.json>");
    const proposal = await readJson(path.resolve(rootDir, args.from));
    console.log(JSON.stringify(await steerWorkflow(rootDir, proposal), null, 2));
    return;
  }

  if (command === "review-blockers") {
    const subcommand = args._[1];
    if (subcommand === "record") {
      if (!args.from || args.from === true) throw new Error("helix review-blockers record requires --from <blocker.json>");
      const blocker = await readJson(path.resolve(rootDir, args.from));
      console.log(JSON.stringify(await recordReviewBlocker(rootDir, blocker), null, 2));
      return;
    }
    throw new Error("helix review-blockers requires record");
  }

  if (command === "task") {
    const subcommand = args._[1];
    if (subcommand === "list") {
      console.log(JSON.stringify(await listTeamTasks(rootDir, {
        status: args.status && args.status !== true ? args.status : undefined,
        owner: args.owner && args.owner !== true ? args.owner : undefined,
      }), null, 2));
      return;
    }
    if (subcommand === "get") {
      if (!args.task || args.task === true) throw new Error("helix task get requires --task <taskId>");
      console.log(JSON.stringify(await getTeamTask(rootDir, args.task), null, 2));
      return;
    }
    if (subcommand === "claim") {
      console.log(JSON.stringify(await claimTeamTask(rootDir, {
        taskId: args.task && args.task !== true ? args.task : undefined,
        owner: args.owner && args.owner !== true ? args.owner : undefined,
        forceCoordination: Boolean(args.coordinate),
      }), null, 2));
      return;
    }
    if (subcommand === "create") {
      if (!args.from || args.from === true) throw new Error("helix task create requires --from <task.json>");
      const task = await readJson(path.resolve(rootDir, args.from));
      console.log(JSON.stringify(await createTeamTask(rootDir, task), null, 2));
      return;
    }
    throw new Error("helix task requires list, get, claim, or create");
  }

  if (command === "team") {
    const subcommand = args._[1];
    if (subcommand === "send") {
      const result = await sendTeamMessage(rootDir, {
        to: args.to,
        from: args.from,
        body: args.body,
        summary: args.summary,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (subcommand === "inbox") {
      console.log(JSON.stringify(await listTeamMessages(rootDir, {
        agent: args.agent,
      }), null, 2));
      return;
    }
    throw new Error("helix team requires send or inbox");
  }

  if (command === "resume") {
    console.log(JSON.stringify(await resumeReport(rootDir, {
      sessionId: args.session && args.session !== true ? args.session : undefined,
      source: "cli",
    }), null, 2));
    return;
  }

  if (command === "changes") {
    const subcommand = args._[1];
    if (subcommand === "list") {
      console.log(JSON.stringify(await listChangeRequests(rootDir), null, 2));
      return;
    }
    if (subcommand === "review") {
      if (!args.id || args.id === true) throw new Error("helix changes review requires --id <CR-id>");
      console.log(JSON.stringify(await reviewChangeRequest(rootDir, args.id), null, 2));
      return;
    }
    if (subcommand === "resolve") {
      if (!args.id || args.id === true) throw new Error("helix changes resolve requires --id <CR-id>");
      const result = await resolveChangeRequest(rootDir, {
        id: args.id,
        decision: args.decision,
        evidence: args.evidence,
        rationale: args.rationale,
        applyScope: Boolean(args["apply-scope"]),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    throw new Error("helix changes requires list, review, or resolve");
  }

  if (command === "serve") {
    const host = args.host && args.host !== true ? args.host : "127.0.0.1";
    const port = args.port && args.port !== true ? Number(args.port) : 8765;
    const token = args.token && args.token !== true ? args.token : undefined;
    await startDashboardServer(rootDir, { host, port, token });
    console.log(JSON.stringify({ ok: true, url: `http://${host}:${port}/` }, null, 2));
    await new Promise(() => {});
  }

  if (command === "ledger") {
    const subcommand = args._[1];
    if (subcommand === "verify") {
      const result = await verifyLedger(rootDir);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    throw new Error("helix ledger requires verify");
  }

  if (command === "state") {
    const subcommand = args._[1];
    if (subcommand === "backup") {
      console.log(JSON.stringify(await writeRuntimeStateBackup(rootDir, {
        reason: args.reason && args.reason !== true ? args.reason : "manual",
      }), null, 2));
      return;
    }
    if (subcommand === "verify") {
      const result = await verifyRuntimeState(rootDir);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    if (subcommand === "list") {
      console.log(JSON.stringify(await listRuntimeStateBackups(rootDir), null, 2));
      return;
    }
    if (subcommand === "restore") {
      if (!args.backup || args.backup === true) throw new Error("helix state restore requires --backup <backupId>");
      console.log(JSON.stringify(await restoreRuntimeStateBackup(rootDir, { backupId: args.backup }), null, 2));
      return;
    }
    throw new Error("helix state requires backup, verify, list, or restore");
  }

  if (command === "doctor") {
    const result = await runDoctor(rootDir);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 2;
    return;
  }

  if (command === "guard") {
    const subcommand = args._[1];
    if (subcommand === "scope") {
      console.log(JSON.stringify(await scopeGuard(rootDir, { taskId: args.task === true ? undefined : args.task }), null, 2));
      return;
    }
    throw new Error("helix guard requires scope");
  }

  if (command === "route") {
    if (!args.text || args.text === true) throw new Error("helix route requires --text <request>");
    console.log(JSON.stringify(await routeRequest(rootDir, { text: args.text }), null, 2));
    return;
  }

  if (command === "prompts") {
    const subcommand = args._[1];
    if (subcommand === "list") {
      await initRuntime(rootDir);
      console.log(JSON.stringify(await listPromptPack(rootDir), null, 2));
      return;
    }
    if (subcommand === "show") {
      await initRuntime(rootDir);
      const content = await renderPromptPackEntry(rootDir, {
        agent: args.agent,
        skill: args.skill,
        tools: Boolean(args.tools),
        routes: Boolean(args.routes),
      });
      if (args.variant || args.provider || args.model) {
        const variant = await resolvePromptVariant(rootDir, {
          agent: args.agent && args.agent !== true ? args.agent : undefined,
          provider: args.provider && args.provider !== true ? args.provider : undefined,
          model: args.model && args.model !== true ? args.model : undefined,
          variant: args.variant && args.variant !== true ? args.variant : undefined,
        });
        console.log(`${content.trim()}\n\n## 模型变体注入 / Model Variant\n\n${variant.content}\n`);
      } else {
        console.log(content);
      }
      return;
    }
    if (subcommand === "variant") {
      await initRuntime(rootDir);
      console.log(JSON.stringify(await resolvePromptVariant(rootDir, {
        agent: args.agent && args.agent !== true ? args.agent : undefined,
        provider: args.provider && args.provider !== true ? args.provider : undefined,
        model: args.model && args.model !== true ? args.model : undefined,
        variant: args.variant && args.variant !== true ? args.variant : undefined,
      }), null, 2));
      return;
    }
    throw new Error("helix prompts requires list, show, or variant");
  }

  if (command === "skills") {
    const subcommand = args._[1];
    if (subcommand === "match") {
      await initRuntime(rootDir);
      console.log(JSON.stringify(await matchSkills(rootDir, {
        text: args.text && args.text !== true ? args.text : "",
        stage: args.stage && args.stage !== true ? args.stage : undefined,
        agent: args.agent && args.agent !== true ? args.agent : undefined,
        category: args.category && args.category !== true ? args.category : undefined,
        skills: args.skills && args.skills !== true ? args.skills : undefined,
        limit: args.limit && args.limit !== true ? Number(args.limit) : undefined,
      }), null, 2));
      return;
    }
    throw new Error("helix skills requires match");
  }

  throw new Error(`unknown command: ${command}`);
}

async function readAllStdin() {
  if (process.stdin.isTTY) {
    throw new Error("helix hook run requires --from <hook.json> or JSON on stdin");
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new Error("empty hook payload");
  return raw;
}

main().catch((error) => {
  const protocol = errorProtocolOf(error, {
    code: "cli_error",
    module: "bin/helix.mjs",
    nextAction: "运行 node ./bin/helix.mjs doctor 体检；把本错误完整贴给 AI",
  });
  console.error(formatErrorInline(protocol));
  process.exit(1);
});
