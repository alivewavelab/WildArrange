// =============================================================================
// 文件名称：error-protocol.mjs
// 所属模块：infra
// 作用说明：
//   统一结构化错误协议：跨 gateway、delivery pipeline 与 CLI 的非零退出
//   均携带 code/module/message/next_action，并渲染为单行可粘贴给 AI 的文本。
//
// 【运行原理速读】
//   可以把它想成「全项目错误的快递面单格式」：
//
//   · 何时执行？
//     任意模块抛错或 CLI 失败时，经 wildarrangeError 或 buildErrorProtocol 包装。
//
//   · 它做了什么？
//     ① 组装四字段协议 ② 格式化为 [WILDARRANGE-code] 单行 ③ 从 Error 对象反查协议。
//
//   · 缺了它会怎样？
//     错误信息碎片化，维护者与 AI 难以定位责任模块与下一步动作。
// =============================================================================

/**
 * 构建标准错误协议对象（不含 Error 实例）。
 * @param {{ code?: string, module?: string, message?: string, nextAction?: string }} params
 * @returns {{ code: string, module: string, message: string, next_action: string }}
 */
export function buildErrorProtocol({ code, module, message, nextAction }) {
  return {
    code: String(code || "unknown_error"),
    module: String(module || "unknown"),
    message: String(message || ""),
    next_action: String(nextAction || "运行 node ./bin/wildarrange.mjs doctor；把本错误完整贴给 AI"),
  };
}

/**
 * 将错误协议格式化为单行人类可读字符串。
 * @param {{ code: string, module: string, message: string, next_action?: string }} protocol
 * @returns {string}
 */
export function formatErrorInline(protocol) {
  const parts = [`[WILDARRANGE-${protocol.code}]`, `(${protocol.module})`, protocol.message];
  if (protocol.next_action) parts.push(`| next: ${protocol.next_action}`);
  return parts.filter(Boolean).join(" ");
}

/**
 * 创建带 protocol 附加属性的 Error，message 为 inline 格式。
 * @param {{ code?: string, module?: string, message?: string, nextAction?: string }} params
 * @returns {Error & { protocol: object }}
 */
export function wildarrangeError({ code, module, message, nextAction }) {
  const protocol = buildErrorProtocol({ code, module, message, nextAction });
  const error = new Error(formatErrorInline(protocol));
  error.protocol = protocol;
  return error;
}

/**
 * 从 Error 或任意值提取协议；无 protocol 时用 fallback 与 message 兜底。
 * @param {unknown} error 原始错误
 * @param {object} [fallback] 默认 code/module 等
 * @returns {{ code: string, module: string, message: string, next_action: string }}
 */
export function errorProtocolOf(error, fallback = {}) {
  if (error && typeof error === "object" && error.protocol) return error.protocol;
  return buildErrorProtocol({
    ...fallback,
    message: error instanceof Error ? error.message : String(error || fallback.message || ""),
  });
}
