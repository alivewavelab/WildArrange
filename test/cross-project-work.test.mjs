// 跨业务仓真实流水线回归：独立仓库/治理仓、上游交付、下游依赖、联合验收与过期证据。
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {runCommandFile} from '../src/infra/command-runner.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {withExternalProject,importApprovedPlan} from './helpers/external-fixture.mjs';
import {createSmokePlan} from './helpers/runtime-fixtures.mjs';
import {attachGovernanceRepository,getBoundWorkspaceContext} from '../src/infra/workspace-context.mjs';
import {initRuntime} from '../src/infra/runtime-bootstrap.mjs';
import {readJson,writeJsonAtomic,resolveWildArrangePath,resolveTaskCheckpointPath,resolveTaskAcceptancePath} from '../src/infra/runtime-store.mjs';
import {loadTaskLedger,loadTaskState} from '../src/infra/task-state-store.mjs';
import {normalizeExternalDependencies,inspectProjectTask,inspectExternalDependencies} from '../src/infra/cross-project-evidence.mjs';
import {runNextTask} from '../src/orchestration/linear-runtime.mjs';
import {approvePlan} from '../src/orchestration/plan-state.mjs';
import {importCrossProjectWork,crossProjectWorkStatus,acceptCrossProjectWork} from '../src/orchestration/cross-project-work.mjs';

async function plan(project,id,deps=[]) {
 const file=await createSmokePlan(project.root), raw=JSON.parse(await readFile(file,'utf8'));
 raw.id=id; raw.tasks[0].externalDependencies=deps;
 if(id==='joint-check') {
  const registry=await readJson(getBoundWorkspaceContext(project.projectRoot).registryPath);
  const inputs=deps.map(ref=>({root:registry.projects[ref.projectId].projectRoot,sha:ref.deliverySha}));
  const script=path.join(project.root,'joint-verify.cjs');
  await writeFile(script,`const {execFileSync}=require('node:child_process');const assert=require('node:assert/strict');for(const input of ${JSON.stringify(inputs)})assert.equal(execFileSync('git',['show',input.sha+':artifacts/linear-smoke.txt'],{cwd:input.root,encoding:'utf8'}).trim(),'ok');`);
  const command=`node "${script}"`;
  Object.assign(raw.tasks[0],{writable_paths:[],responsibilityChanges:[],worker_command:command,verify_commands:[command],review_commands:[command]});
 }
 await writeFile(file,JSON.stringify(raw));
 await importApprovedPlan(project.projectRoot,file);
 return file;
}
async function complete(project) {
 const result=await runNextTask(project.projectRoot);
 const task=(await loadTaskState(project.projectRoot)).tasks[0];
 assert.equal(task.status,'completed',JSON.stringify(result));
 const ref={projectId:getBoundWorkspaceContext(project.projectRoot).projectId,planId:task.planId,taskId:task.id};
 const report=await inspectProjectTask(project.projectRoot,ref);
 assert.equal(report.pass,true,JSON.stringify(report));
 return {...ref,deliverySha:report.deliverySha};
}

test('cross-project references require stable identities and full SHAs',()=>{
 assert.throws(()=>normalizeExternalDependencies([{projectId:'../bad',planId:'p',taskId:'t',deliverySha:'a'.repeat(40)}]),/projectId/);
 assert.throws(()=>normalizeExternalDependencies([{projectId:'sdk',planId:'p',taskId:'t',deliverySha:'main'}]),/deliverySha/);
 const ref={projectId:'sdk',planId:'p',taskId:'t',deliverySha:'a'.repeat(40)};
 assert.throws(()=>normalizeExternalDependencies([ref,ref]),/duplicate/);
});

