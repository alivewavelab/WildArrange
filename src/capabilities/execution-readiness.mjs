// =============================================================================
// 文件名称：execution-readiness.mjs
// 所属模块：capabilities
// 作用说明：
//   在 worker 启动前校验必需 Skill、项目审查依据与 adapter 握手探针，
//   生成 execution context 与 readiness 报告。legacy 任务可跳过。
//
// 【运行原理速读】
//   · 何时执行？任务声明 responsibilityChanges 或必需 review step 时。
//   · 做了什么？加载 Skill → prepareProjectReview → 写 context → 探针握手。
//   · 缺了它会怎样？无 Skill/审查依据的任务可能带着错误上下文开工。
// =============================================================================

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { hashContent, nowIso, resolveTaskPacketPath, resolveTaskReportPath, writeJsonAtomic } from "../infra/runtime-store.mjs";
import { loadSkillAttachment } from "../infra/context-attachments.mjs";
import { isTrivialCommand } from "../infra/task-predicates.mjs";
import { runCommand } from "../infra/command-runner.mjs";
import { compileCommandSafetyPatterns } from "../infra/command-safety.mjs";
import { prepareProjectReview, executeReviewPacket, selectProjectReviewSteps } from "./project-review.mjs";

/**
 * 执行开工就绪检查：Skill、审查附件、adapter 探针与 context 预算。
 * @param {string} rootDir 项目根目录
 * @param {object} task 任务对象
 * @param {object} [options] workerCommand 覆盖
 * @returns {Promise<object>} kind=execution_readiness，status 为 ready|blocked|recovery_required
 */
