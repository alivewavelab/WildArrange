// =============================================================================
// 文件名称：path-match.mjs
// 所属模块：infra
// 作用说明：
//   纯函数路径/glob 匹配与根目录边界断言，供 scope  enforcement、
//   规则扫描与 hook 预检使用。无副作用，不依赖其他业务分区。
//
// 【运行原理速读】
//   可以把它想成「项目内的路径围栏与通配符裁判」：
//
//   · 谁调用？
//     scope-guard、rule-scanner、context-attachments 在判断文件是否在允许范围内时。
//
//   · 它做了什么？
//     ① 规范化相对路径 ② glob 模式匹配 ③ 断言绝对路径不逃逸项目根。
//
//   · 缺了它会怎样？
//     各模块各自解析路径，scope 边界不一致，存在目录穿越风险。
// =============================================================================
import path from "node:path";

/**
 * 断言绝对路径位于 rootDir 之内，否则抛错。
 * @param {string} rootDir 项目根绝对路径
 * @param {string} absolutePath 待检查的绝对路径
 * @param {string} displayPath 用于错误消息的路径展示
 * @param {string} [label] 错误前缀标签
 */
export function assertPathInsideRoot(rootDir, absolutePath, displayPath, label = "path") {
  const relative = path.relative(rootDir, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes project root: ${displayPath}`);
  }
}

/**
 * 规范化相对路径：统一斜杠、折叠 `.`/`..` 段，保留 leading `/`。
 * @param {string} filePath 原始路径
 * @returns {string}
 */
export function normalizeRelativePath(filePath) {
  const unified = filePath.replaceAll("\\", "/").replace(/\/+/g, "/");
  const segments = [];
  for (const segment of unified.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length > 0 && segments[segments.length - 1] !== "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const prefix = unified.startsWith("/") ? "/" : "";
  return `${prefix}${segments.join("/")}`;
}

/**
 * 判断文件路径是否匹配 writablePaths 中任一 glob/前缀模式。
 * @param {string} filePath 待检路径
 * @param {string[]} writablePaths 允许写入的模式列表
 * @returns {boolean}
 */
export function pathAllowed(filePath, writablePaths) {
  if (writablePaths.length === 0) return false;
  const normalizedFile = normalizeRelativePath(filePath);
  if (escapesRelativeRoot(normalizedFile)) return false;
  return writablePaths.some((pattern) => pathMatchesPattern(normalizedFile, pattern));
}

/**
 * 单条 glob/字面量/目录前缀模式是否与文件路径匹配。
 * @param {string} filePath 已规范化的相对路径
 * @param {string} pattern 模式字符串
 * @returns {boolean}
 */
export function pathMatchesPattern(filePath, pattern) {
  const normalizedPattern = normalizeRelativePath(pattern);
  if (escapesRelativeRoot(normalizedPattern)) return false;
  if (normalizedPattern === filePath) return true;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  if (!normalizedPattern.includes("*")) {
    const literalPattern = normalizedPattern.replace(/\/$/, "");
    return filePath === literalPattern || filePath.startsWith(`${literalPattern}/`);
  }

  return new RegExp(`^${globPatternSource(normalizedPattern)}$`).test(filePath);
}

function escapesRelativeRoot(filePath) {
  return filePath.startsWith("/")
    || /^[A-Za-z]:(\/|$)/.test(filePath)
    || filePath === ".."
    || filePath.startsWith("../");
}

function globPatternSource(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*" && pattern[index + 2] === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return source;
}
