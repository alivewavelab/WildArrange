# Node: 03-session-end-hook
<!-- Source: .claude/settings.json (hooks.SessionEnd + hooks.Stop) -->
<!-- Source: .claude/helpers/hook-handler.cjs lines 180-196 (session-end handler) -->
<!-- Source: .claude/helpers/auto-memory-hook.mjs (sync subcommand) -->

## What it injects
Two lifecycle events:
- **SessionEnd**: `hook-handler.cjs session-end` — consolidates the intelligence graph (PageRank recompute, new edges saved), then ends the session via `session.end()`.
- **Stop**: `auto-memory-hook.mjs sync` — exports current memory state to persistent storage so it is available on next session-restore.

## Key section in hook-handler.cjs (lines 180-196)
```js
'session-end': async () => {
  if (intelligence && intelligence.consolidate) {
    var consResult = await runWithTimeout(function() { return intelligence.consolidate(); }, 'intelligence.consolidate()');
    if (consResult && consResult.entries > 0) {
      var msg = '[INTELLIGENCE] Consolidated: ' + consResult.entries + ' entries, ' + consResult.edges + ' edges';
      if (consResult.newEntries > 0) msg += ', ' + consResult.newEntries + ' new';
      msg += ', PageRank recomputed';
      console.log(msg);
    }
  }
  if (session && session.end) {
    session.end();
  }
},
```

## settings.json hook definitions
```json
"SessionEnd": [{ "hooks": [{ "type":"command","command":"node \"$CLAUDE_PROJECT_DIR/.claude/helpers/hook-handler.cjs\" session-end","timeout":10000 }] }],
"Stop": [{ "hooks": [{ "type":"command","command":"node \"$CLAUDE_PROJECT_DIR/.claude/helpers/auto-memory-hook.mjs\" sync","timeout":10000 }] }]
```
