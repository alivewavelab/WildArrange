#!/usr/bin/env node
// =============================================================================
// 文件名称：wildarrange.mjs
// 所属模块：bin
// 作用说明：
//   WildArrange 命令行入口：解析 argv，按子命令路由到 orchestration、
//   capabilities、infra、interface、ai 等模块；stdout 输出 JSON 契约，
//   stderr 承载人类可读摘要。不负责业务规则本身，只做参数校验与委派。
//
// 【运行原理速读】
//   可以把它想成「治理运行时的前台调度台」：
//
//   · 何时启动？
//     开发者、CI 或 IDE Hook 执行 node bin/wildarrange.mjs <command>。
//
//   · 它具体做了什么？
//     ① parseArgs 解析 --flag 与 positional；
//     ② main 按 command 分支调用对应 src/ 模块；
//     ③ 结果 JSON 写 stdout，门决策/进度写 stderr；
//     ④ 未捕获错误经 error-protocol 格式化后 exit 1。
//
//   · 和其他部分的关系？
//     hook run 注入 cli_command_prefix 后进入 host-runtime；
//     run/plan/workflow 驱动 linear-runtime；guard/doctor 走 capabilities。
//
//   · 缺了它会怎样？
//     无法初始化 .wildarrange、无法跑任务门禁，Hook 也找不到可信 CLI 前缀。
// =============================================================================
import { configureProjectReview, prepareProjectReview } from "../src/capabilities/project-review.mjs";
import { generateContractArtifacts } from "../src/interface/contract-view.mjs";
import { applyContractDecision, proposeContractChange, resolveContractChange } from "../src/orchestration/contract-governance.mjs";
import { runHostRoute, runHostHook } from "../src/orchestration/host-runtime.mjs";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { startDashboardServer } from "../src/interface/dashboard.mjs";
import {
  recoverAdoption,
  resumeAdoption,
  startAdoption,
  statusAdoption,
} from "../src/orchestration/adoption.mjs";
import { projectDecisions, projectDecisionStats } from "../src/interface/decisions.mjs";
import { projectTimeline } from "../src/interface/timeline.mjs";
import { COMMAND_REGISTRY, renderCommandsMarkdown, renderHelp } from "../src/interface/cli-help.mjs";
import { adapterCliPrefix, installAdapter, restoreAdapterBackup, uninstallAdapter } from "../src/interface/adapters.mjs";
import { runDoctor } from "../src/interface/doctor.mjs";
import {
  acceptTaskHandoff,
  prepareTaskHandoff,
  pushTaskHandoff,
  takeoverTaskOwnership,
} from "../src/orchestration/handoff.mjs";
import {
  admitParallelAgentResult,
  cleanupParallelAgentRun,
  closeParallelAgentRun,
  listParallelAgentRuns,
  parallelAgentStatus,
  retryParallelAgentRun,
  runParallelAgents,
} from "../src/orchestration/parallel-runtime.mjs";
import {
  coordinationStatus,
  registerCoordinationDevice,
} from "../src/orchestration/remote-ownership.mjs";
import {
  listChangeRequests,
  recordReviewBlocker,
  resolveChangeRequest,
  reviewChangeRequest,
  steerWorkflow,
} from "../src/orchestration/change-governance.mjs";
import {
  claimTeamTask,
  createTeamTask,
  getTeamTask,
  listTeamMessages,
  listTeamTasks,
  migrateTaskLedgerState,
  readyTeamTask,
  recordTaskEvidence,
  sendTeamMessage,
} from "../src/orchestration/task-board.mjs";
import { archiveTeamTaskWithBackup } from "../src/orchestration/task-archive.mjs";
import { approvePlan, importPlan, loadPlanApproval } from "../src/orchestration/plan-state.mjs";
import { statusReport, writeWorkflowSummary } from "../src/orchestration/status.mjs";
import { createSamplePlan, runWorkflow } from "../src/orchestration/workflow.mjs";
import { runNextTask, runWorkflowNode } from "../src/orchestration/linear-runtime.mjs";
import {
  buildArchivistPacket,
  listArchivistRouteSuggestions,
  resolveArchivistRouteSuggestion,
  runArchivistRouter,
} from "../src/ai/archivist-router.mjs";
import {
  buildAgentContext,
  continuationDirective,
  resumeReport,
} from "../src/ai/context.mjs";
import { matchSkills } from "../src/ai/skill-matcher.mjs";
import { resolveInjectionPoint } from "../src/ai/injection.mjs";
import { runInjectionHook } from "../src/ai/hooks.mjs";
import { TRUSTED_CLI_COMMAND_PREFIX } from "../src/ai/pre-tool-guard.mjs";
import { routeRequest } from "../src/ai/routing.mjs";
import { runSuspicionReview } from "../src/ai/suspicion-review.mjs";
import { runRepositoryGovernanceAudit } from "../src/capabilities/repository-governance.mjs";
import { invokeCapability } from "../src/capabilities/gateway.mjs";
import { scopeGuard } from "../src/capabilities/scope-guard.mjs";
import {
  annotationStats,
  appendAnnotation,
  readAnnotations,
} from "../src/infra/annotation-log.mjs";
import { computeImpact } from "../src/infra/dependency-graph.mjs";
import { runRepoTests, selectRepoTests } from "../src/infra/test-runner.mjs";
import { errorProtocolOf, formatErrorInline } from "../src/infra/error-protocol.mjs";
import { hashContent } from "../src/infra/runtime-store.mjs";
import { verifyLedger } from "../src/infra/ledger.mjs";
import { listPromptPack, renderPromptPackEntry } from "../src/infra/prompt-pack.mjs";
import { scanProjectRules } from "../src/infra/rule-scanner.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { resolveRuntimeCliCommandPrefix } from "../src/infra/runtime-snapshot.mjs";
import {
  DEFAULT_PACKAGE_NAME,
  loadWildArrangeConfig,
  migrateRuntimeConfigState,
  writeDefaultWildArrangeConfig,
} from "../src/infra/runtime-config.mjs";
import { readJson } from "../src/infra/runtime-store.mjs";
import {
  listRuntimeStateBackups,
  restoreRuntimeStateBackup,
  verifyConfigBaseline,
  verifyRuntimeState,
  writeConfigBaseline,
  writeRuntimeStateBackup,
} from "../src/infra/security.mjs";
import { initProjectDocuments } from "../src/interface/project-init.mjs";

