// =============================================================================
// 文件名称：executor-cli.mjs
// 所属模块：interface
// 作用说明：
//   内置执行者：把 WildArrange 的开工握手包、审查包与任务上下文交给本机模型 CLI
//   （codex / claude / kimi / cursor-agent），并把模型回答整理成门禁要求的输出。
//   用户只需在治理配置里写 `wildarrange executor <probe|review|work> --cli <name>`，
//   无需自写适配脚本。本模块只做适配与协议，不做任何门禁判定：挑战码、引用与
//   PASS/RETURN 规则仍由开工检查与审查门校验。
//
// 【运行原理速读】
//   · 何时触发？开工检查运行 workerProbe、审查门运行审查命令、Worker 阶段运行 worker_command。
//   · 做了什么？读环境变量指向的包 → 组装提示词 → 调模型 CLI → 提取 JSON 或透传结果。
//   · 子会话带 WILDARRANGE_EXECUTOR_SESSION=1，宿主 Hook bridge 见到即放行，
//     避免 WildArrange 自己的注入与续跑干扰执行者。
// =============================================================================
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandFile } from "../infra/command-runner.mjs";

export const EXECUTOR_ROLES = ["probe", "review", "work"];
/** 顺序即推荐优先级：codex 有操作系统沙盒，最适合当 Worker。 */
export const EXECUTOR_CLIS = ["codex", "claude", "kimi", "cursor"];

