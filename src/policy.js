// 各待办环节的处理时限（小时）。紧急程度只影响接诊环节，其余环节全辖区统一口径。
export const SLA_HOURS = {
  triage: 24, // 基层提交后，接诊方须在该时限内接诊或退回
  triage_urgent: 4,
  triage_priority: 12,
  supplement: 48, // 接诊方要求补材后，基层补交时限
  supplement_review: 24, // 补交后接诊方复核时限
  mdt_schedule: 72, // 多学科会诊须在该时限内排期
  mdt_feedback: 48, // 会诊后排期/反馈时限
  transfer: 24, // 跨院转接响应时限
  transfer_urgent: 8,
  follow_up: 24 * 14, // 随访触达时限
};

// 随访连续触达失败达到该次数即判定失联
export const FOLLOW_UP_FAILURE_LIMIT = 3;

// 监管口径：覆盖范围要求（省级医院 + 三百万人口以上地市）
export const COVERAGE_POPULATION_THRESHOLD = 3_000_000;

// 候选排序权重与归一化参数（口径写入代码与监管快照，可解释、可复算）
export const CANDIDATE_POLICY = {
  weights: {
    capability: 0.35,
    distance: 0.25,
    waiting: 0.25,
    urgencyFit: 0.15,
  },
  distanceScaleKm: 200, // 距离得分 = 1 - min(距离/200, 1)
  waitingScaleDays: 30, // 候诊得分 = 1 - min(候诊天数/30, 1)
};

export function urgencyTriageHours(urgency) {
  if (urgency === "urgent") return SLA_HOURS.triage_urgent;
  if (urgency === "priority") return SLA_HOURS.triage_priority;
  return SLA_HOURS.triage;
}

export function urgencyTransferHours(urgency) {
  return urgency === "urgent" ? SLA_HOURS.transfer_urgent : SLA_HOURS.transfer;
}

// 各病种类别必要材料：缺失则拒收；遗传/基因资料必须具备 genetic 授权范围
export const REQUIRED_DOCUMENTS = {
  遗传代谢类: {
    required: ["clinical-summary", "laboratory-index", "phenotype-record"],
    genetic: ["genetic-test-report", "gene-variant-file"],
  },
  default: {
    required: ["clinical-summary", "phenotype-record"],
    genetic: ["genetic-test-report", "gene-variant-file"],
  },
};

export function documentRule(category) {
  return REQUIRED_DOCUMENTS[category] ?? REQUIRED_DOCUMENTS.default;
}

// 疑似重复判定阈值
export const DUPLICATE_POLICY = {
  patientScoreThreshold: 60,
  contactHashScore: 70,
  checkDaysWindow: 30,
};
