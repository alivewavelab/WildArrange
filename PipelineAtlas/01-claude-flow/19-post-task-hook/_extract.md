# Node: 19-post-task-hook
<!-- Source: .claude/settings.json (hooks.SubagentStop) -->
<!-- Source: .claude/helpers/hook-handler.cjs lines 210-217 (post-task handler) -->

## What it injects
On SubagentStop (when a spawned sub-agent finishes), `hook-handler.cjs post-task` calls `intelligence.feedback(true)` to record a successful task completion into the intelligence graph, strengthening the weights for the routing patterns that led to this outcome.

## Key section in hook-handler.cjs (lines 210-217)
```js
'post-task': () => {
  if (intelligence && intelligence.feedback) {
    try {
      intelligence.feedback(true);
    } catch (e) { /* non-fatal */ }
  }
  console.log('[OK] Task completed');
},
```

## settings.json hook definition
```json
"SubagentStop": [{ "hooks": [{ "type":"command","command":"node \"$CLAUDE_PROJECT_DIR/.claude/helpers/hook-handler.cjs\" post-task","timeout":5000 }] }]
```
