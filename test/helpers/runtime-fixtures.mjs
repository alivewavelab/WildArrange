// =============================================================================
// 文件名称：runtime-fixtures.mjs
// 所属模块：test/helpers
// 作用说明：
//   runtime-*.test.mjs 共享的本地辅助：Prompt Pack 夹具、Dashboard/LLM 本地服务、HTTP 请求与命令构造。
// =============================================================================

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { startDashboardServer } from "../../src/interface/dashboard.mjs";
import { runInjectionHook as renderHook } from "../../src/ai/hooks.mjs";
import { runHostHook, runHostRoute } from "../../src/orchestration/host-runtime.mjs";
import { routeRequest as classifyRoute } from "../../src/ai/routing.mjs";
import { resolveWildArrangePath } from "../../src/infra/runtime-store.mjs";
import { installAdapters } from "../../src/interface/adapters.mjs";
import { getBoundWorkspaceContext } from "../../src/infra/workspace-context.mjs";
import { gitCommitAll } from "./external-fixture.mjs";


export async function installDocumentReviewerFixture(projectRoot, governanceRoot) {
  const adapter = resolveWildArrangePath(projectRoot, "document-reviewer.cjs");
  await mkdir(path.dirname(adapter), { recursive: true });
  await writeFile(adapter, `const fs=require('node:fs');
const p=JSON.parse(fs.readFileSync(process.env.WILDARRANGE_READINESS_PACKET||process.env.WILDARRANGE_REVIEW_PACKET,'utf8'));
if(p.kind==='execution_readiness_probe') console.log(JSON.stringify({ready:true,challenge:p.challenge,loadedSkills:p.requiredSkills.map(s=>s.name)}));
else if(p.kind==='project_review_step') {
  const evidence=p.step.appliesTo.map(name=>p.source.files.find(file=>file.path===name)).filter(file=>file&&typeof file.content==='string').map(file=>({file:file.path,line:1,text:file.content.split('\\n')[0]}));
  console.log(JSON.stringify({stepId:p.step.id,inputDigest:p.inputDigest,decision:'PASS',summary:'Fixture reviewed current document content',evidence,findings:[]}));
} else console.log(JSON.stringify({decision:'PASS',checks:Object.keys(p.rules).map(rule=>({rule,decision:'PASS',reason:'Fixture inspected source'})),findings:[]}));`);
  const command = `node "${adapter}"`;
  // 外置模式配置真相源在治理仓；必须在 plan 导入（冻结治理版本）之前调用。
  await writePolicyConfig(governanceRoot, JSON.stringify({ executionReadiness: { workerProbe: command }, review: { responsibility: { command } } }));
}

export async function writeMinimalPromptPack(rootDir, skills = {}) {
  const packDir = path.join(rootDir, "prompt-pack");
  await mkdir(path.join(packDir, "skills"), { recursive: true });
  await mkdir(path.join(packDir, "tools"), { recursive: true });
  const skillManifest = {};
  for (const [name, content] of Object.entries(skills)) {
    const skillPath = `skills/${name}.md`;
    skillManifest[name] = skillPath;
    await writeFile(path.join(packDir, skillPath), content);
  }
  await writeFile(path.join(packDir, "tools", "tool-contract.json"), JSON.stringify({ tools: [] }, null, 2));
  await writeFile(path.join(packDir, "manifest.json"), JSON.stringify({
    version: 1,
    name: "test-pack",
    description: "Test prompt pack",
    source: { project: "WildArrange test" },
    agents: {},
    skills: skillManifest,
    tools: "tools/tool-contract.json",
  }, null, 2));
  return packDir;
}

export async function withDashboard(dir, fn, options = {}) {
  const server = await startDashboardServer(dir, { host: "127.0.0.1", port: 0, token: options.token });
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    assert.ok(port);
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

export async function withLlmServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    assert.ok(port);
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

export async function postJson(url, body, options = {}) {
  return fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    body: JSON.stringify(body || {}),
  });
}

export function nodeEval(source) {
  const encoded = Buffer.from(source.replace(/\s*\n\s*/g, " ").trim(), "utf8").toString("base64");
  return `node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}


export const routeRequest = (root, input) => runHostRoute(root, input, classifyRoute);
export const runInjectionHook = (root, input) => runHostHook(root, input, renderHook);

/**
 * 写入治理仓 policy 下的 wildarrange.config.json 并提交，保持治理仓干净。
 * 外置模式的配置真相源在治理仓，项目根下的同名文件不会被读取。
 */
export async function writePolicyConfig(governanceRoot, content) {
  await writeFile(path.join(governanceRoot, "policy", "wildarrange.config.json"), typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  await gitCommitAll(governanceRoot, "fixture policy config");
}

/** 在外置 runtime 生成 Codex 宿主包，使 resume/continuation 有可执行的 CLI 前缀事实。 */
export async function installExternalTestAdapter(projectRoot, options = {}) {
  return installAdapters(projectRoot, getBoundWorkspaceContext(projectRoot), {
    target: "codex",
    mode: "local",
    localCliPath: path.resolve("bin", "wildarrange.mjs"),
    ...options,
  });
}

/**
 * 外置模式下的线性冒烟计划（对应 createSamplePlan，但产物写在项目内普通目录 artifacts/，
 * 不依赖项目内运行态目录）。返回计划文件路径（位于项目之外的 root）。
 */
export async function createSmokePlan(root) {
  const planPath = path.join(root, "smoke-plan.json");
  await writeFile(planPath, JSON.stringify({
    title: "M1 linear loop smoke",
    objective: "Prove Jiuwei can run one worker task and verify it before checkpoint.",
    tasks: [{
      id: "T001",
      subject: "Write smoke artifact",
      description: "Worker writes a small artifact; verifier checks exact content.",
      category: "quick",
      writable_paths: ["artifacts/linear-smoke.txt"],
      worker_command: nodeEval("const fs=require('fs'); fs.mkdirSync('artifacts',{recursive:true}); fs.writeFileSync('artifacts/linear-smoke.txt','ok\\n')"),
      verify_commands: [nodeEval("const fs=require('fs'); const v=fs.readFileSync('artifacts/linear-smoke.txt','utf8').trim(); if(v!=='ok') process.exit(1)")],
      review_commands: [nodeEval("const fs=require('fs'); const v=fs.readFileSync('artifacts/linear-smoke.txt','utf8'); if(!v.includes('ok')) { console.error('review: artifact content mismatch'); process.exit(1); }")],
      successCriteria: [{
        id: "C001",
        title: "smoke artifact verified",
        status: "pending",
        expectedEvidence: "verifier checks exact smoke artifact content",
        verifierCommandRefs: [0],
      }],
    }],
  }, null, 2));
  return planPath;
}

/** 以子进程运行外置宿主生成的 Hook 桥（stdin 传入宿主事件），模拟一次真实宿主生命周期回执。 */
export function runExternalBridge(bridgePath, payload, stateHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath], {
      cwd: payload.cwd,
      env: { ...process.env, WILDARRANGE_STATE_HOME: stateHome },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}
