// =============================================================================
// 文件名称：contract-discovery.mjs
// 所属模块：capabilities
// 作用说明：
//   契约发现器：静态扫描 Tauri Rust command、handler 注册与前端 invoke，
//   并提供契约条目归一化。只返回事实，不做批准或任务裁决。
//
// 【运行原理速读】
//   walk 源码根 → 先 mask 注释/字符串再正则抽取声明/注册/调用 → 合成 tauri:<name> 契约。
// =============================================================================
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { extractImportSpecifiers, maskSource } from "../infra/dependency-graph.mjs";
import { relative, requireSafeId } from "../infra/contract-governance.mjs";
import { uniqueStrings } from "../infra/text-utils.mjs";

/** 契约扫描 walk 时跳过的目录名。 */
const SKIP_DIRS = new Set([".git", ".wildarrange", "node_modules", "target", "dist", "build", ".tmp"]);

/** 项目是否存在 Rust 侧 Tauri 扫描根（无则不必遍历全仓源码）。 */
export function hasTauriRustRoot(rootDir) {
  return sourceRoots(rootDir).some((item) => item.includes("src-tauri") && existsSync(item));
}

/**
 * discoverTauriIpcContracts：本模块对外异步 API。
 */
export async function discoverTauriIpcContracts(rootDir) {
  const files = await walkSourceFiles(rootDir);
  const rustFiles = files.filter((item) => item.endsWith(".rs"));
  const frontendFiles = files.filter((item) => /\.(?:[cm]?[jt]sx?)$/.test(item));
  const declared = new Map();
  const registered = new Map();
  const callers = new Map();
  const manualSql = new Set();
  const unsupportedInvokeImports = new Set();
  for (const filePath of rustFiles) {
    const source = await readFile(filePath, "utf8");
    for (const found of findTauriCommands(source)) addList(declared, found.name, { path: relative(rootDir, filePath), line: lineOf(source, found.index), signature: found.signature });
    for (const found of findRegisteredCommands(source)) addList(registered, found.name, { path: relative(rootDir, filePath), line: lineOf(source, found.index) });
    if (/\b(?:CREATE|ALTER|DROP)\s+TABLE\b/i.test(source)) manualSql.add(relative(rootDir, filePath));
  }
  for (const filePath of frontendFiles) {
    const source = await readFile(filePath, "utf8");
    const bindings = tauriInvokeBindings(source);
    if (bindings.length === 0) {
      if (importsTauriApi(source)) unsupportedInvokeImports.add(relative(rootDir, filePath));
      continue;
    }
    for (const found of findFrontendInvokes(source, bindings)) addList(callers, found.name, { path: relative(rootDir, filePath), line: lineOf(source, found.index) });
  }
  const names = [...new Set([...declared.keys(), ...registered.keys(), ...callers.keys()])].sort();
  const contracts = names.map((name) => normalizeContract({
    id: `tauri:${name}`,
    kind: "tauri_command",
    name,
    source: { discoverer: "tauri-ipc", declarations: declared.get(name) || [], registrations: registered.get(name) || [] },
    callers: callers.get(name) || [],
    lifecycle: "active",
    status: declared.has(name) && registered.has(name) ? "observed" : "unknown",
    unknown: [
      ...(!declared.has(name) ? ["backend_declaration"] : []),
      ...(!registered.has(name) ? ["handler_registration"] : []),
      "semantic_input_output",
    ],
  }));
  return {
    contracts,
    scannedRoots: sourceRoots(rootDir).map((item) => relative(rootDir, item)),
    scannedFiles: files.length,
    unknown: contracts.filter((item) => item.unknown.length > 0).map((item) => ({ contractId: item.id, fields: item.unknown })),
    manualRequired: [
      ...[...manualSql].sort().map((sourcePath) => ({ kind: "database_sql_in_source", sourcePath, reason: "SQL embedded in Rust source is not parsed by the Tauri IPC discoverer" })),
      ...[...unsupportedInvokeImports].sort().map((sourcePath) => ({ kind: "tauri_invoke_import_unsupported", sourcePath, reason: "Tauri API import style is not statically understood; declare affected contracts manually" })),
    ],
  };
}

/**
 * findTauriCommands：本模块对外API。
 */