test('real two-project deliveries, joint acceptance and changed evidence cannot reuse a receipt',async()=>{
 await withExternalProject(async(client)=>{
  await withExternalProject(async(sdk)=>{
   process.env.WILDARRANGE_STATE_HOME=client.stateHome;
   await attachGovernanceRepository(sdk.projectRoot,{governanceRoot:sdk.governanceRoot,stateHome:client.stateHome});
   await initRuntime(sdk.projectRoot);
   await plan(sdk,'sdk-change');
   const sdkRef=await complete(sdk);
   await plan(client,'client-change',[sdkRef]);
   const clientRef=await complete(client);
   await plan(client,'joint-check',[sdkRef,clientRef]);
   const jointTask=(await loadTaskState(client.projectRoot)).tasks[0];
   const jointRef={projectId:clientRef.projectId,planId:'joint-check',taskId:jointTask.id};
   const manifest={id:'paired-delivery',title:'SDK and client joint acceptance',members:[sdkRef,clientRef],acceptanceTask:jointRef};
   const file=path.join(client.root,'cross-work.json');await writeFile(file,JSON.stringify(manifest));
   await importCrossProjectWork(client.projectRoot,file);
   assert.equal((await crossProjectWorkStatus(client.projectRoot,manifest.id)).status,'blocked');
   await assert.rejects(()=>acceptCrossProjectWork(client.projectRoot,manifest.id),/blocked/);
   await complete(client);
   assert.equal((await crossProjectWorkStatus(client.projectRoot,manifest.id)).status,'ready_for_acceptance');
   await acceptCrossProjectWork(client.projectRoot,manifest.id);
   assert.equal((await crossProjectWorkStatus(client.projectRoot,manifest.id)).status,'accepted');
   const cli=await runCommandFile(process.execPath,[fileURLToPath(new URL('../bin/wildarrange.mjs',import.meta.url)),'cross-project','status','--id',manifest.id],client.projectRoot);
   assert.equal(cli.exitCode,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).status,'accepted');
   assert.equal((await inspectProjectTask(client.projectRoot,{...sdkRef,projectId:'unknown-project'})).pass,false);
   const sdkLedger=await loadTaskLedger(sdk.projectRoot), original=structuredClone(sdkLedger);
   sdkLedger.tasks[0].status='pending';
   await writeJsonAtomic(resolveWildArrangePath(sdk.projectRoot,'team','tasks.json'),sdkLedger);
   assert.equal((await crossProjectWorkStatus(client.projectRoot,manifest.id)).status,'stale');
   await assert.rejects(()=>acceptCrossProjectWork(client.projectRoot,manifest.id),/blocked/);
   await writeJsonAtomic(resolveWildArrangePath(sdk.projectRoot,'team','tasks.json'),original);
   const proofPath=resolveTaskAcceptancePath(sdk.projectRoot,sdkRef.planId,sdkRef.taskId,'json');
   const proof=await readJson(proofPath), originalProof=structuredClone(proof);proof.pass=false;await writeJsonAtomic(proofPath,proof);
   assert.equal((await inspectProjectTask(client.projectRoot,sdkRef)).pass,false);
   await writeJsonAtomic(proofPath,originalProof);
   const changed={...sdkRef,deliverySha:'0'.repeat(40)};
   assert.equal((await inspectProjectTask(client.projectRoot,changed)).pass,false);
   const clientLedger=await loadTaskLedger(client.projectRoot);
   const joint=clientLedger.tasks.find(t=>t.planId==='joint-check');joint.externalDependencies=[];
   await writeJsonAtomic(resolveWildArrangePath(client.projectRoot,'team','tasks.json'),clientLedger);
   assert.equal((await inspectExternalDependencies(client.projectRoot,joint)).pass,false,'removing approved dependencies cannot bypass checks');
   await approvePlan(client.projectRoot);
   assert.equal((await inspectProjectTask(client.projectRoot,jointRef)).pass,false,'reapproval alone cannot reuse an old acceptance proof');
   await plan(client,'blocked-client',[changed]);
   const blocked=await runNextTask(client.projectRoot);
   assert.equal(blocked.status,'readiness_blocked');
   assert.equal((await loadTaskState(client.projectRoot)).tasks[0].status,'pending');
   assert.equal(await readJson(resolveTaskCheckpointPath(client.projectRoot,'blocked-client','T001','json'),null),null);
   const midFile=await createSmokePlan(client.root), mid=JSON.parse(await readFile(midFile,'utf8'));
   mid.id='midflight-change';mid.tasks[0].externalDependencies=[sdkRef];
   const mutationScript=path.join(client.root,'change-upstream.cjs');
   await writeFile(mutationScript,`const fs=require('node:fs');fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/linear-smoke.txt','ok');const p=${JSON.stringify(resolveWildArrangePath(sdk.projectRoot,'team','tasks.json'))};const s=JSON.parse(fs.readFileSync(p,'utf8'));s.tasks[0].status='pending';fs.writeFileSync(p,JSON.stringify(s));`);
   mid.tasks[0].worker_command=`node "${mutationScript}"`;await writeFile(midFile,JSON.stringify(mid));await importApprovedPlan(client.projectRoot,midFile);
   await runNextTask(client.projectRoot);
   assert.notEqual((await loadTaskState(client.projectRoot)).tasks[0].status,'completed');
   assert.equal(await readJson(resolveTaskCheckpointPath(client.projectRoot,mid.id,'T001','json'),null),null);
   const failedProof=await readJson(resolveTaskAcceptancePath(client.projectRoot,mid.id,'T001','json'),null);
   assert.equal(failedProof?.evidenceRefs.verifier.pass,true);
   assert.equal(failedProof?.evidenceRefs.scope.status,'pass');
   assert.equal(failedProof?.checks.find(check=>check.name==='external_dependencies')?.status,'fail');
  });
 });
});
