// Hook 只读操作的真实入口回归：无任务、待批准时读可用，写与命令执行仍需任务。
import assert from 'node:assert/strict';
import test from 'node:test';
import { preToolUseGuard } from '../src/ai/pre-tool-guard.mjs';
import { withExternalProject } from './helpers/external-fixture.mjs';
import { runInjectionHook } from './helpers/runtime-fixtures.mjs';

test('read-only discovery works without tasks and while feature confirmation is pending', async () => {
 await withExternalProject(async ({projectRoot}) => {
  const commands = [
   'rg --files docs', 'rg -n "SDK|Hook" docs README.md',
   'Get-Content -LiteralPath "D:\\Development\\notes.md" -Raw',
   'Get-ChildItem -LiteralPath docs -File | Select-Object -First 20',
   'rg -n "SDK" docs | Select-Object -First 10',
   'cat README.md\nrg --files docs',
   'git --no-pager log --oneline -5',
   'git --no-pager show --no-ext-diff --no-textconv HEAD:README.md',
   // 模型常用的只读写法：Agent 的 shell 不是 TTY，不会启动分页器
   'git log --oneline -5','git show HEAD --stat','git diff HEAD~1 --stat','git diff','git branch -a',
   'sed -n 1,80p README.md',"sed -n '10,$p' README.md",'find docs -name "*.md" -type f','wc -l README.md',
   'ls -la docs 2>/dev/null','cat README.md | wc -l','rg -n x docs 2>&1 | head -20',
  ];
  for(const pending of [false,true]) {
   if(pending) await runInjectionHook(projectRoot,{hook_event_name:'UserPromptSubmit',session_id:'readonly-design',cwd:projectRoot,prompt:'做一个网页版 TODO 工具，支持删除任务'});
   for(const cmd of commands) {
    const r=await preToolUseGuard(projectRoot,{hook_event_name:'PreToolUse',session_id:'readonly-design',tool_name:'functions.exec_command',tool_input:{cmd}});
    assert.equal(r.decision,'allow',`${pending}: ${cmd}: ${r.code}`);
   }
   for(const tool_name of ['Read','Glob','Grep','functions.read_file']) {
    const r=await preToolUseGuard(projectRoot,{hook_event_name:'PreToolUse',session_id:'readonly-design',tool_name,tool_input:{path:'docs/unowned.md'}});
    assert.equal(r.decision,'allow',`${pending}: ${tool_name}: ${r.code}`);
   }
  }
 });
});

test('read-only classification does not admit execution flags, redirection or mixed writes',async()=>{
 await withExternalProject(async({projectRoot})=>{
  for(const cmd of [
   'rg --pre node pattern docs','rg --pre=node pattern docs','rg -n x . > saved.txt',
   'Get-Content README.md; Set-Content README.md bad','cat README.md | sh',
   'rg x . | ForEach-Object { Remove-Item $_ }','Get-Content "$(node evil.js)"',
   'git --no-pager show --ext-diff HEAD','git -c core.pager=evil log',
   'node -e "require(\'fs\').readFileSync(\'README.md\')"',
   'rg x . && npm install','find . -exec node evil.js ;','sed -i s/a/b/ README.md',
   // 反斜杠在 shell 中会被去掉，伪装成普通词的选项必须拒绝
   'rg x \\-\\-pre=./evil.sh .','rg x \\-\\-pre ./evil.sh .','git log \\-\\-output=src/app.js -1',
   'git show HEAD \\-\\-ext-diff',
   // 其他仓库的 git 配置可执行程序（core.fsmonitor / diff.external），不允许切换仓库
   'git -C ../vendor status','git --git-dir=../vendor/.git status','git --work-tree=../vendor status',
   // 能写文件或执行命令的写法
   'git branch evil','git log --output=x','git diff --ext-diff',"sed -n '1w out' README.md","sed -n '1e touch x' README.md",
   'sed -n 1p -i README.md','find . -delete','find . -fprint out','wc -l README.md > out','ls 2>/tmp/out',
  ]) {
   const r=await preToolUseGuard(projectRoot,{hook_event_name:'PreToolUse',tool_name:'functions.exec_command',tool_input:{cmd}});
   assert.equal(r.decision,'deny',cmd);
  }
  const r=await preToolUseGuard(projectRoot,{hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{path:'README.md',content:'bad'}});
  assert.equal(r.decision,'deny');
 });
});

// 总任务管理只写外置引用/收据；没有业务工单时也必须能开始与收尾。
test('cross-project management and project inspection remain reachable without active tasks',async()=>{
 await withExternalProject(async({projectRoot})=>{
  for(const command of ['project show','prompts list','config verify','ledger verify','state verify','cross-project status --id paired','cross-project import --from work.json','cross-project accept --id paired']) {
   const r=await preToolUseGuard(projectRoot,{hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'node ./bin/wildarrange.mjs '+command}});
   assert.equal(r.decision,'allow',command);
  }
  const r=await preToolUseGuard(projectRoot,{hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'node ./bin/wildarrange.mjs cross-project accept --id paired; node evil.js'}});
  assert.equal(r.decision,'deny');
 });
});
