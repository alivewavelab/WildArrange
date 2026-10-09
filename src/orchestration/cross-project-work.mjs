// =============================================================================
// 文件名称：cross-project-work.mjs
// 所属模块：orchestration
// 作用说明：跨业务仓总任务只保存任务引用，汇总真实证据并绑定联合验收。
// 运行原理：导入不可变成员清单 → 从各仓读取当前事实 → 联合任务固定全部成员 SHA → 收据。
// =============================================================================
import { normalizeProjectTaskRef, projectTaskKey, inspectProjectTask } from '../infra/cross-project-evidence.mjs';
import { readJson, writeJsonAtomic, hashContent, nowIso, resolveWildArrangePath } from '../infra/runtime-store.mjs';
import { withTaskStateLock } from '../infra/task-state-lock.mjs';
import { appendLedger, readVerifiedLedgerEntries, verifyLedger } from '../infra/ledger.mjs';

/** 运行态文件名只接受单段 id。 */
function workPath(rootDir,id,receipt=false) {
 if(typeof id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id)) throw new Error('invalid cross-project work id');
 return resolveWildArrangePath(rootDir,'cross-project',`${id}${receipt?'.acceptance':''}.json`);
}

/** 总任务不复制成员状态，成员必须已经存在于各自项目账本。 */
export async function importCrossProjectWork(rootDir,file) {
 return withTaskStateLock(rootDir,'cross-project-import',async()=>{
  const input=await readJson(file);
  if(!input || typeof input.title!=='string' || !input.title.trim() || !Array.isArray(input.members) || input.members.length<2 || input.members.length>32) throw new Error('cross-project work requires title and 2..32 members');
  const members=input.members.map(ref=>normalizeProjectTaskRef(ref));
  if(new Set(members.map(projectTaskKey)).size!==members.length) throw new Error('duplicate cross-project member');
  if(new Set(members.map(ref=>ref.projectId)).size<2) throw new Error('cross-project work requires at least two projects');
  const acceptanceTask=normalizeProjectTaskRef(input.acceptanceTask);
  if(members.some(ref=>projectTaskKey(ref)===projectTaskKey(acceptanceTask))) throw new Error('joint acceptance task must be separate from implementation members');
  const manifest={kind:'cross_project_work',id:input.id,title:input.title.trim(),members,acceptanceTask};
  const target=workPath(rootDir,input.id), previous=await readJson(target,null);
  if(previous && JSON.stringify(previous)!==JSON.stringify(manifest)) throw new Error('cross-project manifest is immutable; import a new work id for changed scope');
  for(const ref of [...members,acceptanceTask]) {
   const report=await inspectProjectTask(rootDir,ref);
   if(!report.status) throw new Error(`cross-project task cannot be resolved: ${report.key}: ${report.issues.join('; ')}`);
  }
  const events=await readVerifiedLedgerEntries(rootDir);
  if(!previous || !events.some(event=>event.type==='cross_project_work_imported' && event.workId===input.id && event.manifestDigest===hashContent(JSON.stringify(manifest)))) {
   await appendLedger(rootDir,{type:'cross_project_work_imported',workId:input.id,manifestDigest:hashContent(JSON.stringify(manifest))});
   await writeJsonAtomic(target,manifest);
  }
  return {kind:'cross_project_import',id:input.id,path:target};
 });
}

/** 当前状态由原始成员证据推导；旧收据不能让已变更的版本继续显示通过。 */
export async function crossProjectWorkStatus(rootDir,id) {
 const manifest=await readJson(workPath(rootDir,id),null);
 if(!manifest || manifest.kind!=='cross_project_work' || manifest.id!==id) throw new Error(`cross-project work not found: ${id}`);
 if(!(await verifyLedger(rootDir)).ok) throw new Error('coordinator audit chain is invalid');
 const events=await readVerifiedLedgerEntries(rootDir), manifestDigest=hashContent(JSON.stringify(manifest));
 if(!events.some(event=>event.type==='cross_project_work_imported' && event.workId===id && event.manifestDigest===manifestDigest)) throw new Error('cross-project manifest does not match its audit record');
 const members=[];
 for(const ref of manifest.members) members.push(await inspectProjectTask(rootDir,ref));
 const acceptance=await inspectProjectTask(rootDir,manifest.acceptanceTask), issues=[];
 for(const member of members) {
  if(!member.pass) issues.push(`${member.key}: ${member.issues.join('; ')}`);
  const pin=acceptance.externalDependencies?.find(dep=>projectTaskKey(dep)===member.key);
  if(!member.deliverySha || pin?.deliverySha!==member.deliverySha) issues.push(`joint acceptance must pin current member delivery: ${member.key}`);
 }
 if(!acceptance.pass) issues.push(`joint acceptance: ${acceptance.issues.join('; ')}`);
 const binding={manifestDigest,members:members.map(member=>({ref:member.ref,deliverySha:member.deliverySha})),acceptanceTask:{ref:acceptance.ref,deliverySha:acceptance.deliverySha}};
 const digest=hashContent(JSON.stringify(binding)), receipt=await readJson(workPath(rootDir,id,true),null);
 const validReceipt=receipt?.digest===digest && events.some(event=>event.type==='cross_project_work_accepted' && event.workId===id && event.digest===digest);
 const status=issues.length ? (receipt?'stale':'blocked') : validReceipt?'accepted':'ready_for_acceptance';
 return {kind:'cross_project_status',id,title:manifest.title,status,pass:status==='accepted',ready:issues.length===0,issues,members,acceptance,binding,digest};
}

/** 只记录已真实通过的联合验收；不替代子任务批准、检查、PR 合并或发布。 */
export async function acceptCrossProjectWork(rootDir,id) {
 return withTaskStateLock(rootDir,'cross-project-accept',async()=>{
  const first=await crossProjectWorkStatus(rootDir,id);
  if(!first.ready) throw new Error(`cross-project acceptance blocked: ${first.issues.join('; ')}`);
  const current=await crossProjectWorkStatus(rootDir,id);
  if(!current.ready || current.digest!==first.digest) throw new Error('cross-project evidence changed during acceptance');
  const receipt={kind:'cross_project_acceptance',id,at:nowIso(),digest:current.digest,binding:current.binding};
  await appendLedger(rootDir,{type:'cross_project_work_accepted',workId:id,digest:current.digest});
  await writeJsonAtomic(workPath(rootDir,id,true),receipt);
  return {kind:'cross_project_acceptance',id,status:'accepted',receipt};
 });
}
