import { haversineKm, clamp, round3 } from "../util.js";
import { CANDIDATE_POLICY, DUPLICATE_POLICY } from "../policy.js";

/**
 * 去标识化患者相似度。仅使用授权摘要中的稳定特征，不还原身份：
 * 同一伪名直接判定；联系方式哈希、出生年、性别、辖区、表型组合加权。
 * 返回 0-100 分与逐项命中理由，供人工复核，不做自动合并。
 */
export function scorePatientSimilarity(a, b) {
  if (a.patient_token && a.patient_token === b.patient_token) {
    return { score: 100, reasons: ["同一患者伪名"] };
  }
  let score = 0;
  const reasons = [];
  if (a.contact_hash && a.contact_hash === b.contact_hash) {
    score += DUPLICATE_POLICY.contactHashScore;
    reasons.push("联系方式哈希一致");
  }
  if (a.birth_year != null && b.birth_year != null && Math.abs(a.birth_year - b.birth_year) <= 1) {
    score += 15;
    reasons.push("出生年份相近");
  }
  if (a.gender && b.gender && a.gender === b.gender) {
    score += 10;
    reasons.push("性别一致");
  }
  if (a.residence_region_code && a.residence_region_code === b.residence_region_code) {
    score += 10;
    reasons.push("常住辖区一致");
  }
  const aPheno = new Set(a.phenotype_codes ?? []);
  const shared = (b.phenotype_codes ?? []).filter((code) => aPheno.has(code));
  if (shared.length > 0) {
    score += Math.min(shared.length * 5, 25);
    reasons.push(`表型编码重叠 ${shared.length} 项（${shared.join(",")}）`);
  }
  return { score: Math.min(score, 100), reasons };
}

