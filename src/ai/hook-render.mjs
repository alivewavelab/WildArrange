// =============================================================================
// 文件名称：hook-render.mjs
// 所属模块：ai
// 作用说明：
//   将 Hook 运行时事实与注入点内容渲染为宿主可消费的 Markdown 或 JSON 输出。
//   不负责收集 facts 或解析配置，只做字符串拼装与 Cursor PreToolUse 协议封装。
//
// 【运行原理速读】
//   · 何时触发？ hooks.mjs 在 runInjectionHook 末尾调用本模块渲染 output。
//   · 做了什么？ ① 生成 <wildarrange-injection> 块 ② 按 facts 分区插入路由/计划/
//     续跑/范围门等指令 ③ PreToolUse 时封装 permissionDecision JSON。
//   · 与谁协作？ hooks.mjs（facts 来源）、injection.mjs（injectionPoint 附件）。
// =============================================================================

import { PRODUCT_NAME } from "../infra/runtime-config.mjs";

// --- PreToolUse 输出 ---

/**
 * 渲染 PreToolUse Hook 的 JSON 行输出；deny 时附带 permissionDecision。
 * @param {object|null} preflight preToolUseGuard 返回的预检结果
 * @param {string} contextMarkdown 已渲染的注入 Markdown
 * @returns {string} 单行 JSON + 换行
 */
export function renderPreToolUseHookOutput(preflight, contextMarkdown) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: contextMarkdown,
    },
  };
  if (preflight?.decision === "deny") {
    output.hookSpecificOutput.permissionDecision = "deny";
    output.hookSpecificOutput.permissionDecisionReason = preflight.reason || `${PRODUCT_NAME} pre-tool-use guard denied this tool call.`;
  }
  return `${JSON.stringify(output)}\n`;
}

/**
 * 渲染完整的 WildArrange 运行时注入 Markdown 块（含必须行为、挂载与 facts 分区）。
 * @param {object} params event、pointName、sessionId、taskId、targetPaths、facts、injectionPoint
 * @returns {string} Markdown 文本
 */
export function renderHookInjectionMarkdown({ event, pointName, sessionId, taskId, targetPaths, facts, injectionPoint }) {
  const lines = [
    `<wildarrange-injection event="${event}" point="${pointName}">`,
    "",
    "# WildArrange 运行时注入",
    "",
    `- 事件：${event}`,
    `- 注入点：${pointName}`,
    `- 会话：${sessionId}`,
    `- 任务：${taskId || "(none)"}`,
    `- 配置：${injectionPoint.configPath}`,
    "",
    "## 必须行为",
    "",
    "- 把本块当作当前运行时上下文，不是可选文档。",
    "- Worker 声称完成不等于完成；完成必须通过 verifier、scope、review、checkpoint gate。",
    "- 不得削弱或删除项目规则、success criteria 来制造 PASS。",
    "- 如果注入证据不足，返回 INCONCLUSIVE 或请求必要 gate，不要猜测。",
    "",
    "## 工具",
    "",
    injectionPoint.tools.length > 0 ? `- ${injectionPoint.tools.join("\n- ")}` : "- (none)",
    "",
  ];

  if (targetPaths.length > 0) {
    lines.push("## 动态目标", "", ...targetPaths.map((targetPath) => `- ${targetPath}`), "");
  }
  appendHookFacts(lines, facts);
  appendInjectionAttachments(lines, injectionPoint);
  lines.push("</wildarrange-injection>", "");
  return lines.join("\n");
}

// --- Hook 事实块渲染 ---

