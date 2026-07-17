const HIGH_RISK_PATTERNS = [
  {
    id: "sudo",
    pattern: /(^|[\s;&|])sudo([\s;&|]|$)/i,
    reason: "sudo can escape the project trust boundary",
  },
  {
    id: "recursive_root_delete",
    pattern: /\brm\s+[^;&|]*(?:-[^\s;&|]*r[^\s;&|]*f|-[^\s;&|]*f[^\s;&|]*r|--recursive)[^;&|]*(?:\s\/|\s~|\s\$HOME|(?:^|[\s/"'])\.\.(?:[\s/"']|$))/i,
    reason: "recursive deletion targets root, home, or parent paths",
  },
  {
    id: "runtime_or_git_delete",
    pattern: /\brm\s+[^;&|]*(?:-[^\s;&|]*r[^\s;&|]*f|-[^\s;&|]*f[^\s;&|]*r|--recursive)[^;&|]*(?:\.git|\.helix)(?:[\s/"']|$)/i,
    reason: "recursive deletion targets Git or WildArrange runtime state",
  },
  {
    id: "project_source_delete",
    pattern: /\brm\s+[^;&|]*(?:-[^\s;&|]*r[^\s;&|]*f|-[^\s;&|]*f[^\s;&|]*r|--recursive)[^;&|]*(?:^|[\s"'=])(?:\.\/)?(?:src|lib|app|apps|test|tests|doc|docs|bin|packages|source)(?:\/[^\s;&|"']*)?(?:[\s;&|"']|$)/i,
    reason: "recursive deletion targets project source, test, or doc directories",
  },
  {
    id: "project_source_delete_node",
    pattern: /\brm(?:Sync)?\(\s*["'`](?:\.\/)?(?:src|lib|app|apps|test|tests|doc|docs|bin|packages|source)["'`/][^)]*recursive\s*:\s*true/i,
    reason: "inline Node recursive deletion targets project source, test, or doc directories",
  },
  {
    id: "git_history_destroy",
    pattern: /\bgit\s+(?:-[^\s]+\s+)*reset\s+--hard\b|\bgit\s+(?:-[^\s]+\s+)*clean\s+-[^\s;&|]*[fd][^\s;&|]*\b/i,
    reason: "git reset --hard or git clean can delete uncommitted work",
  },
  {
    id: "disk_write",
    pattern: /\bdd\s+[^;&|]*\bof=|\bmkfs(?:\.[\w-]+)?\b/i,
    reason: "raw disk write or filesystem formatting command",
  },
  {
    id: "system_power",
    pattern: /\b(?:shutdown|reboot|halt)\b/i,
    reason: "system power command is outside task scope",
  },
  {
    id: "unsafe_permissions",
    pattern: /\bchmod\s+-R\s+777\b|\bchown\s+-R\b/i,
    reason: "recursive permission or ownership changes are high risk",
  },
  {
    id: "remote_shell_pipe",
    pattern: /\b(?:curl|wget)\b[^;&|]*\|[^;&|]*\b(?:sh|bash|zsh)\b/i,
    reason: "remote script piped directly into a shell",
  },
  {
    id: "fork_bomb",
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/,
    reason: "fork bomb pattern",
  },
];

// 把 helix.config.json 里 commandSafety.extraPatterns 编译成可用的正则规则。
// 内置 HIGH_RISK_PATTERNS 始终作为不可削弱的底线；这里只做“加法”，让用户补充项目专属危险命令。
export function compileCommandSafetyPatterns(config) {
  const raw = Array.isArray(config?.commandSafety?.extraPatterns) ? config.commandSafety.extraPatterns : [];
  const compiled = [];
  for (const entry of raw) {
    if (!entry || typeof entry.pattern !== "string" || entry.pattern.length === 0) continue;
    let regex;
    try {
      regex = new RegExp(entry.pattern, typeof entry.flags === "string" ? entry.flags : "i");
    } catch {
      continue;
    }
    compiled.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : `custom_${compiled.length + 1}`,
      pattern: regex,
      reason: typeof entry.reason === "string" && entry.reason ? entry.reason : "matched a project-configured high-risk command pattern",
      source: "config",
    });
  }
  return compiled;
}

export function evaluateCommandSafety(command, options = {}) {
  const text = typeof command === "string" ? command.trim() : "";
  if (!text) {
    return { allowed: true, level: "safe", findings: [] };
  }
  if (options.allowUnsafe === true || process.env.HELIX_ALLOW_UNSAFE_COMMANDS === "1") {
    return { allowed: true, level: "override", findings: [] };
  }

  const extraPatterns = Array.isArray(options.extraPatterns) ? options.extraPatterns : [];
  const findings = [...HIGH_RISK_PATTERNS, ...extraPatterns]
    .filter((item) => item.pattern instanceof RegExp && item.pattern.test(text))
    .map(({ id, reason }) => ({ id, reason }));

  return {
    allowed: findings.length === 0,
    level: findings.length === 0 ? "safe" : "blocked",
    findings,
  };
}

export function blockedCommandResult(command, safety) {
  const summary = safety.findings.map((finding) => `${finding.id}: ${finding.reason}`).join("; ");
  return {
    exitCode: 126,
    stdout: "",
    stderr: `Command blocked by WildArrange command safety: ${summary}`,
    safety: {
      command,
      ...safety,
    },
  };
}
