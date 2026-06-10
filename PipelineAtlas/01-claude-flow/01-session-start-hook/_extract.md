# Node: 01-session-start-hook
<!-- Source: .claude/settings.json (hooks.SessionStart) -->
<!-- Source: .claude/helpers/hook-handler.cjs lines 162-178 (session-restore handler) -->
<!-- Source: .claude/helpers/auto-memory-hook.mjs (import subcommand) -->

## What it injects
On SessionStart, Claude Code fires two commands in sequence:
1. `hook-handler.cjs session-restore` — restores or starts a session via `session.cjs`, then initialises the intelligence graph (`intelligence.init()`), logging loaded pattern/edge counts.
2. `auto-memory-hook.mjs import` — imports persisted memory from the last session into the active context.

## Key section in hook-handler.cjs (lines 162-178)
```js
'session-restore': async () => {
  if (session) {
    var existing = session.restore && session.restore();
    if (!existing) {
      session.start && session.start();
    }
  } else {
    console.log('[OK] Session restored: session-' + Date.now());
  }
  // Initialize intelligence (with timeout — #1530)
  if (intelligence && intelligence.init) {
    var initResult = await runWithTimeout(function() { return intelligence.init(); }, 'intelligence.init()');
    if (initResult && initResult.nodes > 0) {
      console.log('[INTELLIGENCE] Loaded ' + initResult.nodes + ' patterns, ' + initResult.edges + ' edges');
    }
  }
},
```

## settings.json hook definition
```json
"SessionStart": [
  {
    "hooks": [
      { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/helpers/hook-handler.cjs\" session-restore", "timeout": 15000 },
      { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/helpers/auto-memory-hook.mjs\" import", "timeout": 8000 }
    ]
  }
]
```
