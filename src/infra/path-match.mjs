/**
 * Pure path/glob matching used by scope enforcement (capabilities/scope-guard.mjs),
 * rule scanning (ai/rules.mjs), and hook preflight checks (orchestration/hooks.mjs).
 * No side effects, no dependencies on any other zone.
 */
import path from "node:path";

export function assertPathInsideRoot(rootDir, absolutePath, displayPath, label = "path") {
  const relative = path.relative(rootDir, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes project root: ${displayPath}`);
  }
}

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

export function pathAllowed(filePath, writablePaths) {
  if (writablePaths.length === 0) return false;
  const normalizedFile = normalizeRelativePath(filePath);
  if (escapesRelativeRoot(normalizedFile)) return false;
  return writablePaths.some((pattern) => pathMatchesPattern(normalizedFile, pattern));
}

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