export function findTauriCommands(source) {
  const pattern = /#\s*\[\s*tauri::command(?:\([^\]]*\))?\s*\][\s\S]{0,600}?\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\)(?:\s*->\s*[^\{;]+)?)/g;
  return [...maskSource(String(source)).matchAll(pattern)].map((match) => ({ name: match[1], signature: `${match[1]}${match[2].trim()}`, index: match.index }));
}

/**
 * findRegisteredCommands：本模块对外API。
 */
export function findRegisteredCommands(source) {
  const output = [];
  const pattern = /tauri::generate_handler!\s*\[([\s\S]*?)\]/g;
  for (const block of maskSource(String(source)).matchAll(pattern)) {
    for (const item of block[1].split(",")) {
      const cleaned = item.replace(/\/\/.*$/gm, "").trim();
      const name = cleaned.split("::").pop()?.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name || "")) output.push({ name, index: block.index });
    }
  }
  return output;
}

/**
 * findFrontendInvokes：本模块对外API。
 */
export function findFrontendInvokes(source, bindingNames = ["invoke"]) {
  const original = String(source);
  const masked = maskSource(original);
  const names = uniqueStrings(bindingNames).map(escapeRegExp);
  if (names.length === 0) return [];
  const pattern = new RegExp(`\\b(?:${names.join("|")})(?:\\s*<[^>]+>)?\\s*\\(`, "g");
  const found = [];
  for (const match of masked.matchAll(pattern)) {
    let cursor = match.index + match[0].length;
    while (/\s/.test(original[cursor] || "")) cursor += 1;
    const quote = original[cursor];
    if (quote !== '"' && quote !== "'") continue;
    const end = original.indexOf(quote, cursor + 1);
    if (end < 0) continue;
    const name = original.slice(cursor + 1, end);
    if (/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) found.push({ name, index: match.index });
  }
  return found;
}

/**
 * 归一化 Contract 输入为稳定形态。
 */
export function normalizeContract(value) {
  const id = requireSafeId(value.id, "contract id");
  return {
    ...value,
    id,
    kind: String(value.kind || "unknown"),
    name: String(value.name || id),
    lifecycle: String(value.lifecycle || "active"),
    verificationRefs: uniqueStrings(value.verificationRefs || []),
    unknown: uniqueStrings(value.unknown || []),
  };
}

/**
 * walkSourceFiles 内部辅助。
 */
async function walkSourceFiles(rootDir) {
  const files = [];
  for (const sourceRoot of sourceRoots(rootDir)) await walk(sourceRoot, files);
  return [...new Set(files)];
}

/**
 * sourceRoots 内部辅助。
 */
function sourceRoots(rootDir) {
  return [path.join(rootDir, "src"), path.join(rootDir, "client", "src"), path.join(rootDir, "src-tauri", "src"), path.join(rootDir, "client", "src-tauri", "src")];
}

/**
 * 递归遍历目录，跳过 ignored 目录名。
 */
async function walk(directory, output) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute, output);
    else if (/\.(?:rs|[cm]?[jt]sx?)$/.test(entry.name)) output.push(absolute);
  }
}

/**
 * addList 内部辅助。
 */
function addList(map, key, value) {
  map.set(key, [...(map.get(key) || []), value]);
}

/**
 * lineOf 内部辅助。
 */
function lineOf(source, index) {
  return String(source).slice(0, index).split("\n").length;
}

/**
 * importsTauriApi 内部辅助。
 */
function importsTauriApi(source) {
  const specifiers = extractImportSpecifiers(source);
  return specifiers.some((item) => item === "@tauri-apps/api/core" || item === "@tauri-apps/api/tauri");
}

/**
 * tauriInvokeBindings 内部辅助。
 */
function tauriInvokeBindings(source) {
  if (!importsTauriApi(source)) return [];
  const original = String(source);
  const masked = maskSource(original);
  const pattern = /\bimport\s*\{([^}]*)\}\s*from\s*(["'])(@tauri-apps\/api\/(?:core|tauri))\2/g;
  const bindings = [];
  for (const match of original.matchAll(pattern)) {
    if (masked.slice(match.index, match.index + 6) !== "import") continue;
    for (const part of match[1].split(",")) {
      const imported = part.trim().match(/^invoke(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (imported) bindings.push(imported[1] || "invoke");
    }
  }
  return uniqueStrings(bindings);
}

/**
 * 转义 RegExp 特殊字符。
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
