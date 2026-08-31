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
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export function pathAllowed(filePath, writablePaths) {
  if (writablePaths.length === 0) return false;
  const normalizedFile = normalizeRelativePath(filePath);
  return writablePaths.some((pattern) => pathMatchesPattern(normalizedFile, pattern));
}

export function pathMatchesPattern(filePath, pattern) {
  const normalizedPattern = normalizeRelativePath(pattern);
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
