// =============================================================================
// 文件名称：gate-arming.mjs
// 所属模块：infra
// 作用说明：
//   门武装地板评估（「门未武装」黄灯）：默认配置下 review 可能同义反复、
//   质量门全关，本模块纯评估 gates 是否真正武装，不写配置、不自动改门。
//
// 【运行原理速读】
//   可以把它想成「验收仪表盘上的黄灯检测器」：
//
//   · 何时执行？
//     status/dashboard 展示、doctor 检查活跃任务的门配置是否有效。
//
//   · 它做了什么？
//     ① 扫 verify 缺失/trivial ② review 无独立 lane ③ qualityGates 无 required 项。
//
//   · 缺了它会怎样？
//     全绿假象：verify 全是 true、review 复读 worker 结果，交付无真实信号。
// =============================================================================
import { isTrivialCommand } from "./task-predicates.mjs";

/** 参与门武装评估的活跃任务状态集合（不含 completed/draft 等终态或草稿）。 */
const ACTIVE_TASK_STATUSES = new Set(["pending", "in_progress", "verifying", "failed", "review_blocked"]);

/**
 * 评估当前配置与活跃任务的门是否已真正武装。
 * @param {{ config?: object, tasks?: object[] }} [params]
 * @returns {{ armed: boolean, issues: object[] }}
 */
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

  const tasksWithoutRealReview = activeTasks.filter((task) => !hasRealReviewLane(task, config));
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
      next_action: "在 wildarrange.config.json 中至少把一项质量门设为 required（如 lspDiagnostics 或 commentChecker.blockOnFindings）",
    });
  }

  return { armed: issues.length === 0, issues };
}

/**
 * 判断任务是否具备独立于 worker/verify 的 review 信号 lane。
 * @param {object|null|undefined} task 任务对象
 * @param {object|null|undefined} config 运行时配置
 * @returns {boolean}
 */
export function hasRealReviewLane(task, config) {
  if (task?.responsibilityChanges && typeof config?.review?.responsibility?.command === "string" && !isTrivialCommand(config.review.responsibility.command)) return true;
  if ((task?.review_commands || []).some((command) => !isTrivialCommand(command))) return true;
  if ((task?.standards_commands || []).some((command) => !isTrivialCommand(command))) return true;
  if (config?.review?.llm?.enabled === true) return true;
  return hasEnabledQualityGate(config);
}

/**
 * 判断 hasEnabledQualityGate 条件。
 */
function hasEnabledQualityGate(config) {
  const gates = config?.qualityGates || {};
  if (gates.lspDiagnostics?.enabled === true && (gates.lspDiagnostics.commands || []).length > 0) return true;
  if (gates.astStructure?.enabled === true && (gates.astStructure.commands || []).length > 0) return true;
  if (gates.hashlineAnchors?.enabled === true && (gates.hashlineAnchors.anchors || []).length > 0) return true;
  // commentChecker 只有 blockOnFindings 时才构成独立信号；否则它只是 warn。
  if (gates.commentChecker?.enabled === true && gates.commentChecker?.blockOnFindings === true) return true;
  return false;
}

/**
 * 判断 hasRequiredQualityGate 条件。
 */
function hasRequiredQualityGate(config) {
  const gates = config?.qualityGates || {};
  if (gates.lspDiagnostics?.enabled === true && gates.lspDiagnostics?.required === true) return true;
  if (gates.astStructure?.enabled === true && gates.astStructure?.required === true) return true;
  if (gates.hashlineAnchors?.enabled === true && gates.hashlineAnchors?.required === true) return true;
  if (gates.commentChecker?.enabled === true && gates.commentChecker?.blockOnFindings === true) return true;
  return false;
}

