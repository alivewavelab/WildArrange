// =============================================================================
// 文件名称：team-messages.mjs
// 所属模块：orchestration
// 作用说明：
//   团队消息：向 agent 收件箱发消息并列出历史。与任务板状态无关。
//
// 【运行原理速读】
//   可以把它想成「Agent 之间的留言箱」：
//
//   · 何时执行？
//     CLI `team message`、Dashboard 消息面板、并行运行通知 Lead 时。
//
//   · 做了什么？
//     发送 = 写 inbox/<收件人>/<id>.json + 入账本一条审计；列出 = 只读 inbox。
// =============================================================================
import { readdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LEAD_AGENT, normalizeAgentKey } from "../infra/agent-registry.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { normalizeRelativePath } from "../infra/path-match.mjs";
import {
  createWorkId,
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";

/** 发送团队消息：写收件人 inbox 并记入账本。 */
export async function sendTeamMessage(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const to = normalizeAgentKey(options.to);
  const from = normalizeAgentKey(options.from || DEFAULT_LEAD_AGENT);
  const body = typeof options.body === "string" ? options.body.trim() : "";
  if (!to) throw new Error("message recipient is required");
  if (!body) throw new Error("message body is required");
  const id = createWorkId("msg");
  const message = {
    id,
    kind: "team_message",
    at: nowIso(),
    from,
    to,
    summary: options.summary || body.slice(0, 120),
    body,
    status: "unread",
  };
  const inboxPath = resolveWildArrangePath(rootDir, "team", "inbox", to, `${id}.json`);
  await writeJsonAtomic(inboxPath, message);
  await appendLedger(rootDir, { type: "team_message_sent", messageId: id, from, to, summary: message.summary });
  return {
    ...message,
    inboxPath: normalizeRelativePath(path.relative(rootDir, inboxPath)),
  };
}

/** 列出团队消息历史。 */
export async function listTeamMessages(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const agent = normalizeAgentKey(options.agent || options.to);
  const baseDir = agent ? resolveWildArrangePath(rootDir, "team", "inbox", agent) : resolveWildArrangePath(rootDir, "team", "inbox");
  const messages = [];
  if (agent) {
    for (const fileName of await safeReadDir(baseDir)) {
      if (/^msg_.+\.json$/.test(fileName)) {
        messages.push(await readJson(path.join(baseDir, fileName)));
      }
    }
  } else {
    for (const agentDir of await safeReadDir(baseDir)) {
      const dirPath = path.join(baseDir, agentDir);
      for (const fileName of await safeReadDir(dirPath)) {
        if (/^msg_.+\.json$/.test(fileName)) {
          messages.push(await readJson(path.join(dirPath, fileName)));
        }
      }
    }
  }
  messages.sort((left, right) => String(left.at).localeCompare(String(right.at)));
  await appendLedger(rootDir, { type: "team_messages_listed", agent: agent || "all", count: messages.length });
  return messages;
}

/** 读取目录，不存在时返回空数组而非抛错。 */
async function safeReadDir(dirPath) {
  try {
    return await readdir(dirPath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
