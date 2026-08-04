/**
 * Gate arming floor ("门未武装" 黄灯).
 *
 * Default configs leave the review gate tautological and every quality gate
 * off, which would produce a stable stream of green lights worth nothing.
 * This module evaluates whether the gates are actually armed, so status can
 * show a persistent yellow lamp instead of green until they are. It is a
 * pure evaluation: it never writes config and never flips a gate by itself.
 */
import { isTrivialCommand } from "./task-predicates.mjs";

const ACTIVE_TASK_STATUSES = new Set(["pending", "in_progress", "verifying", "failed", "review_blocked"]);

export function evaluateGateArming({ config, tasks = [] } = {}) {
  const issues = [];
  const activeTasks = (tasks || []).filter((task) => ACTIVE_TASK_STATUSES.has(task?.status));

  for (const task of activeTasks) {
    const verifyCommands = Array.isArray(task.verify_commands) ? task.verify_commands : [];
    if (verifyCommands.length === 0) {
      issues.push({
        code: "verify_missing",
        taskId: task.id,
        message: `任务 ${task.id} 没有 verify_commands，验证门形同虚设`,
        next_action: "为该任务补充至少一条真实验证命令",
      });
    } else if (verifyCommands.every(isTrivialCommand)) {
      issues.push({
        code: "verify_trivial",
        taskId: task.id,
        message: `任务 ${task.id} 的 verify_commands 全是 trivial 命令（如 true），验证不证明任何东西`,
        next_action: "把 verify_commands 换成覆盖真实行为的命令",
      });
    }
  }

  const reviewScope = activeTasks.length > 0 ? activeTasks : [];
  const tasksWithoutRealReview = reviewScope.filter((task) => !hasRealReviewLane(task, config));
  if (tasksWithoutRealReview.length > 0) {
    issues.push({
      code: "review_tautology",
      taskIds: tasksWithoutRealReview.map((task) => task.id),
      message: "review 门没有独立信号 lane（无 review_commands / standards_commands / LLM review / 已启用质量门），复核是同义反复",
      next_action: "为任务配置 review_commands 或 standards_commands，或启用 review.llm / 质量门",
    });
  }

  if (!hasRequiredQualityGate(config)) {
    issues.push({
      code: "quality_gates_not_required",
      message: "qualityGates 没有任何一项 required（含 commentChecker.blockOnFindings），质量门全关",
      next_action: "在 helix.config.json 中至少把一项质量门设为 required（如 lspDiagnostics 或 commentChecker.blockOnFindings）",
    });
  }

  return { armed: issues.length === 0, issues };
}

export function hasRealReviewLane(task, config) {
  if ((task?.review_commands || []).length > 0) return true;
  if ((task?.standards_commands || []).length > 0) return true;
  if (config?.review?.llm?.enabled === true) return true;
  return hasEnabledQualityGate(config);
}

function hasEnabledQualityGate(config) {
  const gates = config?.qualityGates || {};
  if (gates.lspDiagnostics?.enabled === true && (gates.lspDiagnostics.commands || []).length > 0) return true;
  if (gates.astStructure?.enabled === true && (gates.astStructure.commands || []).length > 0) return true;
  if (gates.hashlineAnchors?.enabled === true && (gates.hashlineAnchors.anchors || []).length > 0) return true;
  // commentChecker 只有 blockOnFindings 时才构成独立信号；否则它只是 warn。
  if (gates.commentChecker?.enabled === true && gates.commentChecker?.blockOnFindings === true) return true;
  return false;
}

function hasRequiredQualityGate(config) {
  const gates = config?.qualityGates || {};
  if (gates.lspDiagnostics?.enabled === true && gates.lspDiagnostics?.required === true) return true;
  if (gates.astStructure?.enabled === true && gates.astStructure?.required === true) return true;
  if (gates.hashlineAnchors?.enabled === true && gates.hashlineAnchors?.required === true) return true;
  if (gates.commentChecker?.enabled === true && gates.commentChecker?.blockOnFindings === true) return true;
  return false;
}
