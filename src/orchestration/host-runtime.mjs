// =============================================================================
// 文件名称：host-runtime.mjs
// 所属模块：orchestration
// 作用说明：
//   宿主入口编排：统一 runtime 初始化、功能设计门推进与路由/Hook 渲染顺序。
//   CLI 组合渲染器，本模块只定业务调用次序。
//
// 【运行原理速读】
//   可以把它想成「宿主请求的调度前台」：
//
//   · 何时执行？
//     CLI 或 adapter 处理路由分类或 Hook 事件前。
//
//   · 做了什么？
//     ① initRuntime ② 按需推进 feature-design 门 ③ 委托 classify/renderHook。
// =============================================================================
import { initRuntime } from "../infra/runtime-bootstrap.mjs";
import { advanceFeatureDesign } from "./feature-design.mjs";

/**
 * 宿主路由入口：初始化后推进功能设计门，再执行分类。
 * @param {string} rootDir 项目根目录
 * @param {object} input 宿主输入
 * @param {Function} classify 分类函数
 */
export async function runHostRoute(rootDir, input, classify) {
  await initRuntime(rootDir);
  await advanceFeatureDesign(rootDir, input);
  return classify(rootDir, input);
}

/**
 * 宿主 Hook 入口：UserPromptSubmit 时推进功能设计门，再渲染 Hook 响应。
 * @param {string} rootDir 项目根目录
 * @param {object} input Hook 载荷
 * @param {Function} renderHook Hook 渲染器
 */
export async function runHostHook(rootDir, input, renderHook) {
  await initRuntime(rootDir);
  const event = input.hook_event_name || input.event || input.name;
  if (["UserPromptSubmit", "user_prompt_submit"].includes(event) && input.prompt) {
    await advanceFeatureDesign(rootDir, { text: input.prompt, sessionId: input.session_id || input.sessionId || "session" });
  }
  return renderHook(rootDir, input);
}