// --- CLI 参数解析 ---

/**
 * 将 process.argv 切片解析为 { _: positional[], --key: string|true } 结构。
 * @param {string[]} argv 不含 node 与脚本路径的参数列表
 * @returns {{ _: string[], [key: string]: string | boolean | string[] }}
 */
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

// parseArgs 的取值只有两种形态：带值时是字符串，裸标志时是 true。
// strArg 把缺省、裸标志与空串统一收敛为 undefined，代替散落的 `!== true` 手工守卫。
/**
 * 从 parseArgs 结果中安全取出字符串参数；裸标志或空串返回 undefined。
 * @param {Record<string, unknown>} args parseArgs 返回值
 * @param {string} key 参数名（不含 -- 前缀）
 * @returns {string|undefined}
 */
function strArg(args, key) {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 将逗号分隔 CLI 字符串拆成去空白后的数组；非字符串输入返回 []。
 * @param {unknown} value --writable 等逗号列表原始值
 * @returns {string[]}
 */
function splitCliList(value) {
  if (typeof value !== "string") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * 向 stdout 输出 CLI 帮助文本。
 * @param {{ all?: boolean }} [options] all=true 时列出全部子命令
 */
function printHelp({ all = false } = {}) {
  console.log(renderHelp({ all }));
}

// --- 命令分发：main ---

/**
 * CLI 主入口：解析 command 后路由到各 src/ 模块并输出 JSON。
 * control-root 未指定时使用 process.cwd() 作为项目根。
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const rootDir = strArg(args, "control-root")
    ? path.resolve(String(args["control-root"]))
    : process.cwd();

  // --- 帮助与文档 ---
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

  // --- 初始化与配置 ---
  if (command === "init") {
    await initRuntime(rootDir);
    const projectDocuments = args["project-docs"] === true
      ? await initProjectDocuments(rootDir, { architecture: args.architecture === true })
      : null;
    let samplePath = null;
    if (args.sample) {
      samplePath = await createSamplePlan(rootDir);
    }
    console.log(JSON.stringify({
      ok: true,
      runtime: path.join(rootDir, ".wildarrange"),
      samplePlan: samplePath,
      projectDocuments,
    }, null, 2));
    return;
  }

  if (command === "config") {
    const subcommand = args._[1];
    if (subcommand === "init") {
      await initRuntime(rootDir);
      console.log(JSON.stringify(await writeDefaultWildArrangeConfig(rootDir, {
        root: Boolean(args.root),
        force: Boolean(args.force),
        armed: Boolean(args.armed),
      }), null, 2));
      return;
    }
    if (subcommand === "show") {
      console.log(JSON.stringify(await loadWildArrangeConfig(rootDir), null, 2));
      return;
    }
    if (subcommand === "baseline") {
      console.log(JSON.stringify(await writeConfigBaseline(rootDir, {
        reason: strArg(args, "reason") || "manual",
      }), null, 2));
      return;
    }
    if (subcommand === "verify") {
      const result = await verifyConfigBaseline(rootDir);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    throw new Error("wildarrange config requires init, show, baseline, or verify");
  }

  // --- 宿主适配器 ---
  if (command === "adapter") {
    const subcommand = args._[1];
    if (subcommand === "install") {
      console.log(JSON.stringify(await installAdapter(rootDir, {
        target: strArg(args, "target") || "all",
        mode: strArg(args, "mode") || "local",
        packageName: strArg(args, "package") || DEFAULT_PACKAGE_NAME,
      }), null, 2));
      return;
    }
    if (subcommand === "uninstall") {
      console.log(JSON.stringify(await uninstallAdapter(rootDir, {
        target: strArg(args, "target") || "all",
      }), null, 2));
      return;
    }
    if (subcommand === "restore") {
      if (!strArg(args, "backup")) throw new Error("wildarrange adapter restore requires --backup <backupId>");
      console.log(JSON.stringify(await restoreAdapterBackup(rootDir, {
        backupId: args.backup,
      }), null, 2));
      return;
    }
    throw new Error("wildarrange adapter requires install, uninstall, or restore");
  }

  // --- 多设备协调 ---
  if (command === "device") {
    const subcommand = args._[1];
    if (subcommand === "register") {
      console.log(JSON.stringify(await registerCoordinationDevice(rootDir, {
        name: strArg(args, "name"),
        force: Boolean(args.force),
      }), null, 2));
      return;
    }
    if (subcommand === "status") {
      console.log(JSON.stringify((await coordinationStatus(rootDir)).device, null, 2));
      return;
    }
    throw new Error("wildarrange device requires register or status");
  }

  if (command === "coordination") {
    const subcommand = args._[1];
    if (subcommand === "status") {
      console.log(JSON.stringify(await coordinationStatus(rootDir), null, 2));
      return;
    }
    if (subcommand === "claim") {
      if (!strArg(args, "task")) throw new Error("wildarrange coordination claim requires --task <taskId>");
      console.log(JSON.stringify(await claimTeamTask(rootDir, {
        taskId: args.task,
        owner: strArg(args, "owner"),
        forceCoordination: true,
      }), null, 2));
      return;
    }
    throw new Error("wildarrange coordination requires status or claim");
  }

  // --- 任务交接 ---
  if (command === "handoff") {
    const subcommand = args._[1];
    if (subcommand === "prepare") {
      if (!strArg(args, "task")) throw new Error("wildarrange handoff prepare requires --task <taskId>");
      if (!strArg(args, "to-device-id")) throw new Error("wildarrange handoff prepare requires --to-device-id <uuid>");
      console.log(JSON.stringify(await prepareTaskHandoff(rootDir, {
        taskId: args.task,
        toDeviceId: args["to-device-id"],
        toDeviceName: strArg(args, "to-device-name"),
        toOwner: strArg(args, "to-owner"),
      }), null, 2));
      return;
    }
    if (subcommand === "push") {
      if (!strArg(args, "task")) throw new Error("wildarrange handoff push requires --task <taskId>");
      console.log(JSON.stringify(await pushTaskHandoff(rootDir, { taskId: args.task }), null, 2));
      return;
    }
    if (subcommand === "accept") {
      if (!strArg(args, "task")) throw new Error("wildarrange handoff accept requires --task <taskId>");
      console.log(JSON.stringify(await acceptTaskHandoff(rootDir, {
        taskId: args.task,
        planId: strArg(args, "plan"),
      }), null, 2));
      return;
    }
    if (subcommand === "takeover") {
      if (!strArg(args, "plan")) throw new Error("wildarrange handoff takeover requires --plan <planId>");
      if (!strArg(args, "task")) throw new Error("wildarrange handoff takeover requires --task <taskId>");
      if (!strArg(args, "expected-device-id")) throw new Error("wildarrange handoff takeover requires --expected-device-id <uuid>");
      console.log(JSON.stringify(await takeoverTaskOwnership(rootDir, {
        planId: args.plan,
        taskId: args.task,
        expectedDeviceId: args["expected-device-id"],
        owner: strArg(args, "owner"),
        reason: args.reason,
      }), null, 2));
      return;
    }
    throw new Error("wildarrange handoff requires prepare, push, accept, or takeover");
  }

  // --- 注入点预览 ---
  if (command === "injection") {
    const subcommand = args._[1];
    if (subcommand === "show") {
      if (!strArg(args, "point")) throw new Error("wildarrange injection show requires --point <name>");
      console.log(JSON.stringify(await resolveInjectionPoint(rootDir, args.point, {
        agent: strArg(args, "agent") || "",
        taskId: strArg(args, "task") || "",
        planId: strArg(args, "plan") || "",
      }, {
        text: strArg(args, "text") || "",
        stage: strArg(args, "stage") || "",
      }), null, 2));
      return;
    }
    throw new Error("wildarrange injection requires show");
  }

  // --- 宿主 Hook 执行 ---
  if (command === "hook") {
    const subcommand = args._[1];
    if (subcommand === "run") {
      const payload = strArg(args, "from")
        ? await readJson(path.resolve(rootDir, args.from))
        : JSON.parse(await readAllStdin());
      const hostAdapter = strArg(args, "host") || String(process.env.WILDARRANGE_HOST_ADAPTER || "");
      if (hostAdapter) payload.host_adapter = hostAdapter;
      const hasAdapterMode = strArg(args, "adapter-mode") !== undefined;
      const adapterMode = hasAdapterMode ? String(args["adapter-mode"]) : "local";
      const adapterPackage = strArg(args, "adapter-package") || DEFAULT_PACKAGE_NAME;
      // The hook payload originates in the host and is untrusted. Always derive
      // the command prefix from this running CLI and its generated adapter flags.
      const cliCommandPrefix = hasAdapterMode
        ? adapterCliPrefix({
          mode: adapterMode,
          packageName: adapterPackage,
          localCliPath: path.resolve(process.argv[1]),
        })
        : await resolveRuntimeCliCommandPrefix(rootDir, { fallbackCliPath: path.resolve(process.argv[1]) });
      if (!cliCommandPrefix) throw new Error("WildArrange CLI command prefix is unavailable; reinstall the adapter");
      payload.cli_command_prefix = cliCommandPrefix;
      payload[TRUSTED_CLI_COMMAND_PREFIX] = cliCommandPrefix;
      if (hostAdapter === "codex") {
        const hookConfig = await readFile(path.join(rootDir, ".codex", "hooks.json"), "utf8");
        payload.hook_config_digest = hashContent(hookConfig);
      }
      const result = await runHostHook(rootDir, payload, runInjectionHook);
      if (args.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        process.stdout.write(result.output);
      }
      return;
    }
    throw new Error("wildarrange hook requires run");
  }

  // --- 计划导入与审批 ---
  if (command === "plan") {
    if (args._[1] === "approve") {
      await initRuntime(rootDir);
      const result = await approvePlan(rootDir, {
        planId: strArg(args, "plan"),
        approver: strArg(args, "by"),
        note: strArg(args, "note"),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (!args.from) throw new Error("wildarrange plan requires --from <plan.json>（或 wildarrange plan approve 确认已导入计划）");
    await initRuntime(rootDir);
    const plan = await importPlan(rootDir, path.resolve(rootDir, args.from), { requireResponsibility: true });
    const approval = await loadPlanApproval(rootDir);
    console.log(JSON.stringify({
      ok: true,
      planId: plan.id,
      taskCount: plan.tasks.length,
      responsibilityChanges: plan.tasks.map((task) => ({ taskId: task.id, changes: task.responsibilityChanges })),
      approvalRequired: approval.required,
      approvalStatus: approval.status,
      nextStep: approval.required && approval.status !== "approved"
        ? "计划待开发者确认；确认后才可 run。执行 node ./bin/wildarrange.mjs plan approve 或在编辑器里用 /wildarrange-approve。"
        : "可直接 node ./bin/wildarrange.mjs run。",
    }, null, 2));
    return;
  }

  // --- 线性任务执行 ---
  if (command === "run") {
    const runStartedAt = new Date().toISOString();
    const result = await runNextTask(rootDir);
    console.log(JSON.stringify(result, null, 2));
    // 汇报分级（reporting.verbosity）：run 结束在 stderr 输出一次门决策
    // 汇总，stdout 的 JSON 契约不变。verbose=逐门三行投影；normal=一行；
    // quiet=不输出。框架初期默认 verbose，让人能审判每一条门决策。
    // 汇总只含本次 run 的决策（since=run 开始时间），不混历史记录。
    const { config } = await loadWildArrangeConfig(rootDir);
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

  // --- 工作流批量推进 ---
  if (command === "workflow") {
    if (!args.from && !args.sample) throw new Error("wildarrange workflow requires --from <plan.json> or --sample");
    const result = await runWorkflow(rootDir, {
      planPath: args.from ? path.resolve(rootDir, args.from) : null,
      sample: Boolean(args.sample),
      maxSteps: Number.isInteger(Number(args.maxSteps)) && args.maxSteps !== true ? Number(args.maxSteps) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 2;
    return;
  }

  // --- 并行 Agent 运行 ---
  if (command === "parallel") {
    const subcommand = args._[1];
    if (subcommand === "run") {
      console.log(JSON.stringify(await runParallelAgents(rootDir, {
        maxAgents: strArg(args, "max-agents") ? Number(args["max-agents"]) : undefined,
        taskIds: strArg(args, "task") ? String(args.task).split(",").map((item) => item.trim()).filter(Boolean) : [],
        agent: strArg(args, "agent"),
        adapter: strArg(args, "adapter"),
        isolation: strArg(args, "isolation"),
        command: strArg(args, "command"),
        timeoutMs: strArg(args, "timeout") ? Number(args.timeout) : undefined,
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
        runId: strArg(args, "run"),
      }), null, 2));
      return;
    }
    if (subcommand === "close") {
      if (!strArg(args, "run")) throw new Error("wildarrange parallel close requires --run <runId>");
      console.log(JSON.stringify(await closeParallelAgentRun(rootDir, {
        runId: args.run,
        taskId: strArg(args, "task"),
        reason: strArg(args, "reason"),
      }), null, 2));
      return;
    }
    if (subcommand === "cleanup") {
      if (!strArg(args, "run")) throw new Error("wildarrange parallel cleanup requires --run <runId>");
      console.log(JSON.stringify(await cleanupParallelAgentRun(rootDir, {
        runId: args.run,
      }), null, 2));
      return;
    }
    if (subcommand === "retry") {
      if (!strArg(args, "run")) throw new Error("wildarrange parallel retry requires --run <runId>");
      console.log(JSON.stringify(await retryParallelAgentRun(rootDir, {
        runId: args.run,
        command: strArg(args, "command"),
        agent: strArg(args, "agent"),
        isolation: strArg(args, "isolation"),
        maxAgents: strArg(args, "max-agents") ? Number(args["max-agents"]) : undefined,
        timeoutMs: strArg(args, "timeout") ? Number(args.timeout) : undefined,
      }), null, 2));
      return;
    }
    if (subcommand === "admit") {
      if (!strArg(args, "run")) throw new Error("wildarrange parallel admit requires --run <runId>");
      if (!strArg(args, "task")) throw new Error("wildarrange parallel admit requires --task <taskId>");
      console.log(JSON.stringify(await admitParallelAgentResult(rootDir, {
        runId: args.run,
        taskId: args.task,
      }), null, 2));
      return;
    }
    throw new Error("wildarrange parallel requires run, admit, list, status, close, or cleanup");
  }

  // --- 档案员路由 ---
  if (command === "archivist") {
    const subcommand = args._[1];
    const turns = strArg(args, "turns")
      ? await readJson(path.resolve(rootDir, args.turns))
      : [];
    const options = {
      text: strArg(args, "text") || "",
      stage: strArg(args, "stage"),
      trigger: strArg(args, "trigger") || "cli",
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
        if (!strArg(args, "id")) throw new Error("wildarrange archivist suggestions resolve requires --id <id>");
        console.log(JSON.stringify(await resolveArchivistRouteSuggestion(rootDir, {
          id: args.id,
          decision: args.decision,
          evidence: strArg(args, "evidence") || "",
          rationale: strArg(args, "rationale") || "",
        }), null, 2));
        return;
      }
      throw new Error("wildarrange archivist suggestions requires list or resolve");
    }
    throw new Error("wildarrange archivist requires packet, run, or suggestions");
  }

  // --- 单工作流节点 ---
  if (command === "node") {
    const nodeName = args._[1];
    if (!nodeName) throw new Error("wildarrange node requires route, execute, verify, scope, review, checkpoint, or retry");
    const result = await runWorkflowNode(rootDir, nodeName, {
      taskId: args.task === true ? undefined : args.task,
      text: args.text === true ? undefined : args.text,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // --- 状态与影响分析 ---
  if (command === "status") {
    console.log(JSON.stringify(await statusReport(rootDir), null, 2));
    return;
  }

  if (command === "impact") {
    const changed = args._.slice(1);
    if (changed.length === 0) throw new Error("wildarrange impact requires at least one changed file path, e.g. wildarrange impact src/infra/ledger.mjs");
    console.log(JSON.stringify(await computeImpact(rootDir, changed), null, 2));
    return;
  }

  // --- 门决策与时间线 ---
  if (command === "decisions") {
    if (args._[1] === "stats") {
      console.log(JSON.stringify(await projectDecisionStats(rootDir), null, 2));
      return;
    }
    let limit = 50;
    if (args.limit !== undefined && args.limit !== true) {
      const parsed = Number(args.limit);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("wildarrange decisions --limit must be a non-negative integer");
      }
      limit = parsed;
    }
    const projection = await projectDecisions(rootDir, {
      limit,
      taskId: strArg(args, "task"),
      gate: strArg(args, "gate"),
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
      taskId: strArg(args, "task"),
      source: strArg(args, "source"),
      format: args.format === "json" ? "json" : undefined,
    });
    if (args.format === "json") {
      console.log(JSON.stringify(projection, null, 2));
    } else {
      process.stdout.write(`${projection.text}\n`);
    }
    return;
  }

  // --- 审查与就绪 ---
  if (command === "review" && args._[1] === "configure") {
    if (!strArg(args, "from")) throw new Error("review configure requires --from <setup.json>");
    console.log(JSON.stringify(await configureProjectReview(rootDir, args.from, { apply: args.apply === true }), null, 2));
    return;
  }
  if ((command === "review" && args._[1] === "checklist") || command === "readiness") {
    if (!strArg(args, "task")) throw new Error("this command requires --task <taskId>");
    const { task } = await getTeamTask(rootDir, args.task);
    if (command === "readiness") {
      const approval = await loadPlanApproval(rootDir);
      if (approval.required && approval.status !== "approved") { console.log(JSON.stringify({ status: "awaiting_plan_approval" })); return; }
      const result = await invokeCapability("execution-readiness", { rootDir, task });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "pass") process.exitCode = 1;
    } else {
      const { config } = await loadWildArrangeConfig(rootDir);
      console.log(JSON.stringify(await prepareProjectReview(rootDir, task, config), null, 2));
    }
    return;
  }
  if (command === "adoption" && args._[1] === "inventory") {
    console.log(JSON.stringify(await invokeCapability("verification-governance-scan", { rootDir }), null, 2));
    return;
  }
  if (command === "review" && args._[1] === "suspicious") {
    const report = await runSuspicionReview(rootDir, {
      limit: Number.isInteger(Number(args.limit)) && args.limit !== true ? Number(args.limit) : undefined,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // --- 人工标注 ---
  if (command === "annotate") {
    const subcommand = args._[1];
    if (subcommand === "list") {
      const { records, skippedLines } = await readAnnotations(rootDir);
      const limit = Number.isInteger(Number(args.limit)) && args.limit !== true ? Number(args.limit) : 50;
      console.log(JSON.stringify({
        kind: "wildarrange_annotations",
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
      decisionId: strArg(args, "decision"),
      category: strArg(args, "category"),
      reason: strArg(args, "reason"),
      author: strArg(args, "author"),
    });
    console.log(JSON.stringify({ kind: "wildarrange_annotation", recorded: entry }, null, 2));
    return;
  }

  // --- 仓库测试 ---
  if (command === "test") {
    const positional = args._.slice(1);
    if (strArg(args, "zone") && positional.length > 0) {
      throw new Error("wildarrange test: --zone 与文件参数互斥，请只选一种选择方式");
    }
    const { tests, selectionNote } = await selectRepoTests(rootDir, {
      zone: strArg(args, "zone"),
      changedPaths: positional,
    });
    console.error(`[wildarrange test] ${selectionNote}`);
    for (const file of tests) console.error(`[wildarrange test]   ${file}`);
    process.exitCode = runRepoTests(rootDir, tests);
    return;
  }

  // --- 摘要与续跑 ---
  if (command === "summary") {
    console.log(JSON.stringify(await writeWorkflowSummary(rootDir, { reason: "cli" }), null, 2));
    return;
  }

  if (command === "continuation") {
    const subcommand = args._[1];
    if (subcommand === "check") {
      console.log(JSON.stringify(await continuationDirective(rootDir, {
        sessionId: strArg(args, "session"),
        source: "cli",
      }), null, 2));
      return;
    }
    throw new Error("wildarrange continuation requires check");
  }

  if (command === "rules") {
    const subcommand = args._[1];
    if (subcommand === "collect") {
      const targetPaths = strArg(args, "target") ? [args.target] : [];
      console.log(JSON.stringify(await scanProjectRules(rootDir, { targetPaths }), null, 2));
      return;
    }
    throw new Error("wildarrange rules requires collect");
  }

  // --- 仓库治理审计 ---
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
    throw new Error("wildarrange governance requires audit");
  }

  // --- 契约治理 ---
  if (command === "contracts") {
    const subcommand = args._[1];
    if (subcommand === "propose") {
      if (!strArg(args, "task") || !strArg(args, "from")) throw new Error("contracts propose requires --task <id> --from <proposal.json>");
      console.log(JSON.stringify(await proposeContractChange(rootDir, { taskId: args.task, from: args.from }), null, 2));
      return;
    }
    if (subcommand === "resolve") {
      for (const key of ["id", "decision", "expected-fingerprint", "reason"]) {
        if (!strArg(args, key)) throw new Error(`contracts resolve requires --${key}`);
      }
      console.log(JSON.stringify(await resolveContractChange(rootDir, { id: args.id, decision: args.decision,
        expectedFingerprint: args["expected-fingerprint"], reason: args.reason }), null, 2));
      return;
    }
    if (subcommand === "scan") {
      const source = strArg(args, "from") ? await readJson(path.resolve(rootDir, args.from)) : [];
      const declarations = Array.isArray(source) ? source : source?.items || [];
      const result = await invokeCapability("contract-governance-scan", {
        rootDir,
        options: { declarations, discoverer: "tauri-ipc" },
      });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === "pass" ? 0 : 2;
      return;
    }
    if (subcommand === "apply-card") {
      if (!strArg(args, "card")) throw new Error("wildarrange contracts apply-card requires --card <cardId>");
      if (!strArg(args, "decision")) throw new Error("wildarrange contracts apply-card requires --decision approve|reject");
      if (!strArg(args, "reason")) throw new Error("wildarrange contracts apply-card requires --reason <text>");
      if (!strArg(args, "expected-fingerprint")) throw new Error("wildarrange contracts apply-card requires --expected-fingerprint <sha256>");
      const result = await applyContractDecision(rootDir, {
          cardId: args.card,
          decision: args.decision,
          reason: args.reason,
          expectedFingerprint: strArg(args, "expected-fingerprint"),
      });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === "pass" ? 0 : 2;
      return;
    }
    if (subcommand === "generate") {
      const startedAt = Date.now();
      const evidence = await generateContractArtifacts(rootDir);
      const result = { capability: "contract-governance-generate-artifacts", status: "pass", evidence,
        sideEffect: "files_changed", duration_ms: Date.now() - startedAt, cost: null, error: null };
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === "pass" ? 0 : 2;
      return;
    }
    throw new Error("wildarrange contracts requires scan, apply-card, generate, propose, or resolve");
  }

  // --- Agent 上下文 ---
  if (command === "context") {
    const subcommand = args._[1];
    if (subcommand === "build") {
      console.log(JSON.stringify(await buildAgentContext(rootDir, {
        agent: strArg(args, "agent"),
        taskId: strArg(args, "task"),
        planId: strArg(args, "plan"),
        injectionPoint: strArg(args, "point"),
      }), null, 2));
      return;
    }
    throw new Error("wildarrange context requires build");
  }

  // --- 成功标准证据 ---
  if (command === "evidence") {
    const subcommand = args._[1];
    if (subcommand === "record") {
      if (!strArg(args, "task")) throw new Error("wildarrange evidence record requires --task <taskId>");
      if (!strArg(args, "criterion")) throw new Error("wildarrange evidence record requires --criterion <criterionId>");
      console.log(JSON.stringify(await recordTaskEvidence(rootDir, {
        taskId: args.task,
        criterionId: args.criterion,
        status: strArg(args, "status") || "pass",
        evidence: args.evidence,
        source: strArg(args, "source") || "cli",
      }), null, 2));
      return;
    }
    throw new Error("wildarrange evidence requires record");
  }

  // --- 工作流转向 ---
  if (command === "steer") {
    if (!strArg(args, "from")) throw new Error("wildarrange steer requires --from <proposal.json>");
    const proposal = await readJson(path.resolve(rootDir, args.from));
    console.log(JSON.stringify(await steerWorkflow(rootDir, proposal), null, 2));
    return;
  }

  // --- 审查阻塞记录 ---
  if (command === "review-blockers") {
    const subcommand = args._[1];
    if (subcommand === "record") {
      if (!strArg(args, "from")) throw new Error("wildarrange review-blockers record requires --from <blocker.json>");
      const blocker = await readJson(path.resolve(rootDir, args.from));
      console.log(JSON.stringify(await recordReviewBlocker(rootDir, blocker), null, 2));
      return;
    }
    throw new Error("wildarrange review-blockers requires record");
  }

  // --- 任务板 ---
  if (command === "task") {
    const subcommand = args._[1];
    if (subcommand === "list") {
      console.log(JSON.stringify(await listTeamTasks(rootDir, {
        all: Boolean(args.all),
        status: strArg(args, "status"),
        owner: strArg(args, "owner"),
        workType: strArg(args, "type"),
        priority: strArg(args, "priority") ? String(args.priority).toUpperCase() : undefined,
        planId: strArg(args, "plan"),
        search: strArg(args, "search"),
      }), null, 2));
      return;
    }
    if (subcommand === "get") {
      if (!strArg(args, "task")) throw new Error("wildarrange task get requires --task <taskId>");
      console.log(JSON.stringify(await getTeamTask(rootDir, args.task, {
        planId: strArg(args, "plan"),
      }), null, 2));
      return;
    }
    if (subcommand === "claim") {
      console.log(JSON.stringify(await claimTeamTask(rootDir, {
        taskId: strArg(args, "task"),
        owner: strArg(args, "owner"),
        forceCoordination: Boolean(args.coordinate),
      }), null, 2));
      return;
    }
    if (subcommand === "create") {
      let task;
      if (strArg(args, "from")) {
        task = await readJson(path.resolve(rootDir, args.from));
      } else {
        const subject = strArg(args, "title") || strArg(args, "subject") || null;
        if (!subject) throw new Error("wildarrange task create requires --from <task.json> or --title <text>");
        task = {
          subject,
          description: strArg(args, "description") || subject,
          workType: strArg(args, "type") || "maintenance",
          priority: strArg(args, "priority") ? String(args.priority).toUpperCase() : "P1",
          source: strArg(args, "source") || "user",
          parentTaskRef: strArg(args, "parent") || null,
          writable_paths: splitCliList(args.writable),
          verify_commands: strArg(args, "verify") ? [args.verify] : [],
          review_commands: strArg(args, "review") ? [args.review] : [],
        };
      }
      console.log(JSON.stringify(await createTeamTask(rootDir, task), null, 2));
      return;
    }
    if (subcommand === "ready") {
      if (!strArg(args, "task")) throw new Error("wildarrange task ready requires --task <taskId>");
      if (!strArg(args, "from")) throw new Error("wildarrange task ready requires --from <task-details.json>");
      const patch = await readJson(path.resolve(rootDir, args.from));
      console.log(JSON.stringify(await readyTeamTask(rootDir, {
        taskId: args.task,
        planId: strArg(args, "plan"),
        patch,
      }), null, 2));
      return;
    }
    if (subcommand === "archive") {
      if (!strArg(args, "task")) throw new Error("wildarrange task archive requires --task <taskId>");
      if (args.delete !== true) throw new Error("wildarrange task archive requires explicit --delete confirmation");
      console.log(JSON.stringify(await archiveTeamTaskWithBackup(rootDir, {
        taskId: args.task,
        planId: strArg(args, "plan"),
        reason: strArg(args, "reason") || "user_archived",
      }), null, 2));
      return;
    }
    throw new Error("wildarrange task requires list, get, claim, create, ready, or archive");
  }

  // --- 团队消息 ---
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
    throw new Error("wildarrange team requires send or inbox");
  }

  // --- 会话恢复 ---
  if (command === "resume") {
    console.log(JSON.stringify(await resumeReport(rootDir, {
      sessionId: strArg(args, "session"),
      source: "cli",
    }), null, 2));
    return;
  }

  // --- 变更请求 ---
  if (command === "changes") {
    const subcommand = args._[1];
    if (subcommand === "list") {
      console.log(JSON.stringify(await listChangeRequests(rootDir), null, 2));
      return;
    }
    if (subcommand === "review") {
      if (!strArg(args, "id")) throw new Error("wildarrange changes review requires --id <CR-id>");
      console.log(JSON.stringify(await reviewChangeRequest(rootDir, args.id), null, 2));
      return;
    }
    if (subcommand === "resolve") {
      if (!strArg(args, "id")) throw new Error("wildarrange changes resolve requires --id <CR-id>");
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
    throw new Error("wildarrange changes requires list, review, or resolve");
  }

  // --- 采纳面板 ---
  if (command === "adoption") {
    const subcommand = args._[1];
    const host = strArg(args, "host") || "127.0.0.1";
    const port = strArg(args, "port") ? Number(args.port) : 8765;
    const token = strArg(args, "token")
      || process.env.WILDARRANGE_DASHBOARD_TOKEN || randomBytes(24).toString("base64url");
    const startServer = async (options) => {
      const server = await startDashboardServer(rootDir, options);
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : options.port || 8765;
      return { server, url: `http://${options.host || host}:${actualPort}/#adoption?token=${encodeURIComponent(options.token || token)}` };
    };
    if (subcommand === "start") {
      const result = await startAdoption(rootDir, { host, port, token, startServer });
      console.log(JSON.stringify(result, null, 2));
      if (result.ok && result.url) await new Promise(() => {});
      return;
    }
    if (subcommand === "status") {
      console.log(JSON.stringify(await statusAdoption(rootDir, {
        sessionId: strArg(args, "session"),
      }), null, 2));
      return;
    }
    if (subcommand === "resume") {
      const result = await resumeAdoption(rootDir, {
        sessionId: strArg(args, "session"),
        host,
        port,
        token,
        startServer,
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.ok && result.url) await new Promise(() => {});
      return;
    }
    if (subcommand === "recover") {
      const result = await recoverAdoption(rootDir, {
        sessionId: strArg(args, "session"),
      });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    throw new Error("wildarrange adoption requires start, status, resume, or recover");
  }

  // --- Dashboard 服务 ---
  if (command === "serve") {
    const host = strArg(args, "host") || "127.0.0.1";
    const port = strArg(args, "port") ? Number(args.port) : 8765;
    const token = strArg(args, "token");
    await startDashboardServer(rootDir, { host, port, token });
    console.log(JSON.stringify({ ok: true, url: `http://${host}:${port}/` }, null, 2));
    await new Promise(() => {});
  }

  // --- 账本与运行时状态 ---
  if (command === "ledger") {
    const subcommand = args._[1];
    if (subcommand === "verify") {
      const result = await verifyLedger(rootDir);
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 2;
      return;
    }
    throw new Error("wildarrange ledger requires verify");
  }

  if (command === "state") {
    const subcommand = args._[1];
    if (subcommand === "backup") {
      console.log(JSON.stringify(await writeRuntimeStateBackup(rootDir, {
        reason: strArg(args, "reason") || "manual",
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
      if (!strArg(args, "backup")) throw new Error("wildarrange state restore requires --backup <backupId>");
      console.log(JSON.stringify(await restoreRuntimeStateBackup(rootDir, { backupId: args.backup }), null, 2));
      return;
    }
    if (subcommand === "migrate") {
      const backup = await writeRuntimeStateBackup(rootDir, { reason: "pre-state-migrate" });
      const config = await migrateRuntimeConfigState(rootDir);
      const tasks = await migrateTaskLedgerState(rootDir);
      console.log(JSON.stringify({
        kind: "runtime_state_migration",
        status: "migrated",
        backupId: backup.backupId,
        config,
        tasks,
      }, null, 2));
      return;
    }
    throw new Error("wildarrange state requires backup, verify, list, restore, or migrate");
  }

  // --- 体检与门禁 ---
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
    throw new Error("wildarrange guard requires scope");
  }

  // --- 模型路由与 Prompt ---
  if (command === "route") {
    if (!strArg(args, "text")) throw new Error("wildarrange route requires --text <request>");
    console.log(JSON.stringify(await runHostRoute(rootDir, { text: args.text }, routeRequest), null, 2));
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
      console.log(content);
      return;
    }
    throw new Error("wildarrange prompts requires list or show");
  }

  if (command === "skills") {
    const subcommand = args._[1];
    if (subcommand === "match") {
      await initRuntime(rootDir);
      console.log(JSON.stringify(await matchSkills(rootDir, {
        text: strArg(args, "text") || "",
        stage: strArg(args, "stage"),
        agent: strArg(args, "agent"),
        category: strArg(args, "category"),
        skills: strArg(args, "skills"),
        limit: strArg(args, "limit") ? Number(args.limit) : undefined,
      }), null, 2));
      return;
    }
    throw new Error("wildarrange skills requires match");
  }

  throw new Error(`unknown command: ${command}`);
}

// --- stdin 读取与进程入口 ---

/**
 * 从 stdin 读取 Hook JSON 载荷；TTY 或无内容时抛错。
 * @returns {Promise<string>} 原始 JSON 字符串
 */
async function readAllStdin() {
  if (process.stdin.isTTY) {
    throw new Error("wildarrange hook run requires --from <hook.json> or JSON on stdin");
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
    module: "bin/wildarrange.mjs",
    nextAction: "运行 node ./bin/wildarrange.mjs doctor 体检；把本错误完整贴给 AI",
  });
  console.error(formatErrorInline(protocol));
  process.exit(1);
});
