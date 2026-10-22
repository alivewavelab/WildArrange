// =============================================================================
// 文件名称：pull-request.mjs
// 所属模块：infra
// 作用说明：
//   GitHub CLI `gh` 薄封装：按 head branch 查打开的 PR、创建 Draft PR、更新 PR 正文。
//   只有这三个原语；不提供 approve、merge 或转为 Ready。
//
// 【运行原理速读】
//   参数数组调用 gh（不经 shell），正文经 --body-file 传入，避免长文本进入命令行。
//   认证沿用开发者本机 gh 登录态，本模块不读写任何 token。
// =============================================================================
import { runCommandFile } from "./command-runner.mjs";

/** gh 网络调用超时（毫秒）。 */
const GH_TIMEOUT_MS = 60_000;

/**
 * 查找 head branch 上打开的 PR。
 * @returns {Promise<{ ok: boolean, pullRequest?: { number: number, url: string, isDraft: boolean }|null, error?: string }>}
 */
export async function findOpenPullRequest(cwd, branch) {
  const result = await gh(cwd, ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,isDraft", "--limit", "1"]);
  if (!result.ok) return result;
  try {
    const [first] = JSON.parse(result.stdout || "[]");
    return { ok: true, pullRequest: first ? { number: first.number, url: first.url, isDraft: first.isDraft === true } : null };
  } catch {
    return { ok: false, error: `unexpected gh pr list output: ${result.stdout.slice(0, 200)}` };
  }
}

/**
 * 创建 Draft PR；gh 成功时 stdout 末行是 PR URL。
 * @returns {Promise<{ ok: boolean, pullRequest?: { number: number|null, url: string, isDraft: true }, error?: string }>}
 */
export async function createDraftPullRequest(cwd, { base, head, title, bodyFile }) {
  const result = await gh(cwd, ["pr", "create", "--draft", "--base", base, "--head", head, "--title", title, "--body-file", bodyFile]);
  if (!result.ok) return result;
  const url = result.stdout.trim().split(/\r?\n/).pop() || "";
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1]) || null;
  return { ok: true, pullRequest: { number, url, isDraft: true } };
}

/** 只更新 PR 正文。 */
export async function updatePullRequestBody(cwd, number, bodyFile) {
  const result = await gh(cwd, ["pr", "edit", String(number), "--body-file", bodyFile]);
  return result.ok ? { ok: true } : result;
}

/** 参数数组调用 gh；缺失、未登录与网络失败统一归为 ok=false + error。 */
async function gh(cwd, args) {
  const result = await runCommandFile("gh", args, cwd, GH_TIMEOUT_MS, { env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
  if (result.exitCode === 0) return { ok: true, stdout: result.stdout };
  const error = (result.stderr || result.stdout || "").trim();
  return { ok: false, error: result.spawnError || /ENOENT/.test(error) ? `gh CLI not found: ${error}` : error || `gh exited with ${result.exitCode}` };
}

/**
 * 远端是否指向托管平台（URL 或 scp 形式）；本地路径与 file:// 远端没有 PR 可建。
 * 读原始配置而非 `remote get-url`，不受 insteadOf 改写影响。
 */
export async function isHostedRemote(cwd, remote) {
  const result = await runCommandFile("git", ["-C", cwd, "config", "--get", `remote.${remote}.url`], cwd, 30_000);
  const url = result.exitCode === 0 ? result.stdout.trim() : "";
  if (!url || /^file:/i.test(url)) return false;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/\\\s]+@[^/\\\s:]+:/.test(url);
}