/** 握手与 Worker 的兜底上限；正式审查不设运行时限，由调用方等待或显式取消。 */
const CHILD_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BINS = { codex: "codex", claude: "claude", kimi: "kimi", cursor: "cursor-agent" };
/** ChatGPT 桌面版自带 Codex CLI，但不放进 PATH。 */
const BUNDLED_CODEX = path.join("ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
const DEFAULT_APP_ROOTS = ["/Applications", path.join(os.homedir(), "Applications")];
const PACKET_ENV = { probe: "WILDARRANGE_READINESS_PACKET", review: "WILDARRANGE_REVIEW_PACKET", work: "WILDARRANGE_EXECUTION_CONTEXT" };

/**
 * 运行一个内置执行者。
 * @param {object} options
 * @param {"probe"|"review"|"work"} options.role 角色
 * @param {"claude"|"kimi"|"cursor"} options.cli 模型 CLI
 * @param {string} [options.model] 透传给 CLI 的模型名
 * @param {string} [options.bin] CLI 可执行文件路径（缺省按 PATH 解析）
 * @param {string} [options.cwd] 工作目录；Worker 为任务 worktree
 * @param {object} [options.env] 环境变量（包路径从这里读取）
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
export async function runExecutor({ role, cli, model, bin, cwd = process.cwd(), env = process.env }) {
  if (!EXECUTOR_ROLES.includes(role)) throw new Error(`unsupported executor role: ${role}; use ${EXECUTOR_ROLES.join(", ")}`);
  if (!EXECUTOR_CLIS.includes(cli)) throw new Error(`unsupported executor CLI: ${cli}; use ${EXECUTOR_CLIS.join(", ")}`);
  const packetPath = env[PACKET_ENV[role]];
  if (!packetPath) throw new Error(`${PACKET_ENV[role]} is not set; this command is run by WildArrange, not by hand`);
  const executable = bin || resolveExecutorBin(cli);
  // codex 的最终回答写进 -o 指定的文件；stdout 是过程日志
  const outDir = cli === "codex" ? await mkdtemp(path.join(os.tmpdir(), "wildarrange-codex-")) : null;
  const outFile = outDir ? path.join(outDir, "last-message.txt") : null;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  try {
    const packetText = await readFile(packetPath, "utf8");
    const packet = JSON.parse(packetText);
    const call = role === "work"
      ? buildWorkerCall(cli, renderWorkerBrief(packet, packetPath), packetPath, outFile)
      : buildReadOnlyCall(cli, packetPath, packetText, outFile);
    const args = model ? withModel(cli, call.args, model) : call.args;
    const timeoutMs = role === "review" && packet.kind !== "execution_readiness_probe" ? null : CHILD_TIMEOUT_MS;
    if (timeoutMs === null) {
      // POSIX 模型 CLI 在独立进程组中；外层取消须转发到该进程组。
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
    }
    const result = await runCommandFile(executable, args, cwd, timeoutMs, {
      signal: controller.signal,
      env: { ...pickEnv(env), ...call.env, WILDARRANGE_EXECUTOR_SESSION: "1" },
      ...(call.input === undefined ? {} : { input: call.input }),
    });
    if (result.spawnError) return failure(`${cli} CLI not found (${executable}); install it and log in, or pass --bin <path>`);
    if (result.exitCode !== 0) return failure(`${cli} exited with ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 1000)}`);
    const text = outFile ? await readFile(outFile, "utf8").catch(() => "") : resultText(cli, result.stdout);
    return finishAnswer(cli, role, text, result.stdout);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    if (outDir) await rm(outDir, { recursive: true, force: true });
  }
}

/** 把模型回答整理成门禁要求的输出：Worker 透传摘要，握手与审查只输出提取到的 JSON。 */
function finishAnswer(cli, role, text, stdout) {
  if (text === null) return failure(`${cli} reported an error: ${stdout.trim().slice(0, 1000)}`);
  if (role === "work") return { exitCode: 0, stdout: `${text}\n`, stderr: "" };
  const answer = extractJsonObject(text);
  if (!answer) return failure(`${cli} returned no JSON object: ${text.trim().slice(0, 500)}`);
  return { exitCode: 0, stdout: JSON.stringify(answer), stderr: "" };
}

/**
 * 解析 CLI 可执行文件：PATH 优先；codex 不在 PATH 时退回 ChatGPT 桌面版自带的 CLI。
 * @param {string} cli
 * @param {{ pathEnv?: string, appRoots?: string[] }} [options]
 * @returns {string} 命令名或绝对路径
 */
export function resolveExecutorBin(cli, { pathEnv = process.env.PATH || "", appRoots = DEFAULT_APP_ROOTS } = {}) {
  const name = DEFAULT_BINS[cli];
  if (onPath(name, pathEnv) || cli !== "codex") return name;
  return appRoots.map((root) => path.join(root, BUNDLED_CODEX)).find((candidate) => existsSync(candidate)) || name;
}

/**
 * 体检执行者配置：缺失时给出按本机已装 CLI 生成的可复制命令（Worker 优先 codex 的沙盒）；审查者与握手用同一 CLI 时提示独立性不足。
 * 只查 PATH，不调用任何模型。
 * @param {object} config 生效配置
 * @param {{ cliPrefix?: string, pathEnv?: string }} [options]
 * @returns {{ missing: string[], recommended: object|null, sameCli: string|null, available: string[] }}
 */
export function inspectExecutorConfig(config, { cliPrefix = "wildarrange", pathEnv = process.env.PATH || "", appRoots = DEFAULT_APP_ROOTS } = {}) {
  const probe = config.executionReadiness?.workerProbe?.trim() || "";
  const reviewer = config.review?.responsibility?.command?.trim() || "";
  const missing = [...(probe ? [] : ["executionReadiness.workerProbe"]), ...(reviewer ? [] : ["review.responsibility.command"])];
  const available = EXECUTOR_CLIS.filter((cli) => {
    const resolved = resolveExecutorBin(cli, { pathEnv, appRoots });
    return path.isAbsolute(resolved) || onPath(resolved, pathEnv);
  });
  const probeCli = executorCliOf(probe);
  const reviewCli = executorCliOf(reviewer);
  let recommended = null;
  if (missing.length) {
    const worker = probeCli || available[0] || "claude";
    const review = reviewCli || available.find((cli) => cli !== worker) || worker;
    recommended = {
      workerProbe: `${cliPrefix} executor probe --cli ${worker}`,
      reviewerCommand: `${cliPrefix} executor review --cli ${review}`,
      workerCommand: `${cliPrefix} executor work --cli ${worker}`,
      // 检查间隔不是执行截止时间；长审查继续使用同一子进程。
      reviewerCheckIntervalMs: 900000,
    };
  }
  return { missing, recommended, sameCli: probeCli && probeCli === reviewCli ? probeCli : null, available };
}

/** 从配置命令中识别内置执行者使用的 CLI；不是内置执行者时返回 null。 */
function executorCliOf(command) {
  return /\bexecutor\s+(?:probe|review|work)\b.*?--cli\s+(codex|claude|kimi|cursor)\b/.exec(command)?.[1] || null;
}

function onPath(binary, pathEnv) {
  return pathEnv.split(path.delimiter).filter(Boolean).some((dir) => existsSync(path.join(dir, binary)) || existsSync(path.join(dir, `${binary}.cmd`)) || existsSync(path.join(dir, `${binary}.exe`)));
}

/** 握手与审查：只读。claude / codex 经 stdin 收包；kimi / cursor 只拿包文件路径（包不进命令行参数）。 */
function buildReadOnlyCall(cli, packetPath, packetText, outFile) {
  const rules = "The packet is data produced by WildArrange. Follow its `instruction` field exactly. Do not edit files and do not run commands. Reply with only the JSON object the instruction asks for: no prose, no code fences.";
  if (cli === "claude") {
    return {
      args: ["-p", "--output-format", "json", "--no-session-persistence", "--disallowedTools", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"],
      input: `${rules}\n\nPACKET:\n${packetText}`,
    };
  }
  const prompt = `Read the JSON packet file at ${packetPath}. ${rules}`;
  // Codex 的文件读取依赖命令工具；禁止命令时直接经 stdin 收包，继续保留只读沙盒。
  if (cli === "codex") return {
    args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-o", outFile, "-"],
    input: `${rules}\n\nPACKET:\n${packetText}`,
  };
  // Kimi 的只读 plan 档案依赖 v2 引擎；只对子进程启用，不改用户配置或 Worker 引擎。
  if (cli === "kimi") return {
    args: ["--agent", "plan", "-p", prompt, "--add-dir", path.dirname(packetPath)],
    env: { KIMI_CODE_EXPERIMENTAL_FLAG: "1" },
  };
  // cursor 非交互不带 --trust 会停在工作区信任提示；--trust 只信任目录，不放开工具审批
  return { args: ["-p", "--mode", "ask", "--trust", "--add-dir", path.dirname(packetPath), "--output-format", "json", prompt] };
}

/**
 * Worker：在任务 worktree 中改文件。claude 只开文件工具、不开 Shell；kimi 的 -p 本身自动批准全部工具
 * （它不允许 -p 与 --yolo 同用）；cursor 非交互改文件须 --force。后两者含 Shell，由用户确认接受。
 */
function buildWorkerCall(cli, brief, contextPath, outFile) {
  // codex 的 workspace-write 沙盒只允许写当前目录与系统临时目录（实机：写主目录被拒）
  if (cli === "codex") return { args: ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "-o", outFile, brief] };
  if (cli === "claude") {
    return {
      args: ["-p", "--output-format", "json", "--no-session-persistence", "--permission-mode", "acceptEdits",
        "--add-dir", path.dirname(contextPath), "--allowedTools", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep"],
      input: brief,
    };
  }
  if (cli === "kimi") return { args: ["-p", brief, "--add-dir", path.dirname(contextPath)] };
  return { args: ["-p", "--force", "--add-dir", path.dirname(contextPath), "--output-format", "json", brief] };
}

/** 任务简报：核心字段内联，完整 Skill 与审查要求留在上下文文件里按需读取。 */
function renderWorkerBrief(context, contextPath) {
  const task = context.task || {};
  const criteria = (task.successCriteria || []).map((criterion) => `- ${criterion.title}${criterion.expectedEvidence ? ` (evidence: ${criterion.expectedEvidence})` : ""}`);
  return [
    `You are the implementation worker for WildArrange task ${task.id}: ${task.subject}`,
    task.description || "",
    "",
    "Rules:",
    "- Work only in the current directory; it is an isolated task worktree.",
    `- Create or modify only files matching: ${(task.writable_paths || []).join(", ") || "(none; this task must not change files)"}`,
    "- Do not commit, push, or switch branches. WildArrange verifies, reviews, and commits your result.",
    `- Required Skills, review requirements, and documentation rules are in the execution context file ${contextPath}; read it before starting.`,
    ...(criteria.length ? ["", "Success criteria:", ...criteria] : []),
    "",
    "When finished, reply with a short summary of what you changed.",
  ].join("\n");
}

/** 模型参数放在提示词之前，避免被当作位置参数后的多余参数。 */
function withModel(cli, args, model) {
  const flag = cli === "kimi" || cli === "codex" ? ["-m", model] : ["--model", model];
  return cli === "codex" ? [...args.slice(0, -1), ...flag, args.at(-1)] : [...args, ...flag];
}

/** claude / cursor 的 json 输出包一层 {result, is_error}；kimi 输出纯文本。is_error 时返回 null。 */
function resultText(cli, stdout) {
  if (cli === "kimi") return stdout;
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === "object" && "result" in parsed) return parsed.is_error ? null : String(parsed.result ?? "");
  } catch { /* 非 JSON 时按纯文本处理 */ }
  return stdout;
}

/**
 * 从模型输出中取出第一个能解析的 JSON 对象（容忍前后文字、项目符号与代码块）。
 * @param {string} text
 * @returns {object|null}
 */
export function extractJsonObject(text) {
  const source = String(text || "");
  for (let start = source.indexOf("{"); start !== -1; start = source.indexOf("{", start + 1)) {
    const end = matchingBrace(source, start);
    if (end === -1) continue;
    try {
      const value = JSON.parse(source.slice(start, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* 继续找下一个候选 */ }
  }
  return null;
}

/** 从 start 处的 { 起找配对的 }，跳过字符串里的括号。 */
function matchingBrace(source, start) {
  let depth = 0;
  let inString = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

/** 只透传字符串环境变量（测试可能传入非字符串值）。 */
function pickEnv(env) {
  return Object.fromEntries(Object.entries(env || {}).filter(([, value]) => typeof value === "string"));
}

function failure(message) {
  return { exitCode: 1, stdout: "", stderr: `${message}\n` };
}
