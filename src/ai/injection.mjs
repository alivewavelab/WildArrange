// =============================================================================
// 文件名称：injection.mjs
// 所属模块：ai
// 作用说明：
//   解析 wildarrange.config 中的 injectionPoints，按注入点组装 Markdown、Skill
//   与工具清单；负责静态清单与动态按需挂载的取舍，不负责 Hook 事件分发或路由。
//
// 【运行原理速读】
//   · 何时触发？ hooks.mjs / context.mjs 在 SessionStart、UserPromptSubmit、
//     before_execute 等阶段按点名调用 resolveInjectionPoint。
//   · 做了什么？ ① 展开模板路径并加载 Markdown/Skill 附件 ② 合并 Agent/任务
//     绑定 Skill ③ 可选调用 skill-matcher 做动态减法挂载 ④ 返回预算与选型报告。
//   · 与谁协作？ context-attachments、skill-matcher、runtime-config、task-state。
// =============================================================================

import { loadMarkdownAttachment, loadSkillAttachment, normalizeMaxChars } from "../infra/context-attachments.mjs";
import {
  DEFAULT_LEAD_AGENT,
  normalizeAgentKey,
} from "../infra/agent-registry.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import {
  readJson,
  resolveWildArrangePath,
} from "../infra/runtime-store.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";
import { matchSkills } from "./skill-matcher.mjs";

/** 动态挂载模式下始终带全文的 Skill 名（运行时注入说明），不受匹配分数影响。 */
const DEFAULT_DYNAMIC_ALWAYS_MOUNT = ["wildarrange-injection-runtime"];
/** 动态部分除 alwaysMount 外最多再挂载的 Skill 全文数量上限。 */
const DEFAULT_DYNAMIC_MAX_SKILLS = 4;

/**
 * 解析指定注入点的完整挂载结果（Markdown、Skill、工具、预算与选型报告）。
 * @param {string} rootDir 项目根目录
 * @param {string} name 注入点名称（如 user_prompt_submit、before_execute）
 * @param {object} variables 模板变量（agent、taskId、planId 等）
 * @param {object} options 可选：text（请求文本）、stage、taskSkills、routeSkills
 * @returns {Promise<object>} 注入点配置与已加载附件
 */