function appendHookFacts(lines, facts) {
  if (facts.route) {
    lines.push("## 路由决策", "");
    lines.push(`- 意图：${facts.route.intent}`);
    lines.push(`- 路由：${facts.route.route}`);
    lines.push(`- 主 Agent：${facts.route.primaryAgent}`);
    lines.push(`- 类别：${facts.route.category || "(none)"}`);
    lines.push(`- 风险：${facts.route.risk || "(unknown)"}`);
    if ((facts.route.planSkills || []).length > 0) {
      lines.push("- 计划 Skill 组合：");
      for (const skill of facts.route.planSkills) {
        lines.push(`  - ${skill.name} (${skill.stage}): ${skill.purpose}`);
      }
    }
    lines.push("");
  }
  if (facts.route?.featureDesign?.status === "awaiting_feature_confirmation") {
    lines.push("## 功能设计确认门（禁止绕过）", "");
    lines.push(`- 状态：等待功能设计确认（${facts.route.featureDesign.id}）`);
    lines.push("- 本轮只能继续澄清或展示完整确认稿；“开始做”“直接做”“跳过计划”等表达均不放行。");
    lines.push("- 只有开发者单独明确回复“确认”后，才进入完整 Plan 生成阶段。", "");
  }
  if (facts.route?.featureDesign?.status === "awaiting_plan_import") {
    lines.push("## 完整 Plan 门（禁止绕过）", "");
    lines.push(`- 已确认功能设计：${facts.route.featureDesign.id}`);
    lines.push("- 现在只能生成并导入绑定该功能设计的完整 Plan；Plan 导入并由开发者批准前不得开发。", "");
  }
  if (facts.planDraft) {
    lines.push("## 生成计划草稿（必须执行）", "");
    lines.push("- 使用当前宿主大模型理解本轮对话，不要只做关键词拼接。");
    lines.push(`- 把计划 JSON 写入：${facts.planDraft.draftPath}`);
    lines.push('- 顶层必须包含：`generated_by: "host_semantic"`、`title`、`objective`、`tasks`。');
    if (facts.planDraft.featureDesignRef) {
      lines.push(`- 本计划必须绑定已确认功能设计：\`feature_design_ref: "${facts.planDraft.featureDesignRef}"\`；缺失或不匹配时禁止导入和开发。`);
    }
    lines.push("- 每张任务必须包含：`id`、`subject`、`description`、`owner`、`writable_paths`、`worker_command`、`verify_commands`、`successCriteria`。`worker_command` 必须是宿主可执行的真实实现命令，并在 WildArrange 准备的隔离任务 worktree 中产生 `writable_paths` 内的改动；不得使用 `node --version`、`process.exit(0)`、`true` 等占位命令。`verify_commands` 必须是非空的命令字符串数组，不能写成对象数组。每条 successCriteria 是带 `title`、`expectedEvidence`、`verifierCommandRefs` 的对象；`verifierCommandRefs` 填从 0 开始的命令索引数组，或与 `verify_commands` 完全一致的命令字符串数组。");
    lines.push("- 每张任务还必须包含 responsibilityChanges 数组，每项写 script（精确目标脚本）、additions（新增内容）、responsibilityBefore、responsibilityAfter、facts 数组。每项事实写 name、ownerBefore、ownerAfter、access（统一读写入口）；无事实填 facts: []，新事实 ownerBefore 为 null。计划摘要用中文展示职责变化与事实归属，等待用户确认。交付 Review 必须独立审计 R1-R5：符合已批职责、无职责混杂、无重复事实、无绕过入口、无重复实现；缺少执行器或有效证据不得称通过。");
    lines.push(`- owner 规则：${facts.planDraft.ownerPolicy}。可执行工单通常交给 ZhuRong，必要时由 Jiuwei；DiJiang、BaiZe、LuWu 通过计划、复核、治理阶段参与，不得作为 command worker。`);
    if (facts.planDraft.nextCommand) {
      lines.push(`- 写完草稿后执行：${facts.planDraft.nextCommand.replace("<draftPath>", facts.planDraft.draftPath)}`);
    } else {
      lines.push("- 用户明确只要草稿：写完即停止，不要执行 `plan --from`，不要登记正式计划或进入审批状态。");
    }
    lines.push("- 导入后先向用户展示计划摘要并等待明确确认；未执行 plan approve 前不得 run。", "");
  }
  if (facts.resume) {
    lines.push("## 恢复上下文", "");
    lines.push(`- 上下文：${facts.resume.contextPath}`);
    lines.push(`- 下一步：${facts.resume.nextAction}`);
    lines.push("");
  }
  if (facts.continuation) {
    lines.push("## 续跑指令", "");
    lines.push(`- 是否继续：${facts.continuation.shouldContinue ? "yes" : "no"}`);
    lines.push(`- 原因：${facts.continuation.reason}`);
    lines.push(`- 下一命令：${facts.continuation.nextCommand || "(none)"}`);
    lines.push(`- 报告：${facts.continuation.reportMdPath}`);
    lines.push("");
  }
  if (facts.routingReview) {
    lines.push("## 今日路由复盘", "");
    if (facts.routingReview.status === "warn" || facts.routingReview.status === "skipped") {
      lines.push(`- 状态：${facts.routingReview.status}`);
      lines.push(`- 原因：${facts.routingReview.reason || "(none)"}`);
    } else {
      lines.push(`- 今日判断：${facts.routingReview.summary.total} 次`);
      lines.push(`- 已复盘：${facts.routingReview.summary.reviewed} 次`);
      lines.push(`- 已发现问题：${facts.routingReview.summary.issues} 次`);
      lines.push(`- 待人工复盘：${facts.routingReview.summary.unreviewed} 次`);
      lines.push(`- 人类可读报告：${facts.routingReview.reportMdPath}`);
      if (facts.routingReview.summary.issues > 0) {
        lines.push("- 请主动提醒开发者查看问题判断，但不要自动修改路由规则。");
      }
    }
    lines.push("");
  }
  if (facts.digest) {
    lines.push("## 记忆摘要", "");
    if (facts.digest.error) {
      lines.push(`- 警告：${facts.digest.error}`);
    } else {
      lines.push(`- 报告：${facts.digest.reportMdPath || "(none)"}`);
      lines.push(`- 原因：${facts.digest.reason || "(unknown)"}`);
      appendShortList(lines, "进展", facts.digest.progress);
      appendShortList(lines, "决策", facts.digest.decisions);
      appendShortList(lines, "产物", facts.digest.artifacts);
      appendShortList(lines, "风险", facts.digest.pitfalls);
      appendShortList(lines, "开放问题", facts.digest.openQuestions);
    }
    lines.push("");
  }
  if (facts.archivist) {
    lines.push("## 档案路由", "");
    if (facts.archivist.status === "warn") {
      lines.push(`- 警告：${facts.archivist.reason || "(none)"}`);
    } else {
      const routeDecision = facts.archivist.decision?.routeDecision;
      lines.push(`- 状态：${facts.archivist.llmStatus || facts.archivist.status || "(unknown)"}`);
      lines.push(`- 摘要：${facts.archivist.decision?.summary || "(none)"}`);
      if (routeDecision) {
        lines.push(`- 建议路由：${routeDecision.route || "(none)"}`);
        lines.push(`- 置信度：${routeDecision.confidence ?? "(unknown)"}`);
      }
      const injection = facts.archivist.decision?.contextInjection || {};
      appendShortList(lines, "档案进展", injection.progress);
      appendShortList(lines, "档案风险", injection.pitfalls);
      appendShortList(lines, "档案开放问题", injection.openQuestions);
    }
    lines.push("");
  }
  if (facts.scope) {
    lines.push("## 范围门", "");
    lines.push(`- 状态：${facts.scope.status}`);
    lines.push(`- 原因：${facts.scope.reason || "(none)"}`);
    lines.push("");
  }
  if (facts.resultGate) {
    lines.push("## 工具结果门", "");
    lines.push(`- 决策：${facts.resultGate.decision}`);
    lines.push(`- 摘要：${facts.resultGate.summary}`);
    if (facts.resultGate.findings.length > 0) {
      for (const finding of facts.resultGate.findings) {
        lines.push(`- ${finding.severity}: ${finding.name} - ${finding.requiredAction}`);
      }
    }
    lines.push("");
  }
  if (facts.rules) {
    lines.push("## 项目规则", "");
    lines.push(`- 命中：${facts.rules.matched}/${facts.rules.total}`);
    lines.push(`- 报告：${facts.rules.reportMdPath}`);
    for (const rule of facts.rules.rules || []) {
      lines.push(`- ${rule.path}: ${rule.description}`);
      if (rule.content) {
        lines.push("");
        lines.push("```markdown");
        lines.push(rule.content);
        lines.push("```");
      }
    }
    lines.push("");
  }
  if (facts.agentContext) {
    lines.push("## Agent 上下文", "");
    if (facts.agentContext.error) {
      lines.push(`- 错误：${facts.agentContext.error}`);
    } else {
      lines.push(`- 报告：${facts.agentContext.reportMdPath}`);
      lines.push(`- Agent：${facts.agentContext.agent}`);
      lines.push(`- 角色：${facts.agentContext.role}`);
      const prompt = facts.agentContext.agentPrompt;
      if (prompt) {
        lines.push(`- 身份 Prompt：${prompt.loadedChars}/${prompt.chars} 字符；预算 ${prompt.budgetChars}${prompt.truncated ? "；已截断" : ""}`);
        lines.push("", `### ${facts.agentContext.agent} 身份 Prompt`, "", prompt.content);
      }
      const delivery = facts.agentContext.injectionPoint;
      if (delivery?.name === "before_execute") {
        lines.push("", "### 执行前任务 Skill（宿主必须按此工作流执行）", "");
        if ((delivery.skills || []).length === 0) {
          lines.push("- (none)");
        } else {
          for (const skill of delivery.skills) {
            lines.push(`#### ${skill.name}`, "", renderAttachmentMeta(skill), "", skill.content || "(empty)", "");
          }
        }
        appendSkillSelectionReport(lines, delivery.skillSelection);
      }
    }
    lines.push("");
  }
  appendAttentionReport(lines, facts.attention);
}

