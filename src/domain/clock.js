// 时钟与时限配置。所有业务时间统一走 now()，测试可注入固定时钟。

export const ISO = "iso";

export function defaultNow() {
  return new Date();
}

export function toIso(date = new Date()) {
  return date.toISOString();
}

export function addHours(iso, hours) {
  return new Date(new Date(iso).getTime() + hours * 3600_000).toISOString();
}

// 各动作处理时限（小时），按紧急程度区分。
export const SLA_HOURS = {
  accept: { routine: 72, priority: 48, urgent: 24 },      // 接诊时限
  supplement: { routine: 120, priority: 96, urgent: 72 }, // 基层补充材料时限
  mdt_schedule: 168,   // 多学科会诊排期：7 天内
  mdt_feedback: 72,    // 会诊后统一反馈：3 天内
  followup: 720,       // 首次随访：30 天
  notify_return: 24,   // 退回告知：1 天
};

// 提交转诊时的必要材料（按病种类别可扩展）。
export const REQUIRED_DOCUMENTS = {
  default: ["clinical-summary", "laboratory-index"],
  // 遗传代谢类在基础材料之外还须有遗传/基因相关材料时，由调用方按遗传标志处理。
};

// 状态终态：进入后不再产生新的待办时限。
export const TERMINAL_STATUSES = new Set(["returned", "completed", "lost_to_followup"]);
