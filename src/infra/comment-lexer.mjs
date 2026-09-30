// =============================================================================
// 文件名称：comment-lexer.mjs
// 所属模块：infra
// 作用说明：
//   源码注释词法器：按扩展名抽取 JS/TS（含模板表达式，跳过字符串与正则正文）、# 与定界符注释，
//   供仓库治理的注释规则与 review 注释检查共用。
// =============================================================================
import path from "node:path";

/** 计为「源码文件」的扩展名集合。 */
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

/**
 * extractComments：本模块对外API。
 */
export function extractComments(filePath, content) {
  const extension = path.extname(filePath).toLowerCase();
  if (SOURCE_EXTENSIONS.has(extension) || extension === ".css" || extension === ".rs") {
    return extractSlashComments(content);
  }
  if ([".py", ".rb", ".sh", ".yaml", ".yml"].includes(extension)) {
    return extractHashComments(content);
  }
  if (extension === ".html" || extension === ".md") {
    return extractDelimitedComments(content, "<!--", "-->");
  }
  return [];
}

/**
 * 词法扫描 JS/TS 源码提取 // 与块注释（跳过字符串/正则/模板）。
 */
function extractSlashComments(content) {
  const comments = [];
  let line = 1;
  let index = 0;
  let state = "code";
  let startLine = 1;
  let buffer = "";
  let regexInClass = false;
  const templateReturnStates = [];
  const templateExpressions = [];
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];
    if (state === "line") {
      if (char === "\n") {
        comments.push({ line: startLine, text: buffer });
        buffer = "";
        state = "code";
        line += 1;
      } else {
        buffer += char;
      }
      index += 1;
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        comments.push({ line: startLine, text: buffer });
        buffer = "";
        state = "code";
        index += 2;
      } else {
        buffer += char;
        if (char === "\n") line += 1;
        index += 1;
      }
      continue;
    }
    if (state === "single" || state === "double") {
      const delimiter = state === "single" ? "'" : "\"";
      if (char === "\\") {
        if (next === "\n") line += 1;
        index += 2;
      } else {
        if (char === delimiter) state = "code";
        if (char === "\n") line += 1;
        index += 1;
      }
      continue;
    }
    if (state === "regex") {
      if (char === "\\") {
        index += 2;
      } else if (char === "[" && !regexInClass) {
        regexInClass = true;
        index += 1;
      } else if (char === "]" && regexInClass) {
        regexInClass = false;
        index += 1;
      } else if (char === "/" && !regexInClass) {
        state = "code";
        index += 1;
        while (/[a-z]/i.test(content[index] || "")) index += 1;
      } else {
        if (char === "\n") {
          line += 1;
          state = "code";
          regexInClass = false;
        }
        index += 1;
      }
      continue;
    }
    if (state === "template") {
      if (char === "\\") {
        if (next === "\n") line += 1;
        index += 2;
      } else if (char === "`") {
        state = templateReturnStates.pop() || "code";
        index += 1;
      } else if (char === "$" && next === "{") {
        templateExpressions.push({ braceDepth: 1 });
        state = "code";
        index += 2;
      } else {
        if (char === "\n") line += 1;
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      state = char === "'" ? "single" : "double";
      index += 1;
    } else if (char === "`") {
      templateReturnStates.push("code");
      state = "template";
      index += 1;
    } else if (char === "/" && next === "/") {
      state = "line";
      startLine = line;
      index += 2;
    } else if (char === "/" && next === "*") {
      state = "block";
      startLine = line;
      index += 2;
    } else if (char === "/" && canStartRegex(content, index)) {
      state = "regex";
      regexInClass = false;
      index += 1;
    } else if (templateExpressions.length > 0 && char === "{") {
      templateExpressions.at(-1).braceDepth += 1;
      index += 1;
    } else if (templateExpressions.length > 0 && char === "}") {
      const expression = templateExpressions.at(-1);
      expression.braceDepth -= 1;
      index += 1;
      if (expression.braceDepth === 0) {
        templateExpressions.pop();
        state = "template";
      }
    } else {
      if (char === "\n") line += 1;
      index += 1;
    }
  }
  if (state === "line" && buffer) comments.push({ line: startLine, text: buffer });
  if (state === "block" && buffer) comments.push({ line: startLine, text: buffer });
  return comments;
}

/**
 * 判断 / 在源码位置是否开启正则字面量而非除法。
 */
function canStartRegex(content, slashIndex) {
  let cursor = slashIndex - 1;
  while (cursor >= 0 && /\s/.test(content[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  if ("([{=,:;!?&|+-*%^~<>".includes(content[cursor])) return true;
  let end = cursor + 1;
  while (cursor >= 0 && /[A-Za-z0-9_$]/.test(content[cursor])) cursor -= 1;
  const previousWord = content.slice(cursor + 1, end);
  return /^(?:return|case|throw|typeof|instanceof|in|of|yield|await|delete|void|new)$/.test(previousWord);
}

/**
 * 提取 # 风格注释（跳过引号内与 shebang）。
 */
function extractHashComments(content) {
  const comments = [];
  content.split(/\r?\n/).forEach((line, index) => {
    let quote = null;
    for (let cursor = 0; cursor < line.length; cursor += 1) {
      const char = line[cursor];
      if (char === "\\" && quote) {
        cursor += 1;
        continue;
      }
      if ((char === "'" || char === "\"") && (!quote || quote === char)) {
        quote = quote ? null : char;
        continue;
      }
      if (char === "#" && !quote && !(index === 0 && cursor === 0 && line.startsWith("#!"))) {
        comments.push({ line: index + 1, text: line.slice(cursor + 1) });
        break;
      }
    }
  });
  return comments;
}

/**
 * 提取定界符包裹的注释（如 HTML <!-- -->）。
 */
function extractDelimitedComments(content, open, close) {
  const comments = [];
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf(open, cursor);
    if (start < 0) break;
    const end = content.indexOf(close, start + open.length);
    const finish = end < 0 ? content.length : end;
    comments.push({
      line: content.slice(0, start).split(/\r?\n/).length,
      text: content.slice(start + open.length, finish),
    });
    cursor = finish + close.length;
  }
  return comments;
}
