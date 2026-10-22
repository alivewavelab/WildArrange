// =============================================================================
// 文件名称：task-pull-request.test.mjs
// 所属模块：test
// 作用说明：
//   任务完成且已推送后自动建 Draft PR：首次创建、再次同步只改正文、gh 失败不反完成并进入提醒、
//   本地路径远端直接跳过。用假 gh + 本地 bare remote，不连公网。
// =============================================================================

import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runNextTask } from "../src/orchestration/linear-runtime.mjs";
import { syncPullRequests } from "../src/orchestration/task-pull-request.mjs";
import { attentionReport } from "../src/orchestration/status.mjs";
import { resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { loadTaskState } from "../src/infra/task-state-store.mjs";
import { runCommandFile } from "../src/infra/command-runner.mjs";
import { withExternalProject, importApprovedPlan } from "./helpers/external-fixture.mjs";
import { createSmokePlan } from "./helpers/runtime-fixtures.mjs";

const HOSTED_URL = "https://github.com/acme/demo.git";

/** 假 gh：按状态文件模拟 pr list/create/edit，记录每次调用。 */
const FAKE_GH = `#!/usr/bin/env node
import fs from "node:fs";
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
state.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
if (state.fail) { save(); process.stderr.write("To get started with GitHub CLI, please run:  gh auth login\\n"); process.exit(4); }
if (args[0] === "pr" && args[1] === "list") {
  save();
  process.stdout.write(JSON.stringify(state.prs.filter((pr) => pr.head === flag("--head")).map(({ number, url, isDraft }) => ({ number, url, isDraft }))));
} else if (args[0] === "pr" && args[1] === "create") {
  const number = state.prs.length + 1;
  const pr = { number, url: "https://github.com/acme/demo/pull/" + number, isDraft: args.includes("--draft"), head: flag("--head"), base: flag("--base"), title: flag("--title"), body: fs.readFileSync(flag("--body-file"), "utf8") };
  state.prs.push(pr);
  save();
  process.stdout.write(pr.url + "\\n");
} else if (args[0] === "pr" && args[1] === "edit") {
  const pr = state.prs.find((item) => item.number === Number(args[2]));
  pr.body = fs.readFileSync(flag("--body-file"), "utf8");
  save();
} else { save(); process.stderr.write("unsupported"); process.exit(1); }
`;

async function git(cwd, args) {
  const result = await runCommandFile("git", ["-C", cwd, ...args], cwd, 60_000);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/** 外置项目 + bare origin（hosted 时以 GitHub URL 配置、insteadOf 指回本地）+ 假 gh；回调结束后恢复 PATH。 */
async function withProject({ hosted = true, ghFails = false } = {}, fn) {
  await withExternalProject(async ({ root, projectRoot }) => {
    const remote = path.join(root, "origin.git");
    await git(root, ["init", "--bare", "--initial-branch=main", remote]);
    await git(projectRoot, ["remote", "add", "origin", hosted ? HOSTED_URL : remote]);
    if (hosted) await git(projectRoot, ["config", `url.${remote}.insteadOf`, HOSTED_URL]);
    await git(projectRoot, ["push", "-q", "-u", "origin", "main"]);

    const bin = path.join(root, "fake-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "gh"), FAKE_GH, "utf8");
    await chmod(path.join(bin, "gh"), 0o755);
    const stateFile = path.join(root, "gh-state.json");
    await writeFile(stateFile, JSON.stringify({ fail: ghFails, prs: [], calls: [] }), "utf8");
    const readState = async () => JSON.parse(await readFile(stateFile, "utf8"));
    const setFail = async (fail) => writeFile(stateFile, JSON.stringify({ ...(await readState()), fail }), "utf8");

    const previous = { PATH: process.env.PATH, FAKE_GH_STATE: process.env.FAKE_GH_STATE };
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    process.env.FAKE_GH_STATE = stateFile;
    try {
      await importApprovedPlan(projectRoot, await createSmokePlan(root));
      const result = await runNextTask(projectRoot);
      assert.equal(result.status, "completed");
      await fn({ projectRoot, result, readState, setFail });
    } finally {
      process.env.PATH = previous.PATH;
      if (previous.FAKE_GH_STATE === undefined) delete process.env.FAKE_GH_STATE;
      else process.env.FAKE_GH_STATE = previous.FAKE_GH_STATE;
    }
  });
}

test("completion opens one Draft PR for the pushed task branch and later syncs only edit its body", async () => {
  await withProject({}, async ({ projectRoot, result, readState }) => {
    const branch = result.task.delivery_workspace.branch;
    assert.equal(result.pullRequest.status, "created");
    assert.equal(result.pullRequest.number, 1);

    let state = await readState();
    assert.equal(state.prs.length, 1);
    const [pr] = state.prs;
    assert.equal(pr.isDraft, true);
    assert.equal(pr.head, branch);
    assert.equal(pr.base, "main");
    assert.match(pr.title, /^\[T001\] /);
    assert.match(pr.body, /## 验收结论/);
    assert.match(pr.body, new RegExp(result.pullRequest.deliverySha));
    const { planId } = await loadTaskState(projectRoot);
    const record = JSON.parse(await readFile(resolveWildArrangePath(projectRoot, "pull-requests", planId, "T001.json"), "utf8"));
    assert.equal(record.status, "created");
    assert.equal(record.url, pr.url);
    assert.deepEqual((await attentionReport(projectRoot)).pendingPullRequests, []);

    const again = await syncPullRequests(projectRoot, { taskId: "T001" });
    assert.equal(again.results[0].status, "updated");
    state = await readState();
    assert.equal(state.prs.length, 1, "an open PR for the branch is reused, never duplicated");
    const verbs = state.calls.map((args) => args.slice(0, 2).join(" "));
    assert.deepEqual([...new Set(verbs)].sort(), ["pr create", "pr edit", "pr list"]);
  });
});

test("the gh wrapper exposes no approve, merge or ready primitive", async () => {
  const source = await readFile(new URL("../src/infra/pull-request.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"(merge|ready|review)"/);
});

test("gh failure leaves the task completed, records a retry hint and surfaces in attention until pr sync succeeds", async () => {
  await withProject({ ghFails: true }, async ({ projectRoot, result, readState, setFail }) => {
    assert.equal(result.task.status, "completed");
    assert.equal(result.pullRequest.status, "failed");
    assert.match(result.pullRequest.error, /gh auth login/);
    assert.equal(result.pullRequest.retryHint, "node ./bin/wildarrange.mjs pr sync --task T001");

    const pending = (await attentionReport(projectRoot)).pendingPullRequests;
    assert.deepEqual(pending.map((item) => item.id), ["T001"]);
    assert.equal(pending[0].syncHint, "node ./bin/wildarrange.mjs pr sync --task T001");

    await setFail(false);
    const retried = await syncPullRequests(projectRoot, { taskId: "T001" });
    assert.equal(retried.results[0].status, "created");
    assert.equal((await readState()).prs[0].isDraft, true);
    assert.deepEqual((await attentionReport(projectRoot)).pendingPullRequests, []);
  });
});

test("a local-path remote has no hosting platform, so no gh call and no reminder", async () => {
  await withProject({ hosted: false }, async ({ projectRoot, result, readState }) => {
    assert.equal(result.pullRequest.status, "skipped");
    assert.equal(result.pullRequest.reason, "remote_not_hosted");
    assert.deepEqual((await readState()).calls, []);
    assert.deepEqual((await attentionReport(projectRoot)).pendingPullRequests, []);
  });
});
