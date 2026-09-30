// =============================================================================
// 文件名称：hook-entry.mjs
// 所属模块：interface
// 作用说明：
//   `wildarrange hook run` 的载荷信任与 digest 决策：宿主 Hook 载荷不可信，
//   CLI 命令前缀只能取自当前进程 / 已安装 adapter，不能信任 payload 内嵌值。
//   bin 只负责读取载荷与输出；本模块决定哪些字段可信并进入 host-runtime。
// =============================================================================
import path from "node:path";
import { DEFAULT_PACKAGE_NAME } from "../infra/runtime-config.mjs";
import { resolveRuntimeCliCommandPrefix } from "../infra/runtime-snapshot.mjs";
import { runHostHook } from "../orchestration/host-runtime.mjs";
import { adapterCliPrefix } from "./adapters.mjs";

/**
 * 校验并补全宿主 Hook 载荷后执行 Hook。
 * @param {string} rootDir 项目根目录
 * @param {object} options
 * @param {object} options.payload 宿主传入的 Hook 载荷（不可信，会被就地补全）
 * @param {string} [options.hostAdapter] 宿主名（--host 或 WILDARRANGE_HOST_ADAPTER）
 * @param {string} [options.adapterDigest] adapter 安装 digest（必填）
 * @param {string} [options.adapterMode] 外置 bridge 传入的 local/npx；缺省表示由运行态推断前缀
 * @param {string} [options.adapterPackage] npx 模式包名
 * @param {string} options.cliPath 当前进程 CLI 绝对路径
 * @param {Function} options.renderHook Hook 渲染器（由 bin 组合 AI 层注入）
 * @param {symbol} options.trustedPrefixKey 受信任前缀在载荷上的 Symbol 键（由 AI 层定义）
 * @returns {Promise<object>} Hook 结果
 */
export async function runHookEntry(rootDir, options) {
  const { payload, hostAdapter, adapterDigest, adapterMode, adapterPackage, cliPath, renderHook, trustedPrefixKey } = options;
  if (hostAdapter) payload.host_adapter = hostAdapter;
  if (!adapterDigest) throw new Error("host hook requires --adapter-digest");
  payload.hook_config_digest = adapterDigest;
  // Hook 载荷来自宿主且不可信；cli_command_prefix 必须取自当前进程 CLI，
  // 禁止信任 payload 内嵌前缀，否则 PreToolUse 可被伪造绕过。
  const cliCommandPrefix = adapterMode !== undefined
    ? adapterCliPrefix({
      mode: adapterMode,
      packageName: adapterPackage || DEFAULT_PACKAGE_NAME,
      localCliPath: path.resolve(cliPath),
    })
    : await resolveRuntimeCliCommandPrefix(rootDir, { fallbackCliPath: path.resolve(cliPath) });
  if (!cliCommandPrefix) throw new Error("WildArrange CLI command prefix is unavailable; reinstall the adapter");
  payload.cli_command_prefix = cliCommandPrefix;
  payload[trustedPrefixKey] = cliCommandPrefix;
  return runHostHook(rootDir, payload, renderHook);
}
