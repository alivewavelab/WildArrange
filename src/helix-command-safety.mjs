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

export function evaluateCommandSafety(command, options = {}) {
  const text = typeof command === "string" ? command.trim() : "";
  if (!text) {
    return { allowed: true, level: "safe", findings: [] };
  }
  if (options.allowUnsafe === true || process.env.HELIX_ALLOW_UNSAFE_COMMANDS === "1") {
    return { allowed: true, level: "override", findings: [] };
  }

  const findings = HIGH_RISK_PATTERNS
    .filter((item) => item.pattern.test(text))
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
