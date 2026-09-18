import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { startDashboardServer } from "../src/interface/dashboard.mjs";
import { readJsonBody } from "../src/interface/http-utils.mjs";

function fakeRequest(chunks) {
  return Readable.from(chunks);
}

test("readJsonBody treats empty and whitespace-only bodies as empty object", async () => {
  assert.deepEqual(await readJsonBody(fakeRequest([])), {});
  assert.deepEqual(await readJsonBody(fakeRequest(["   \n  "])), {});
});

test("readJsonBody rejects bad JSON with invalid_json and oversize with payload_too_large", async () => {
  await assert.rejects(readJsonBody(fakeRequest(["{not json"])), (error) => {
    assert.equal(error.code, "invalid_json");
    return true;
  });
  await assert.rejects(readJsonBody(fakeRequest(["x".repeat(64_001)])), (error) => {
    assert.equal(error.code, "payload_too_large");
    return true;
  });
});

test("dashboard panels answer bad JSON bodies with a consistent 400", async () => {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-http-utils-"));
  const token = "http-utils-token";
  let server;
  try {
    await initRuntime(dir);
    server = await startDashboardServer(dir, { host: "127.0.0.1", port: 0, token });
    const base = `http://127.0.0.1:${server.address().port}`;
    const postBadJson = (pathname) => new Promise((resolve, reject) => {
      const url = new URL(pathname, base);
      const req = http.request(url, {
        method: "POST",
        headers: {
          host: url.host,
          origin: url.origin,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      req.on("error", reject);
      req.end("{not json");
    });

    const dashboardApi = await postBadJson("/api/tasks/create");
    assert.equal(dashboardApi.status, 400);
    assert.equal(dashboardApi.json.ok, false);

    const adoptionApi = await postBadJson("/api/adoption/decision");
    assert.equal(adoptionApi.status, 400);
    assert.equal(adoptionApi.json.ok, false);
    assert.equal(adoptionApi.json.code, "invalid_json");

    assert.equal(existsSync(path.join(dir, ".wildarrange", "team", "tasks.json")), false,
      "rejected bodies must not persist any task state");
  } finally {
    server?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