export async function checkExecutionReadiness(rootDir, task, options = {}) {
  const { config } = await loadWildArrangeConfig(rootDir);
  const required = Boolean(task.responsibilityChanges) || selectProjectReviewSteps(config, task).some(step => step.required);
  const result = { kind: "execution_readiness", at: nowIso(), taskId: task.id, planId: task.planId, required,
    pass: !required, issues: [], skills: [], probes: [] };
  if (!required) return { ...result, status: "legacy_not_checked" };
  const budget = config.review?.responsibility?.maxEvidenceChars || 500000;
  const command = options.workerCommand ?? task.worker_command;
  if (!command || isTrivialCommand(command)) result.issues.push("configure a real worker_command before starting a worker");
  const names = [...new Set([...(task.skills || []), ...(config.agents?.[task.owner]?.skills || [])])];
  if (names.length > 20) result.issues.push("required task Skills exceed 20; split the task or narrow the required Skills");
  for (const name of names) {
    try {
      const skill = await loadSkillAttachment(rootDir, name, budget);
      if (!skill || skill.truncated) throw new Error(`missing or truncated required Skill: ${name}`);
      result.skills.push(skill);
    } catch (error) { result.issues.push(error.message); }
  }
  let review;
  try {
    review = await prepareProjectReview(rootDir, task, config);
    for (const step of review.steps.filter(step => step.required)) result.issues.push(...step.issues.map(issue => `${step.id}: ${issue}`));
    if (task.responsibilityChanges) {
      const reviewSkill = await loadSkillAttachment(rootDir, "review-work", budget);
      if (!reviewSkill || reviewSkill.truncated) result.issues.push("required responsibility review Skill is unavailable");
      review.responsibilitySkill = reviewSkill;
    }
  } catch (error) { result.issues.push(error.message); }
  const settings = config.executionReadiness || {};
  if (!settings.workerProbe?.trim()) result.issues.push("executionReadiness.workerProbe is required; configure the worker adapter handshake");
  const researchNames = names.filter(name => name.startsWith("research-") || (settings.researchSkills || []).includes(name));
  if (researchNames.length && !settings.researchProbe?.trim()) result.issues.push("executionReadiness.researchProbe is required for this task's research Skills");
  const contextPath = resolveTaskReportPath(rootDir, "readiness", task.planId, task.id, "json") + ".context.json";
  const context = { kind: "worker_execution_context", task, skills: result.skills, reviewRequirements: review || null,
    taskPacketPath: resolveTaskPacketPath(rootDir, task.planId, task.id),
    documentGuidance: "Long-term project documentation states current behavior, architecture and limitations. Keep attempt logs, command output, research chronology and unlanded proposals in task evidence or an approved research artifact. Do not duplicate a current business fact in multiple documents. The task packet is navigation and historical evidence, not an extra writable path or live task ledger." };
  if (JSON.stringify(context).length > budget) result.issues.push("required execution context exceeds budget");
  if (!result.issues.length) {
    await writeJsonAtomic(contextPath, context);
    result.contextPath = contextPath;
    result.contextDigest = hashContent(JSON.stringify(context));
    const probes = [{ id: "worker", command: settings.workerProbe, skills: result.skills }];
    if (researchNames.length) probes.push({ id: "research", command: settings.researchProbe, skills: result.skills.filter(skill => researchNames.includes(skill.name)) });
    if (task.responsibilityChanges) probes.push({ id: "responsibility", reviewer: true, command: config.review?.responsibility?.command, skills: [review.responsibilitySkill] });
    for (const step of review.steps.filter(step => step.required)) probes.push({ id: `review-${step.id}`, reviewer: true, command: step.command, skills: step.skills, documents: step.documents });
    for (const probe of probes) {
      const challenge = randomUUID();
      const packet = { kind: "execution_readiness_probe", role: probe.id, challenge, workerCommand: command,
        contextDigest: result.contextDigest, requiredSkills: probe.skills, documents: probe.documents || [],
        instruction: 'Read the attached required Skills. Confirm your execution service is available without editing project files. Return only JSON {ready:true,challenge:the supplied challenge,loadedSkills:[every required Skill name]}. Do not execute workerCommand.' };
      try {
        let response;
        const packetPath = contextPath + `.${probe.id}.probe.json`;
        if (probe.reviewer) response = await executeReviewPacket(rootDir, packetPath, packet, config, { ...config.review?.responsibility, command: probe.command });
        else {
          await writeJsonAtomic(packetPath, packet);
          const raw = await runCommand(probe.command, rootDir, settings.timeoutMs || 30000, {
            extraPatterns: compileCommandSafetyPatterns(config), env: { WILDARRANGE_READINESS_PACKET: packetPath, WILDARRANGE_EXECUTION_CONTEXT: contextPath },
          });
          if (raw.recoveryRequired || raw.terminationFailed) response = { commandRecovery: raw };
          else if (raw.exitCode !== 0 || raw.outputTruncated?.stdout) throw new Error("adapter handshake command failed or output was truncated");
          else response = { content: raw.stdout };
        }
        if (response.commandRecovery) { result.commandRecovery = response.commandRecovery; throw new Error("handshake process requires recovery"); }
        const answer = JSON.parse(response.content);
        if (answer.ready !== true || answer.challenge !== challenge || !Array.isArray(answer.loadedSkills) || probe.skills.some(skill => !answer.loadedSkills.includes(skill.name))) throw new Error("adapter did not acknowledge current handshake and every required Skill");
        result.probes.push({ role: probe.id, pass: true });
      } catch (error) {
        result.issues.push(`${probe.id}: ${error.message}`);
        result.probes.push({ role: probe.id, pass: false, reason: error.message });
        if (result.commandRecovery) break;
      }
    }
  }
  result.pass = result.issues.length === 0;
  result.status = result.commandRecovery ? "recovery_required" : result.pass ? "ready" : "blocked";
  result.reportJsonPath = resolveTaskReportPath(rootDir, "readiness", task.planId, task.id, "json");
  await writeJsonAtomic(result.reportJsonPath, result);
  await writeFile(resolveTaskReportPath(rootDir, "readiness", task.planId, task.id, "md"),
    `# 开工检查 ${task.id}\n\n状态：${result.status}\n\n${result.issues.map(issue => `- ${issue}`).join("\n") || "本任务必需的能力、Skill 和审查依据已通过检查。"}\n`, "utf8");
  return result;
}
