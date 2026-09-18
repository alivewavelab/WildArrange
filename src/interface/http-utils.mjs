/**
 * Dashboard 各面板共享的 HTTP 设施：JSON 响应、带 64KB 上限的 JSON 请求体读取
 * 与通用 id 模式。请求体失败以 code 区分——"invalid_json"（400）与
 * "payload_too_large"（413），由调用方面板的错误映射决定状态码。
 */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const MAX_BODY_BYTES = 64_000;

export function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error("request body too large"), { code: "payload_too_large" }));
        return;
      }
      body += chunk.toString();
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { code: "invalid_json" }));
      }
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
