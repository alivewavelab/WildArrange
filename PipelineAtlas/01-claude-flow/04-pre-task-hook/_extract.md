# Node: 04-pre-task-hook
<!-- Source: .claude/settings.json (hooks.PreToolUse matcher:"Bash") -->
<!-- Source: .claude/helpers/hook-handler.cjs lines 133-146 (pre-bash handler) and lines 198-207 (pre-task handler) -->

## What it injects
**PreToolUse (Bash)**: Before every Bash command runs, `hook-handler.cjs pre-bash` checks the command string against a hardcoded blocklist of dangerous patterns (rm -rf /, format c:, fork bomb, etc.) and exits 1 to block if matched, or logs `[OK] Command validated`.

There is also a separate `pre-task` handler (invoked via SubagentStop → post-task flow) that routes the task prompt and increments the session task counter.

## Key sections in hook-handler.cjs
### pre-bash (lines 133-146)
```js
'pre-bash': () => {
  var cmd = String(hookInput.command || toolInput.command || prompt || '').toLowerCase();
  var dangerous = ['rm -rf /', 'format c:', 'del /s /q c:\\', ':(){:|:&};:'];
  for (var i = 0; i < dangerous.length; i++) {
    if (cmd.includes(dangerous[i])) {
      console.error('[BLOCKED] Dangerous command detected: ' + dangerous[i]);
      process.exit(1);
    }
  }
  console.log('[OK] Command validated');
},
```

### pre-task (lines 198-207)
```js
'pre-task': () => {
  if (session && session.metric) {
    try { session.metric('tasks'); } catch (e) {}
  }
  if (router && router.routeTask && prompt) {
    var result = router.routeTask(prompt);
    console.log('[INFO] Task routed to: ' + result.agent + ' (confidence: ' + result.confidence + ')');
  }
},
```

## settings.json hook definition
```json
"PreToolUse": [{ "matcher":"Bash","hooks":[{ "type":"command","command":"node \"$CLAUDE_PROJECT_DIR/.claude/helpers/hook-handler.cjs\" pre-bash","timeout":5000 }] }]
```
