#!/usr/bin/env node
import path from "node:path";
import { startDashboardServer } from "../src/helix-dashboard.mjs";
import {
  DEFAULT_EXECUTOR_AGENT,
  DEFAULT_LEAD_AGENT,
  DEFAULT_PACKAGE_NAME,
  PRODUCT_NAME,
  admitParallelAgentResult,
  buildArchivistPacket,
  buildAgentContext,
  continuationDirective,
  createSamplePlan,
  createTeamTask,
  claimTeamTask,
  getTeamTask,
  importPlan,
  installAdapter,
  initRuntime,
  listParallelAgentRuns,
  loadHelixConfig,
  listTeamTasks,
  listTeamMessages,
  listChangeRequests,
  listPromptPack,
  readJson,
  recordReviewBlocker,
  recordTaskEvidence,
  renderPromptPackEntry,
  resolveInjectionPoint,
  resolveChangeRequest,
  resumeReport,
  reviewChangeRequest,
  runArchivistRouter,
  routeRequest,
  runInjectionHook,
  runParallelAgents,
  runWorkflowNode,
  runNextTask,
  runWorkflow,
  scopeGuard,
  sendTeamMessage,
  scanProjectRules,
  statusReport,
  steerWorkflow,
  uninstallAdapter,
  writeDefaultHelixConfig,
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

function printHelp() {
  console.log(`${PRODUCT_NAME} linear runtime

Usage:
  wildarrange init [--sample]
  wildarrange config init [--root] [--force]
  wildarrange config show
  wildarrange adapter install [--target codex|cursor|all] [--mode local|npx] [--package wildarrange]
  wildarrange adapter uninstall [--target codex|cursor|all]
  wildarrange injection show --point before_review [--agent BaiZe] [--task T001]
  wildarrange hook run [--from hook.json] [--format text|json]
  wildarrange plan --from <plan.json>
  wildarrange run
  wildarrange workflow --from <plan.json>
  wildarrange workflow --sample
  wildarrange parallel run [--max-agents 2] [--task T001,T002] [--agent Kui] [--command "..."]
  wildarrange parallel admit --run <runId> --task T001
  wildarrange parallel list
  wildarrange archivist packet [--text "..."] [--stage plan] [--turns turns.json]
  wildarrange archivist run [--text "..."] [--stage plan] [--turns turns.json] [--force]
  wildarrange node route --text "request"
  wildarrange node execute [--task T001]
  wildarrange node verify [--task T001]
  wildarrange node scope [--task T001]
  wildarrange node review [--task T001]
  wildarrange node checkpoint [--task T001]
  wildarrange node retry [--task T001]
  wildarrange status
  wildarrange resume [--session <id>]
  wildarrange continuation check [--session <id>]
  wildarrange summary
  wildarrange rules collect [--target src/app.js]
  wildarrange context build [--agent ${DEFAULT_EXECUTOR_AGENT}] [--task T001]
  wildarrange evidence record --task T001 --criterion C001 --status pass --evidence "..."
  wildarrange steer --from <proposal.json>
  wildarrange review-blockers record --from <blocker.json>
  wildarrange task list [--status pending] [--owner ${DEFAULT_EXECUTOR_AGENT}]
  wildarrange task get --task T001
  wildarrange task claim [--task T001] [--owner ${DEFAULT_EXECUTOR_AGENT}]
  wildarrange task create --from <task.json>
  wildarrange team send --to ${DEFAULT_EXECUTOR_AGENT} --from ${DEFAULT_LEAD_AGENT} --body "..."
  wildarrange team inbox [--agent ${DEFAULT_EXECUTOR_AGENT}]
  wildarrange changes list
  wildarrange changes review --id CR-xxxx
  wildarrange changes resolve --id CR-xxxx --decision accept|reject --evidence "..." --rationale "..." [--apply-scope]
  wildarrange serve [--host 127.0.0.1] [--port 8765] [--token <token>]
  wildarrange guard scope [--task T001]
  wildarrange route --text "request"
  wildarrange prompts list
  wildarrange prompts show --agent ${DEFAULT_EXECUTOR_AGENT}
  wildarrange prompts show --skill review-work
  wildarrange prompts show --tools
  wildarrange prompts show --routes

Plan schema:
  {
    "title": "Feature name",
    "objective": "What must be true",
    "defaults": {
      "verify_commands": ["shared verifier for every task"],
      "review_commands": ["shared review gate"],
      "standards_commands": ["project standards gate"],
      "writable_paths": ["src/**"]
    },
    "tasks": [{
      "id": "T001",
      "subject": "Implement one thing",
      "category": "quick|deep|ultrabrain|visual-engineering",
      "worker_command": "command that changes files",
      "verify_commands": ["command that must pass"]
    }]
  }
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const rootDir = process.cwd();

  if (!command || command === "help" || command === "--help") {
    printHelp();
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
      }), null, 2));
      return;
    }
    if (subcommand === "show") {
      console.log(JSON.stringify(await loadHelixConfig(rootDir), null, 2));
      return;
    }
    throw new Error("helix config requires init or show");
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
    throw new Error("helix adapter requires install or uninstall");
  }

  if (command === "injection") {
    const subcommand = args._[1];
    if (subcommand === "show") {
      if (!args.point || args.point === true) throw new Error("helix injection show requires --point <name>");
      console.log(JSON.stringify(await resolveInjectionPoint(rootDir, args.point, {
        agent: args.agent && args.agent !== true ? args.agent : "",
        taskId: args.task && args.task !== true ? args.task : "",
        planId: args.plan && args.plan !== true ? args.plan : "",
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
    if (!args.from) throw new Error("helix plan requires --from <plan.json>");
    await initRuntime(rootDir);
    const plan = await importPlan(rootDir, path.resolve(rootDir, args.from));
    console.log(JSON.stringify({ ok: true, planId: plan.id, taskCount: plan.tasks.length }, null, 2));
    return;
  }

  if (command === "run") {
    const result = await runNextTask(rootDir);
    console.log(JSON.stringify(result, null, 2));
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
        command: args.command && args.command !== true ? args.command : undefined,
        timeoutMs: args.timeout && args.timeout !== true ? Number(args.timeout) : undefined,
      }), null, 2));
      return;
    }
    if (subcommand === "list") {
      console.log(JSON.stringify(await listParallelAgentRuns(rootDir), null, 2));
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
    throw new Error("helix parallel requires run, admit, or list");
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
    throw new Error("helix archivist requires packet or run");
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
      console.log(content);
      return;
    }
    throw new Error("helix prompts requires list or show");
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