// --- 决策关注项 ---

// 把待人决策事项渲染成“请主动问开发者”的指令块（通用推送：以 AI 对话为通道，不依赖任何外部 IM）。
function appendAttentionReport(lines, attention) {
  if (!attention || (attention.total || 0) === 0) return;
  lines.push("## 需要开发者决策（请主动向开发者提问，不要替他决定）", "");
  lines.push(`- 共有 ${attention.total} 项待处理。请在对话中用中文向开发者说明，并给出明确选项，等开发者答复后再继续。`);
  for (const item of attention.awaitingPlanApproval || []) {
    lines.push(`- [计划待确认] 计划 ${item.planId} 需开发者确认后才能执行。请复述计划要点并询问“确认 / 需要修改”；确认后执行：\`${item.approveHint}\`。`);
  }
  for (const change of attention.openChanges || []) {
    if (change.source === "contract_change") {
      lines.push(`- [计划外接口/数据库变更] ${change.id} / 任务 ${change.taskId} 已暂停。主 Agent 先读报告 \`${change.reportMdPath}\`，向开发者说明：为什么需要（${change.rationale}）；影响（${change.impact}）；替代方案（${change.alternatives}）；建议（${change.recommendation}）。`);
      lines.push(`  - 报告中的内容指纹：${change.fingerprint}。只在开发者明确决定后执行 \`${change.resolveHint}\`。不得自动批准、重复催问或继续该任务；新会话继续引用同一请求。`);
      continue;
    }
    lines.push(`- [越界变更待审] 任务 ${change.taskId} 改动越界：${(change.deniedPaths || []).join(", ") || "(见报告)"}。请询问开发者“接受并纳入范围 / 拒绝返工”；处理：\`${change.resolveHint}\`。`);
  }
  for (const task of attention.needsUserDecision || []) {
    lines.push(`- [任务待决策] 任务 ${task.id}（${task.status}）：${task.subject}。需要开发者给出下一步决定。`);
  }
  for (const task of attention.failedTasks || []) {
    lines.push(`- [任务失败] 任务 ${task.id}：${task.reason}。${task.retryHint ? `建议：${task.retryHint}` : "请与开发者确认返工方向。"}`);
  }
  for (const item of attention.awaitingAcceptance || []) {
    lines.push(`- [子 Agent 待验收] run ${item.runId} / 任务 ${item.taskId}（${item.agent}）。请询问开发者是否合入：\`${item.admitHint}\`。`);
  }
  lines.push("");
}