export async function resolveInjectionPoint(rootDir, name, variables = {}, options = {}) {
  const { config, sourcePath } = await loadWildArrangeConfig(rootDir);
  const point = config.injectionPoints?.[name] || { enabled: false, tools: [], markdown: [], skills: [] };
  const budgets = resolvePointBudgets(config.contextBudgets, name, point.contextBudgets);
  const markdown = [];
  for (const rawPath of point.markdown || []) {
    const resolved = expandTemplate(rawPath, variables);
    const loaded = await loadMarkdownAttachment(rootDir, resolved, budgets.markdownMaxChars);
    if (loaded) markdown.push(loaded);
  }
  const taskSkills = await resolveTaskBoundSkills(rootDir, name, variables, options);
  const selection = await selectPointSkills(rootDir, config, point, {
    text: typeof options.text === "string" ? options.text : "",
    stage: typeof options.stage === "string" ? options.stage : "",
    agent: variables.agent || "",
    taskSkills,
    routeSkills: name === "user_prompt_submit" ? normalizeStringList(options.routeSkills, []) : [],
  });
  const skills = [];
  const missingSkills = [];
  for (const skill of selection.mounted) {
    try {
      const loaded = await loadSkillAttachment(rootDir, skill, budgets.skillMaxChars);
      if (loaded) skills.push(loaded);
      else missingSkills.push({ name: skill, reason: "not_found" });
    } catch (error) {
      // Prompt Pack hash 校验失败时记录告警，不阻断其余 Skill 加载
      missingSkills.push({
        name: skill,
        reason: "integrity_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    name,
    enabled: point.enabled !== false,
    configPath: sourcePath,
    budgets,
    tools: point.tools || [],
    markdown,
    skills,
    skillSelection: { ...selection.report, missing: missingSkills },
    rules: point.rules || {},
  };
}

/** 解析任务绑定的 Skill 列表；仅 before_execute 注入点消费任务级绑定。 */
async function resolveTaskBoundSkills(rootDir, pointName, variables, options) {
  // M1 只有执行前宿主入口会真实消费任务绑定；复核与 checkpoint 仍使用各自
  // 注入点的静态 Skill，不把尚未接入宿主的阶段伪装成已挂载。
  if (pointName !== "before_execute") return [];
  if (Array.isArray(options.taskSkills)) return normalizeStringList(options.taskSkills, []);
  if (!variables.taskId) return [];
  const state = await loadTaskState(rootDir, { planId: variables.planId || undefined });
  if (!state) return [];
  const planId = variables.planId || state.activePlanId || state.planId || "";
  const matches = (state.tasks || []).filter((task) =>
    task.id === variables.taskId && (!planId || task.planId === planId));
  const task = matches.length === 1 ? matches[0] : null;
  return normalizeStringList(task?.skills, []);
}

/**
 * 按需挂载只做"减法"：静态清单是上限，动态匹配决定哪些 Skill 带全文进入上下文。
 * 未命中降级为路径引用，不因文本命中就注入清单外 Skill 全文。
 */
async function selectPointSkills(rootDir, config, point, context) {
  const pointSkills = (point.skills || []).filter((skill) => typeof skill === "string" && skill.length > 0);
  const normalizedAgent = normalizeAgentKey(context.agent);
  const agentSkills = (config.agents?.[normalizedAgent]?.skills || [])
    .filter((skill) => typeof skill === "string" && skill.length > 0);
  const dynamicConfig = config.skillMatcher?.dynamicInjection || {};
  const maxSkills = normalizeMaxSkills(dynamicConfig.maxSkills, DEFAULT_DYNAMIC_MAX_SKILLS);
  const requestedTaskSkills = normalizeStringList(context.taskSkills, []);
  const taskSkills = requestedTaskSkills.slice(0, maxSkills);
  const taskOverflow = requestedTaskSkills.slice(maxSkills)
    .map((name) => ({ name, reason: "task_binding_over_max" }));
  const routeSkills = normalizeStringList(context.routeSkills, [])
    .filter((skill) => pointSkills.includes(skill))
    .slice(0, maxSkills);
  const configured = [...new Set([...pointSkills, ...agentSkills, ...taskSkills])];
  const enabled = dynamicConfig.enabled !== false && config.skillMatcher?.enabled !== false;
  const staticReport = {
    mode: "static",
    mounted: configured,
    referenced: taskOverflow,
    bound: agentSkills,
    taskBound: taskSkills,
    reason: null,
  };
  if (!enabled) return { mounted: configured, report: { ...staticReport, reason: "dynamic_injection_disabled" } };
  if (!context.text || context.text.trim().length === 0) {
    return { mounted: configured, report: { ...staticReport, reason: "no_request_text" } };
  }

  let match;
  try {
    match = await matchSkills(rootDir, {
      text: context.text,
      stage: context.stage,
      agent: context.agent,
      limit: 20,
    });
  } catch (error) {
    return { mounted: configured, report: { ...staticReport, reason: `matcher_unavailable: ${error instanceof Error ? error.message : String(error)}` } };
  }

  const alwaysMount = [...new Set([
    ...normalizeStringList(dynamicConfig.alwaysMount, DEFAULT_DYNAMIC_ALWAYS_MOUNT),
    ...agentSkills,
    ...taskSkills,
    ...routeSkills,
  ])];
  // 只认与请求内容相关的信号（关键词/路由/阶段/名称命中）；
  // agent 身份加分对每次请求都恒定，等于回到静态挂载，不能作为按需依据。
  const scores = new Map(
    match.matched
      .filter((entry) => (entry.reasons || []).some((reason) => !reason.startsWith("agent:")))
      .map((entry) => [entry.name, entry.score]),
  );

  const mounted = [];
  const referenced = [...taskOverflow];
  for (const skill of configured) {
    if (alwaysMount.includes(skill)) {
      mounted.push(skill);
      continue;
    }
    if ((scores.get(skill) || 0) > 0) {
      mounted.push(skill);
    } else {
      referenced.push({ name: skill, reason: "not_matched" });
    }
  }

  // maxSkills 约束动态部分：保底技能之外，最多保留得分最高的 maxSkills 个
  const baseline = mounted.filter((skill) => alwaysMount.includes(skill));
  const dynamic = mounted
    .filter((skill) => !alwaysMount.includes(skill))
    .sort((left, right) => (scores.get(right) || 0) - (scores.get(left) || 0));
  for (const skill of dynamic.slice(maxSkills)) {
    referenced.push({ name: skill, reason: "over_max_skills" });
  }
  const finalMounted = [...baseline, ...dynamic.slice(0, maxSkills)];

  // 清单之外的高分技能只给引用，不注入全文
  const suggestions = match.matched
    .filter((entry) => !configured.includes(entry.name))
    .slice(0, 5)
    .map((entry) => ({ name: entry.name, score: entry.score, path: entry.path, reason: "matched_outside_point" }));

  return {
    mounted: finalMounted,
    report: {
      mode: "dynamic",
      textChars: context.text.length,
      stage: context.stage || null,
      bound: agentSkills,
      taskBound: taskSkills,
      routeBound: routeSkills,
      mounted: finalMounted,
      referenced,
      suggestions,
      reason: null,
    },
  };
}

/** 过滤非空字符串数组；非数组时回退到 fallback。 */
function normalizeStringList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item) => typeof item === "string" && item.length > 0);
}

/** 解析动态挂载 Skill 数量上限，非法值回退默认并 clamp 至 20。 */
function normalizeMaxSkills(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, 20);
}

/**
 * 按 Agent 角色推断默认注入点名称；Jiuwei 有 taskId 时走 before_execute，否则 user_prompt_submit。
 * @param {string} agent Agent 键名
 * @param {object} options 可选 taskId
 * @returns {string} 注入点名称
 */
export function defaultInjectionPointForAgent(agent, options = {}) {
  const normalized = normalizeAgentKey(agent);
  if (normalized === "BaiZe") return "before_review";
  if (normalized === "LuWu") return "repository_governance";
  if (normalized === DEFAULT_LEAD_AGENT) {
    return options.taskId ? "before_execute" : "user_prompt_submit";
  }
  return "before_execute";
}

/** 展开注入点路径模板中的 {agent}、{taskId} 等占位符。 */
function expandTemplate(value, variables) {
  return String(value).replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => variables[key] || "");
}

/** 合并全局、按注入点与点级 contextBudgets，得到 markdown/skill 字符预算。 */
function resolvePointBudgets(contextBudgets = {}, pointName, pointBudgets = {}) {
  const globalMarkdown = contextBudgets.markdown?.maxChars ?? contextBudgets.markdownMaxChars;
  const globalSkill = contextBudgets.skill?.maxChars ?? contextBudgets.skillMaxChars;
  const pointOverride = contextBudgets.points?.[pointName] || {};
  const merged = {
    markdownMaxChars: globalMarkdown,
    skillMaxChars: globalSkill,
    ...pointOverride,
    ...pointBudgets,
  };
  return {
    markdownMaxChars: normalizeMaxChars(merged.markdownMaxChars, 12_000),
    skillMaxChars: normalizeMaxChars(merged.skillMaxChars, 80_000),
  };
}
