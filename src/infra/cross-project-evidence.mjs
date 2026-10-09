// =============================================================================
// 文件名称：cross-project-evidence.mjs
// 所属模块：infra
// 作用说明：解析已登记项目的任务引用，核验原账本/验收链和固定交付版本；不推进任务。
// 运行原理：registry 身份 → 唯一 task ledger → 完成证据 → Git commit → 递归依赖。
// =============================================================================
import path from 'node:path';
import { getBoundWorkspaceContext, resolveWorkspaceContext, resolveTaskRepositoryRoot } from './workspace-context.mjs';
import { readJson, hashContent, resolveTaskAcceptancePath } from './runtime-store.mjs';
import { loadTaskLedger, inspectCompletedTaskEvidence } from './task-state-store.mjs';
import { readVerifiedLedgerEntries, verifyLedger } from './ledger.mjs';
import { runCommandFile } from './command-runner.mjs';

/** 跨项目引用只用稳定身份，不接受调用方指定运行态路径。 */
export function normalizeProjectTaskRef(value, requireSha = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('project task reference must be an object');
  const ref = {};
  for(const key of ['projectId','planId','taskId']) {
    if(typeof value[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value[key])) throw new Error(`invalid project task reference ${key}`);
    ref[key]=value[key];
  }
  if(requireSha || value.deliverySha !== undefined) {
    if(typeof value.deliverySha !== 'string' || !/^[0-9a-f]{40}$/i.test(value.deliverySha)) throw new Error('external dependency requires a full deliverySha');
    ref.deliverySha=value.deliverySha.toLowerCase();
  }
  return ref;
}

/** 外部依赖不能重复，不接受 silently ignored 字段形态。 */
export function normalizeExternalDependencies(value = []) {
  if(!Array.isArray(value) || value.length>32) throw new Error('externalDependencies must be an array of at most 32 references');
  const refs=value.map(ref=>normalizeProjectTaskRef(ref,true));
  if(new Set(refs.map(projectTaskKey)).size!==refs.length) throw new Error('duplicate external dependency');
  return refs;
}

/** 不含版本的稳定任务引用键。 */
export function projectTaskKey(ref) { return `${ref.projectId}/${ref.planId}/${ref.taskId}`; }

/** 审批指纹只覆盖规范化引用，顺序不改变语义。 */
export function externalDependenciesDigest(task) {
  return hashContent(JSON.stringify(normalizeExternalDependencies(task.externalDependencies).sort((a,b)=>projectTaskKey(a).localeCompare(projectTaskKey(b)))));
}

/** 从调用项目的 registry 解析目标，禁止靠传入路径读取任意伪造账本。 */
async function referencedWorkspace(rootDir, projectId) {
  const origin=getBoundWorkspaceContext(rootDir);
  if(!origin) throw new Error('cross-project references require an attached workspace');
  const registry=await readJson(origin.registryPath);
  const entry=registry?.projects?.[projectId];
  if(!entry) throw new Error(`project is not registered: ${projectId}`);
  const context=await resolveWorkspaceContext(entry.projectRoot,{stateHome:path.dirname(origin.registryPath)});
  if(!context || context.projectId!==projectId) throw new Error(`project identity mismatch: ${projectId}`);
  return context;
}

/** 单个引用的当前事实；完成状态必须同时有验收、checkpoint、审计和真实 Git 提交。 */
export async function inspectProjectTask(rootDir, value, visited = new Set()) {
  const ref=normalizeProjectTaskRef(value), key=projectTaskKey(ref), issues=[];
  if(visited.has(key) || visited.size>=64) return {ref,key,pass:false,issues:['cross-project dependency cycle or excessive depth']};
  const seen=new Set(visited).add(key);
  try {
    const context=await referencedWorkspace(rootDir,ref.projectId);
    if(!(await verifyLedger(context.projectRoot)).ok) throw new Error('upstream audit chain is invalid');
    const ledger=await loadTaskLedger(context.projectRoot);
    const task=ledger?.tasks?.find(t=>t.planId===ref.planId && t.id===ref.taskId);
    if(!task) throw new Error(`task not found: ${key}`);
    const delivery=task.delivery || task.delivery_workspace;
    const sha=(delivery?.commitSha || delivery?.deliverySha || delivery?.integrationSha || delivery?.actualSha || '').toLowerCase();
    if(task.status!=='completed') issues.push(`task is ${task.status}, not completed`);
    const integrity=await inspectCompletedTaskEvidence(context.projectRoot,{planId:ref.planId,tasks:[task]},{gitProject:true});
    if(integrity.invalid.length) issues.push(...integrity.invalid.flatMap(item=>item.failures));
    if(!/^[0-9a-f]{40}$/.test(sha)) issues.push('delivery SHA is missing');
    else {
      if(ref.deliverySha && sha!==ref.deliverySha) issues.push('delivery SHA changed');
      const commit=await runCommandFile('git',['cat-file','-e',`${sha}^{commit}`],resolveTaskRepositoryRoot(context.projectRoot,task),30000);
      if(commit.exitCode!==0) issues.push('delivery commit is unavailable');
    }
    if(task.status==='completed') {
      const proof=await readJson(resolveTaskAcceptancePath(context.projectRoot,ref.planId,ref.taskId,'json'),null);
      const recorded=proof?.evidenceRefs?.externalDependencies;
      if(((task.externalDependencies || []).length || recorded) && (recorded?.pass!==true || recorded.digest!==externalDependenciesDigest(task))) issues.push('acceptance dependency binding changed');
    }
    const dependencies=await inspectExternalDependencies(context.projectRoot,task,{visited:seen});
    if(!dependencies.pass) issues.push(...dependencies.issues);
    return {ref,key,pass:issues.length===0,status:task.status,deliverySha:sha || null,externalDependencies:normalizeExternalDependencies(task.externalDependencies),issues};
  } catch(error) { return {ref,key,pass:false,issues:[error.message]}; }
}

/** 开工和验收共用事实检查；依赖声明必须等于该任务已批准的快照。 */
export async function inspectExternalDependencies(rootDir, task, options = {}) {
  const refs=normalizeExternalDependencies(task.externalDependencies), reports=[], issues=[];
  const events=await readVerifiedLedgerEntries(rootDir);
  const approval=events.filter(event=>event.type==='plan_approved' && event.planId===task.planId).at(-1);
  if((refs.length || approval?.externalDependencyScopes?.[task.id]) && approval?.externalDependencyScopes?.[task.id]!==externalDependenciesDigest(task)) issues.push('external dependencies have no matching plan approval');
  const context=getBoundWorkspaceContext(rootDir);
  const visited=options.visited || new Set([projectTaskKey({projectId:context?.projectId,planId:task.planId,taskId:task.id})]);
  for(const ref of refs) {
    const report=await inspectProjectTask(rootDir,ref,visited); reports.push(report);
    if(!report.pass) issues.push(`${report.key}: ${report.issues.join('; ')}`);
  }
  return {pass:issues.length===0,issues,reports,digest:externalDependenciesDigest(task)};
}
