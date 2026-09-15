import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { buildPlanDraftDirective } from '../src/ai/routing.mjs';
import { preToolUseGuard } from '../src/ai/hooks.mjs';

test('task worktree plan imports use the control root and remain pre-plan-allowed', async () => {
  const controlRoot = path.join(os.tmpdir(), 'wildarrange-control-root');
  const executionRoot = path.join(controlRoot, 'task-worktree');
  const directive = buildPlanDraftDirective({ route: 'plan', needsPlan: true }, { sessionId: 'cross-root-plan', prompt: 'create governance validation file', controlRoot, executionRoot });
  assert.equal(directive.draftPath, path.join(controlRoot, '.wildarrange', 'plan-drafts', 'cross-root-plan-plan.json'));
  assert.match(directive.nextCommand, /--control-root/);
  const command = 'node ./bin/wildarrange.mjs plan --from "' + directive.draftPath + '" --control-root "' + controlRoot + '"';
  const guard = await preToolUseGuard(controlRoot, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, { executionRoot });
  assert.equal(guard.decision, 'allow');
  assert.equal(guard.code, 'no_file_target');
});