/** 在历史转诊中查找疑似重复患者（已人工判定为不同身份的伪名对子不再提示）。 */
export function findSuspectedPatients(db, referral) {
  const differentIdentities = new Set(
    db.prepare("SELECT patient_token_a, patient_token_b FROM patient_identity_decisions WHERE decision = 'different'").all()
      .map((d) => identityKey(d.patient_token_a, d.patient_token_b)),
  );
  const prior = db
    .prepare(
      `SELECT r.* FROM referrals r
       WHERE r.referral_id <> ?
         AND r.created_at <= ?`,
    )
    .all(referral.referral_id, referral.created_at);
  const current = featuresOf(referral);
  const hits = [];
  for (const row of prior) {
    if (
      current.patient_token &&
      row.patient_token &&
      differentIdentities.has(identityKey(current.patient_token, row.patient_token))
    ) {
      continue;
    }
    const { score, reasons } = scorePatientSimilarity(current, featuresOf(row));
    if (score >= DUPLICATE_POLICY.patientScoreThreshold) {
      hits.push({ referral_id: row.referral_id, score, reasons });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

function identityKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * 重复检查识别：同一检查编码、检查日期相隔 ≤ 窗口期，且患者疑似同一人。
 * 用于提示基层避免重复开单，不阻止业务流转。
 */
export function findSuspectedChecks(db, referral, linkedReferralIds, checks, asOf) {
  if (linkedReferralIds.length === 0 || checks.length === 0) return [];
  const placeholders = linkedReferralIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM referral_checks
       WHERE referral_id IN (${placeholders}) AND check_date <= ?`,
    )
    .all(...linkedReferralIds, asOf.slice(0, 10));
  const hits = [];
  for (const mine of checks) {
    for (const other of rows) {
      if (other.check_code !== mine.check_code) continue;
      const days = Math.abs(
        Math.round(
          (Date.parse(mine.check_date) - Date.parse(other.check_date)) / 86_400_000,
        ),
      );
      if (days <= DUPLICATE_POLICY.checkDaysWindow) {
        hits.push({
          referral_id: other.referral_id,
          check_code: other.check_code,
          check_date: mine.check_date,
          other_date: other.check_date,
          days_apart: days,
        });
      }
    }
  }
  return hits;
}

function featuresOf(row) {
  return {
    patient_token: row.patient_token,
    contact_hash: row.contact_hash,
    birth_year: row.birth_year,
    gender: row.gender,
    residence_region_code: row.residence_region_code,
    phenotype_codes: JSON.parse(row.phenotype_codes_json ?? "[]"),
  };
}

/**
 * 可解释候选机构排序。
 * 只提供候选与理由，最终接诊机构由医生选择，系统不代行诊断。
 * 因子：病种能力 0.35、距离 0.25、候诊时间 0.25、紧急适配 0.15。
 */
export function rankCandidates(db, registry, referral, asOf) {
  const triageHours =
    referral.urgency === "urgent" ? 4 : referral.urgency === "priority" ? 12 : 24;
  const triageDays = triageHours / 24;

  const diseaseCode = referral.suspected_disease_code;
  const capabilities = diseaseCode
    ? registry.listCapabilities(diseaseCode, asOf)
    : db
        .prepare(
          `SELECT cv.* FROM capability_versions cv
           WHERE cv.disease_category = ? AND cv.status = 'active' AND cv.valid_from <= ?
           AND cv.valid_from = (
             SELECT MAX(valid_from) FROM capability_versions
             WHERE facility_id = cv.facility_id AND disease_code = cv.disease_code
               AND valid_from <= ?
           )`,
        )
        .all(referral.suspected_category, asOf, asOf);

  const excluded = [];
  const results = [];

  for (const cap of capabilities) {
    const facilityId = cap.facility_id;
    if (facilityId === referral.source_facility_id) {
      excluded.push({ facility_id: facilityId, reason: "发起机构自身" });
      continue;
    }
    const facility = registry.getFacility(facilityId, asOf);
    if (!facility) {
      excluded.push({ facility_id: facilityId, reason: "机构在该时点无有效登记版本" });
      continue;
    }
    if (!registry.hasActiveQualification(facilityId, asOf)) {
      excluded.push({ facility_id: facilityId, reason: "无有效罕见病门诊资质（未挂牌或已撤销）" });
      continue;
    }
    const schedule = registry.getSchedule(facilityId, cap.specialty, asOf);
    if (!schedule || schedule.status !== "active" || schedule.weekly_slots === 0) {
      excluded.push({
        facility_id: facilityId,
        reason: `专科 ${cap.specialty} 坐诊暂停或无号源，当前不可接诊`,
      });
      continue;
    }

    const distanceKm =
      referral.origin_lat == null
        ? null
        : haversineKm(referral.origin_lat, referral.origin_lng, facility.lat, facility.lng);
    const waitingDays = registry.estimateWaitingDays(facilityId, cap.specialty, asOf);

    const capabilityScore = cap.cap_level === "designated" ? 1 : cap.cap_level === "specialty" ? 0.75 : 0.5;
    const distanceScore = distanceKm == null ? 0.5 : 1 - clamp(distanceKm / CANDIDATE_POLICY.distanceScaleKm, 0, 1);
    const waitingScore = waitingDays == null ? 0 : 1 - clamp(waitingDays / CANDIDATE_POLICY.waitingScaleDays, 0, 1);
    const urgentCapacity = waitingDays != null && waitingDays <= triageDays;
    const urgencyFit =
      capabilityScore * 0.6 + (urgentCapacity ? 0.4 : waitingDays != null && waitingDays <= 7 ? 0.2 : 0);

    const w = CANDIDATE_POLICY.weights;
    const total = round3(
      capabilityScore * w.capability +
        distanceScore * w.distance +
        waitingScore * w.waiting +
        urgencyFit * w.urgencyFit,
    );

    const reasons = [
      cap.cap_level === "designated"
        ? "该病种省级/指定接诊机构，能力等级 designated"
        : `具备该病种接诊能力（${cap.cap_level}）`,
      distanceKm == null ? "发起地坐标缺失，距离按中性分处理" : `距离约 ${round3(distanceKm)} 公里`,
      `专科 ${cap.specialty} 预计候诊 ${waitingDays} 天`,
      urgentCapacity
        ? `可在 ${triageHours} 小时接诊时限内安排（${referral.urgency}）`
        : `预计候诊超过 ${triageHours} 小时接诊时限，紧急适配降分`,
    ];

    results.push({
      facility_id: facilityId,
      facility_name: facility.name,
      region_code: facility.region_code,
      disease_code: cap.disease_code,
      disease_name: cap.disease_name,
      specialty: cap.specialty,
      cap_level: cap.cap_level,
      factors: {
        capability: round3(capabilityScore),
        distance: round3(distanceScore),
        waiting: round3(waitingScore),
        urgency_fit: round3(urgencyFit),
      },
      raw: {
        distance_km: distanceKm == null ? null : round3(distanceKm),
        waiting_days: waitingDays,
        weekly_slots: schedule.weekly_slots,
        base_lead_days: schedule.base_lead_days,
      },
      weights: w,
      score: total,
      reasons,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return {
    as_of: asOf,
    urgency: referral.urgency,
    policy: CANDIDATE_POLICY,
    notice: "候选排序仅辅助医生选择接诊机构，不构成诊断结论或自动分诊决定",
    results,
    excluded,
  };
}