function appendShortList(lines, label, items) {
  const selected = Array.isArray(items) ? items.filter(Boolean).slice(0, 3) : [];
  if (selected.length === 0) return;
  lines.push(`- ${label}：`);
  for (const item of selected) {
    lines.push(`  - ${item}`);
  }
}

// --- 挂载与 Skill 报告 ---

function appendInjectionAttachments(lines, injectionPoint) {
  lines.push("## Markdown 挂载", "");
  if (injectionPoint.markdown.length === 0) {
    lines.push("- (none)", "");
  } else {
    for (const item of injectionPoint.markdown) {
      lines.push(`### ${item.path}`, "", renderAttachmentMeta(item), "", item.content || "(empty)", "");
    }
  }
  lines.push("## Skill 挂载", "");
  if (injectionPoint.skills.length === 0) {
    lines.push("- (none)", "");
  } else {
    for (const skill of injectionPoint.skills) {
      lines.push(`### ${skill.name}`, "", renderAttachmentMeta(skill), "", skill.content || "(empty)", "");
    }
  }
  appendSkillSelectionReport(lines, injectionPoint.skillSelection);
}

function appendSkillSelectionReport(lines, selection) {
  if (!selection) return;
  const referenced = selection.referenced || [];
  const suggestions = selection.suggestions || [];
  const missing = selection.missing || [];
  if (missing.length > 0) {
    lines.push("## Skill 配置告警", "");
    for (const item of missing) {
      if (item.reason === "integrity_failed") {
        lines.push(`- ${item.name} 完整性校验失败，已拒绝加载：${item.detail || "Prompt Pack 路径或 hash 不可信"}`);
      } else {
        lines.push(`- ${item.name} 未找到：请安装到 \`.agents/skills/${item.name}/SKILL.md\`，或登记到 Prompt Pack。`);
      }
    }
    lines.push("");
  }
  if (selection.mode !== "dynamic" || (referenced.length === 0 && suggestions.length === 0)) return;
  lines.push("## 按需可加载 Skill（未注入全文）", "");
  for (const item of referenced) {
    lines.push(`- ${item.name}（${item.reason === "over_max_skills" ? "超出本次挂载上限" : "与本次请求未匹配"}）：需要时执行 \`node ./bin/wildarrange.mjs prompts show --skill ${item.name}\``);
  }
  for (const item of suggestions) {
    lines.push(`- ${item.name}（匹配分 ${item.score}，不在本注入点清单）：需要时执行 \`node ./bin/wildarrange.mjs prompts show --skill ${item.name}\``);
  }
  lines.push("");
}

function renderAttachmentMeta(item) {
  const source = item.path ? `path=${item.path}` : "";
  const origin = item.source ? `source=${item.source}` : "";
  const chars = `chars=${item.chars ?? 0}`;
  const loaded = `loaded=${item.loadedChars ?? String(item.content || "").length}`;
  const budget = `budget=${item.budgetChars ?? "unknown"}`;
  const truncated = `truncated=${item.truncated === true}`;
  return `> 挂载信息：${[source, origin, chars, loaded, budget, truncated].filter(Boolean).join("; ")}`;
}
