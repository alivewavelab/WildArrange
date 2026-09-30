// =============================================================================
// 文件名称：task-input.mjs
// 所属模块：interface
// 作用说明：
//   `task create` 的命令行输入适配：把 --title/--type/--priority 等标志翻译为
//   task-board 可接收的任务对象，并承载 CLI 默认值；不做任务状态或校验逻辑。
// =============================================================================

/** 将逗号分隔字符串拆成去空白数组；非字符串返回 []。 */
export function splitCliList(value) {
  if (typeof value !== "string") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * 由命令行标志构造任务对象（未提供 --from 时使用）。
 * @param {{ title?: string, subject?: string, description?: string, type?: string, priority?: string, source?: string, parent?: string, writable?: string, verify?: string, review?: string }} flags 已取出的字符串标志
 * @returns {object}
 */
export function buildTaskFromFlags(flags) {
  const subject = flags.title || flags.subject || null;
  if (!subject) throw new Error("wildarrange task create requires --from <task.json> or --title <text>");
  return {
    subject,
    description: flags.description || subject,
    workType: flags.type || "maintenance",
    priority: flags.priority ? flags.priority.toUpperCase() : "P1",
    source: flags.source || "user",
    parentTaskRef: flags.parent || null,
    writable_paths: splitCliList(flags.writable),
    verify_commands: flags.verify ? [flags.verify] : [],
    review_commands: flags.review ? [flags.review] : [],
  };
}
