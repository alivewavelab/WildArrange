// =============================================================================
// 文件名称：runtime-fixtures.mjs
// 所属模块：test/helpers
// 作用说明：
//   runtime-*.test.mjs 共享的本地辅助：Prompt Pack 夹具、Dashboard/LLM 本地服务、HTTP 请求与命令构造。
// =============================================================================

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { startDashboardServer } from "../../src/interface/dashboard.mjs";
import { runInjectionHook as renderHook } from "../../src/ai/hooks.mjs";
import { runHostHook, runHostRoute } from "../../src/orchestration/host-runtime.mjs";
import { routeRequest as classifyRoute } from "../../src/ai/routing.mjs";
import { runCommand } from "../../src/infra/command-runner.mjs";


export async function withTempDir(fn) {
  const baseDir = path.join(os.tmpdir(), "wildarrange-tests");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-linear-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function installDocumentReviewerFixture(rootDir) {
  const adapter = path.join(rootDir, ".wildarrange", "document-reviewer.cjs");
  await mkdir(path.dirname(adapter), { recursive: true });
  await writeFile(adapter, `const fs=require('node:fs');
const p=JSON.parse(fs.readFileSync(process.env.WILDARRANGE_READINESS_PACKET||process.env.WILDARRANGE_REVIEW_PACKET,'utf8'));
if(p.kind==='execution_readiness_probe') console.log(JSON.stringify({ready:true,challenge:p.challenge,loadedSkills:p.requiredSkills.map(s=>s.name)}));
else if(p.kind==='project_review_step') {
  const evidence=p.step.appliesTo.map(name=>p.source.files.find(file=>file.path===name)).filter(file=>file&&typeof file.content==='string').map(file=>({file:file.path,line:1,text:file.content.split('\\n')[0]}));
  console.log(JSON.stringify({stepId:p.step.id,inputDigest:p.inputDigest,decision:'PASS',summary:'Fixture reviewed current document content',evidence,findings:[]}));
} else console.log(JSON.stringify({decision:'PASS',checks:Object.keys(p.rules).map(rule=>({rule,decision:'PASS',reason:'Fixture inspected source'})),findings:[]}));`);
  const command = `node "${adapter}"`;
  await writeFile(path.join(rootDir, "wildarrange.config.json"), JSON.stringify({ executionReadiness: { workerProbe: command }, review: { responsibility: { command } } }));
}

export async function initializeGitFixture(rootDir) {
  const gitignorePath = path.join(rootDir, ".gitignore");
  const gitignore = await readFile(gitignorePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  if (!gitignore.split(/\r?\n/).includes(".wildarrange/")) {
    await writeFile(gitignorePath, `${gitignore}${gitignore && !gitignore.endsWith("\n") ? "\n" : ""}.wildarrange/\n`, "utf8");
  }
  for (const command of [
    "git init",
    "git config user.email wildarrange@test.local",
    "git config user.name wildarrange-test",
    "git add -A",
    "git commit --allow-empty -m fixture-baseline --no-gpg-sign",
  ]) {
    const result = await runCommand(command, rootDir);
    assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
  }
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
