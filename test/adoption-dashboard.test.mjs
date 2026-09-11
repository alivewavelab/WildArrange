import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { startDashboardServer } from "../src/interface/dashboard.mjs";
import { decideAdoptionCard, startAdoption } from "../src/orchestration/adoption.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-adoption-ui-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function listen(dir, options = {}) {
  const server = await startDashboardServer(dir, { host: "127.0.0.1", port: 0, ...options });
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

function request(base, pathname, { method = "GET", token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const req = http.request(url, {
      method,
      headers: {
        host: url.host,
        origin: url.origin,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

test("dashboard adoption GET is available and HTML contains the panel", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await writeFile(path.join(dir, "README.md"), "# Demo\n", "utf8");
    const { server, base } = await listen(dir);
    try {
      const page = await request(base, "/");
      assert.equal(page.status, 200);
      assert.match(page.text, /location\.hash\.startsWith\("#adoption\?"\)/);
      assert.match(page.text, /sessionStorage\.setItem\(DASHBOARD_TOKEN_KEY, token\)/);
      assert.match(page.text, /项目治理/);
      assert.match(page.text, /治理问题整理/);
      assert.match(page.text, /id="governanceCleanup" hidden/);
      assert.match(page.text, /id="governanceLedgers"/);
      assert.match(page.text, /当前只保留原样，不提供归档、合并或删除/);
      const api = await request(base, "/api/adoption/session");
      assert.equal(api.status, 200);
      assert.equal(api.json.ok, true);
      const governance = await request(base, "/api/adoption/governance");
      assert.equal(governance.status, 200);
      assert.deepEqual(governance.json.ledgers.map((ledger) => ledger.title), ["检查规则", "执行基线", "治理资产"]);
      assert.ok(governance.json.ledgers.every((ledger) => ledger.exists === false));
      assert.ok(governance.json.groups.find((group) => group.id === "product").files.some((file) => file.path === "README.md"));
      const preview = await request(base, "/api/adoption/file?path=README.md");
      assert.equal(preview.status, 200);
      assert.equal(preview.json.file.content, "# Demo\n");
      const traversal = await request(base, "/api/adoption/file?path=../AGENTS.md");
      assert.equal(traversal.status, 400);
    } finally {
      server.close();
    }
  });
});

test("dashboard adoption writes require Host/Origin/token and reject bad ids", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const token = "secret-token";
    const { server, base } = await listen(dir, { token });
    try {
      const unauth = await request(base, "/api/adoption/decision", {
        method: "POST",
        body: { cardId: "card_001", decision: "approved" },
      });
      assert.equal(unauth.status, 401);
      const cross = await request(base, "/api/adoption/decision", {
        method: "POST",
        token,
        headers: { origin: "https://evil.example" },
        body: { cardId: "card_001", decision: "approved" },
      });
      assert.equal(cross.status, 403);
      const badId = await request(base, "/api/adoption/decision", {
        method: "POST",
        token,
        body: { cardId: "../etc/passwd", decision: "approved" },
      });
      assert.equal(badId.status, 400);
      const huge = await request(base, "/api/adoption/decision", {
        method: "POST",
        token,
        body: { cardId: "card_001", decision: "approved", padding: "x".repeat(70_000) },
      });
      assert.ok(huge.status === 413 || huge.status === 400, `oversized body must be 4xx, got ${huge.status}`);
      assert.notEqual(huge.status, 500);
    } finally {
      server.close();
    }
  });
});

test("dashboard can approve one card at a time and rejects batched sensitive approval", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node --version" } }, null, 2));
    await mkdir(path.join(dir, "test"), { recursive: true });
    await writeFile(path.join(dir, "test", "a.test.mjs"), "export const a = 1;\n");
    const started = await startAdoption(dir, { serve: false });
    const token = "adopt-token";
    const { server, base } = await listen(dir, { token });
    try {
      const session = await request(base, "/api/adoption/session", { token });
      assert.equal(session.json.session.sessionId, started.session.sessionId);
      const sensitive = session.json.cards.find((item) => ["merge", "delete", "archive"].includes(item.action)
        || /AGENTS\.md|package\.json|wildarrange\.config\.json/i.test(item.path || "")
        || (Array.isArray(item.verify) && item.verify.length > 0));
      const other = session.json.cards.find((item) => item.id !== sensitive?.id);
      assert.ok(sensitive && other, "scan should provide a sensitive card and another decision");
      const batched = await request(base, "/api/adoption/decision", {
        method: "POST",
        token,
        body: {
          sessionId: started.session.sessionId,
          cardId: sensitive.id,
          decisions: [
            { cardId: sensitive.id, decision: "approved", fingerprint: sensitive.fingerprint },
            { cardId: other.id, decision: "deferred", fingerprint: other.fingerprint },
          ],
        },
      });
      assert.equal(batched.status, 400);
      assert.equal(batched.json.code, "sensitive_card");
      const card = session.json.cards[0];
      const approved = await request(base, "/api/adoption/decision", {
        method: "POST",
        token,
        body: { sessionId: started.session.sessionId, cardId: card.id, decision: "approved", fingerprint: card.fingerprint },
      });
      assert.equal(approved.status, 200);
      assert.equal(approved.json.ok, true);
    } finally {
      server.close();
    }
  });
});

test("dashboard apply rejects multiple cardIds with 400 and accepts a single cardId with 200", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node --version" } }, null, 2));
    await mkdir(path.join(dir, "test"), { recursive: true });
    await writeFile(path.join(dir, "test", "a.test.mjs"), "export const a = 1;\n");
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator") || started.cards[0];
    const other = started.cards.find((card) => card.id !== locatorCard.id) || { id: "card_other" };
    for (const card of started.cards) {
      await decideAdoptionCard(dir, {
        sessionId: started.session.sessionId,
        cardId: card.id,
        decision: card.id === locatorCard.id ? "approved" : "deferred",
        fingerprint: card.fingerprint,
      });
    }
    const token = "adopt-apply-token";
    const { server, base } = await listen(dir, { token });
    try {
      const multi = await request(base, "/api/adoption/apply", {
        method: "POST",
        token,
        body: { sessionId: started.session.sessionId, cardIds: [locatorCard.id, other.id] },
      });
      assert.equal(multi.status, 400);
      const single = await request(base, "/api/adoption/apply", {
        method: "POST",
        token,
        body: { sessionId: started.session.sessionId, cardId: locatorCard.id },
      });
      assert.equal(single.status, 200);
      assert.equal(single.json.ok, true);
    } finally {
      server.close();
    }
  });
});

test("dashboard apply rejects pending cards with 409 and 先判完", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", scripts: { test: "node --version" } }, null, 2));
    await mkdir(path.join(dir, "test"), { recursive: true });
    await writeFile(path.join(dir, "test", "a.test.mjs"), "export const a = 1;\n");
    const started = await startAdoption(dir, { serve: false });
    const locatorCard = started.cards.find((card) => card.asset === "config_locator") || started.cards[0];
    await decideAdoptionCard(dir, {
      sessionId: started.session.sessionId,
      cardId: locatorCard.id,
      decision: "approved",
      fingerprint: locatorCard.fingerprint,
    });
    const token = "adopt-pending-token";
    const { server, base } = await listen(dir, { token });
    try {
      const blocked = await request(base, "/api/adoption/apply", {
        method: "POST",
        token,
        body: { sessionId: started.session.sessionId, cardId: locatorCard.id },
      });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.json.ok, false);
      assert.equal(blocked.json.status, "pending_decisions");
      assert.match(String(blocked.json.error || ""), /先判完/);
    } finally {
      server.close();
    }
  });
});
