# Node: 02-route-hook
<!-- Source: .claude/settings.json (hooks.UserPromptSubmit) -->
<!-- Source: .claude/helpers/hook-handler.cjs lines 110-131 (route handler) -->
<!-- Source: .claude/helpers/router.cjs (routeTask logic) -->

## What it injects
On every UserPromptSubmit, `hook-handler.cjs route` fires before Claude processes the prompt. It calls `router.routeTask(prompt)` to pattern-match the incoming prompt against known agent types (orchestrator, coder, architect, etc.) and injects a routing recommendation box into the context showing the best agent, confidence %, and reason.

## Key section in hook-handler.cjs (lines 110-131)
```js
'route': () => {
  if (intelligence && intelligence.getContext) {
    try {
      const ctx = intelligence.getContext(prompt);
      if (ctx) console.log(ctx);
    } catch (e) { /* non-fatal */ }
  }
  if (router && router.routeTask) {
    const result = router.routeTask(prompt);
    var output = [];
    output.push('[INFO] Routing task: ' + (prompt.substring(0, 80) || '(no prompt)'));
    output.push('+------------------- Primary Recommendation -------------------+');
    output.push('| Agent: ' + result.agent.padEnd(53) + '|');
    output.push('| Confidence: ' + (result.confidence * 100).toFixed(1) + '%' + ' '.repeat(44) + '|');
    output.push('| Reason: ' + result.reason.substring(0, 53).padEnd(53) + '|');
    output.push('+--------------------------------------------------------------+');
    console.log(output.join('\n'));
  }
},
```

## settings.json hook definition
```json
"UserPromptSubmit": [
  {
    "hooks": [
      { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/helpers/hook-handler.cjs\" route", "timeout": 10000 }
    ]
  }
]
```
