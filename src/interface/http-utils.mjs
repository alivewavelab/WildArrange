// =============================================================================
// 文件名称：http-utils.mjs
// 所属模块：interface
// 作用说明：
//   Dashboard 与 Adoption 面板共享的 HTTP 辅助：JSON 响应、请求体读取与 id 校验模式。
//   不包含路由分发，由各 server/panel 模块自行调用。
//
// 【运行原理速读】
//   可以把它想成「本地 Dashboard 的 HTTP 小工具箱」：
//
//   · 谁调用？
//     dashboard.mjs、adoption-panel.mjs 在处理 /api/* 请求时使用。
//
//   · 它做了什么？
//     ① sendJson 统一 JSON 响应头 ② readJsonBody 流式读取并限 64KB
//     ③ SAFE_ID 供 taskId/sessionId 等参数校验。
//
//   · 失败如何区分？
//     请求体过大抛 code=payload_too_large；JSON 非法抛 code=invalid_json。
// =============================================================================

/** 允许作为 taskId、sessionId、cardId 等的安全 id 模式（128 字符内）。 */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** readJsonBody 允许的最大请求体字节数。 */
const MAX_BODY_BYTES = 64_000;

/**
 * 写入 JSON 响应并结束连接。
 * @param {import("node:http").ServerResponse} response
 * @param {number} statusCode
 * @param {unknown} value
 */
export function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 从 HTTP 请求流读取并解析 JSON  body；空 body 返回 {}。
 * @param {import("node:http").IncomingMessage} request
 * @returns {Promise<Record<string, unknown>>}
 */
export function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      bodyBytes += chunk.length;
      // 流式累计字节，超限立即 reject，避免大 body 占满内存。
      if (bodyBytes > MAX_BODY_BYTES) {
        settled = true;
        // §3.4：body 超 64KB 立即 reject，防止 Dashboard API 被大 payload 拖垮内存。
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
        // §3.4：非法 JSON 拒绝解析，避免半结构对象进入 adoption/annotation 写路径。
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
