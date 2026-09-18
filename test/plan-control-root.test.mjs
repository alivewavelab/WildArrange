// =============================================================================
// 文件名称：plan-control-root.test.mjs
// 所属模块：test
// 作用说明：
//   验证 task worktree 计划 import 使用 control root 且仍属 pre-plan 允许；
//   带 foreign control root 的 shell 命令被拒绝。
//   不测：完整 linear delivery 或 parallel agent 批次。
//
// 【运行原理速读】
//   创建 worktree 会话，importPlan 与 preToolUseGuard shell 命令，
//   断言路径解析到安装 control root 且 foreign root deny。
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { buildPlanDraftDirective } from '../src/ai/routing.mjs';
import { preToolUseGuard } from '../src/ai/pre-tool-guard.mjs';

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

test('pre-plan shell commands with a foreign control root are denied', async () => {
  const controlRoot = path.join(os.tmpdir(), 'wildarrange-control-root');
  const executionRoot = path.join(controlRoot, 'task-worktree');
  const foreignRoot = path.join(os.tmpdir(), 'wildarrange-foreign-root');
  const draftPath = path.join(controlRoot, '.wildarrange', 'plan-drafts', 'cross-root-plan-plan.json');
  const command = 'node ./bin/wildarrange.mjs plan --from "' + draftPath + '" --control-root "' + foreignRoot + '"';
  const guard = await preToolUseGuard(controlRoot, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, { executionRoot });
  assert.equal(guard.decision, 'deny');
  assert.equal(guard.code, 'no_active_task_shell');
});