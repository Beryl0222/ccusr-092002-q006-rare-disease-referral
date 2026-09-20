import { withTransaction } from "../database.js";
import { fingerprint, sha256, haversineKm } from "./crypto-util.js";
import { toIso, addHours, SLA_HOURS, REQUIRED_DOCUMENTS } from "./clock.js";
import {
  AppError,
  ValidationError,
  MaterialIncompleteError,
  NotFoundError,
  ConflictError,
  AuthorizationError,
  ConsentError,
} from "./errors.js";

// 候选评分权重（对外公开，保证可解释）。
const WEIGHTS = { capability: 0.4, distance: 0.3, wait: 0.3 };
const GENETIC_MATCH_BONUS = 10;
const URGENCY_WAIT_FACTOR = { routine: 0, priority: 10, urgent: 25 };

export class NetworkService {
  constructor(db, clock = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  nowIso() {
    return toIso(this.clock());
  }

  // ---------------------------------------------------------------
  // 审计（access_audit 只增）
  // ---------------------------------------------------------------
  audit({ actor, action, referralId = null, patientId = null, scope = null, granted, reason = null }) {
    this.db.prepare(`
      INSERT INTO access_audit
        (actor_facility_id, actor_user, action, referral_id, patient_id, scope, granted, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actor?.facilityId ?? null,
      actor?.userId ?? null,
      action,
      referralId,
      patientId,
      scope,
      granted ? 1 : 0,
      reason,
    );
  }

  // ---------------------------------------------------------------
  // 主数据：机构
  // ---------------------------------------------------------------
  registerFacility(input) {
    const f = this.#requireFields(input, ["id", "name", "level", "regionCode"]);
    if (!["provincial", "city", "primary"].includes(f.level)) {
      throw new ValidationError("level 必须是 provincial | city | primary");
    }
    const exists = this.db.prepare("SELECT id FROM facilities WHERE id=?").get(f.id);
    if (exists) throw new ConflictError(`机构 ${f.id} 已存在`);
    this.db.prepare(`
      INSERT INTO facilities (id, name, level, region_code, lat, lon)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(f.id, f.name, f.level, f.regionCode, input.lat ?? null, input.lon ?? null);
    return this.getFacility(f.id);
  }

  getFacility(id) {
    const row = this.db.prepare("SELECT * FROM facilities WHERE id=?").get(id);
    if (!row) throw new NotFoundError(`机构 ${id} 不存在`);
    return this.#mapFacility(row);
  }

  #mapFacility(r) {
    return {
      id: r.id, name: r.name, level: r.level, regionCode: r.region_code,
      lat: r.lat, lon: r.lon, active: !!r.active,
    };
  }

  // ---------------------------------------------------------------
  // 主数据：人口版本（只追加）
  // ---------------------------------------------------------------
  addPopulationVersion(input, actor) {
    const v = this.#requireFields(input, ["regionCode", "population"]);
    const info = this.db.prepare(`
      INSERT INTO region_population_versions (region_code, population, is_target_city, effective_at, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      v.regionCode,
      v.population,
      input.isTargetCity ? 1 : 0,
      input.effectiveAt ?? this.nowIso(),
      actor?.userId ?? "unknown",
    );
    return this.getPopulationVersion(Number(info.lastInsertRowid));
  }

  getPopulationVersion(id) {
    const r = this.db.prepare("SELECT * FROM region_population_versions WHERE id=?").get(id);
    if (!r) throw new NotFoundError("人口版本不存在");
    return this.#mapPopVersion(r);
  }

  #mapPopVersion(r) {
    return {
      id: r.id, regionCode: r.region_code, population: r.population,
      isTargetCity: !!r.is_target_city, effectiveAt: r.effective_at,
      createdBy: r.created_by,
    };
  }

  // 某时刻有效的人口版本（effective_at <= asOf 的最新一行）。
  effectivePopulation(regionCode, asOf = this.nowIso()) {
    const r = this.db.prepare(`
      SELECT * FROM region_population_versions
      WHERE region_code=? AND effective_at<=?
      ORDER BY effective_at DESC, id DESC LIMIT 1
    `).get(regionCode, asOf);
    return r ? this.#mapPopVersion(r) : null;
  }

  // ---------------------------------------------------------------
  // 主数据：资质 / 病种能力 / 排班（均只追加）
  // ---------------------------------------------------------------
  addQualificationVersion(input, actor) {
    const v = this.#requireFields(input, ["facilityId", "qualificationType", "status"]);
    this.getFacility(v.facilityId);
    if (!["granted", "suspended", "revoked", "expired"].includes(v.status)) {
      throw new ValidationError("资质状态非法");
    }
    const info = this.db.prepare(`
      INSERT INTO qualification_versions (facility_id, qualification_type, status, effective_at, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(v.facilityId, v.qualificationType, v.status, input.effectiveAt ?? this.nowIso(), actor?.userId ?? "unknown");
    return Number(info.lastInsertRowid);
  }

  addCapabilityVersion(input, actor) {
    const v = this.#requireFields(input, ["facilityId", "diseaseCode", "diseaseName", "canAccept"]);
    this.getFacility(v.facilityId);
    const info = this.db.prepare(`
      INSERT INTO disease_capability_versions
        (facility_id, disease_code, disease_name, can_accept, genetics_enabled, effective_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      v.facilityId, v.diseaseCode, v.diseaseName,
      v.canAccept ? 1 : 0,
      input.geneticsEnabled ? 1 : 0,
      input.effectiveAt ?? this.nowIso(),
      actor?.userId ?? "unknown",
    );
    return Number(info.lastInsertRowid);
  }

  addScheduleVersion(input, actor) {
    const v = this.#requireFields(input, ["facilityId", "specialty", "weekday", "slotStart", "slotEnd", "seatsPerWeek"]);
    this.getFacility(v.facilityId);
    if (v.weekday < 0 || v.weekday > 6) throw new ValidationError("weekday 取值 0-6");
    if (v.seatsPerWeek <= 0) throw new ValidationError("seatsPerWeek 必须为正");
    const info = this.db.prepare(`
      INSERT INTO schedule_versions
        (facility_id, specialty, weekday, slot_start, slot_end, seats_per_week, effective_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      v.facilityId, v.specialty, v.weekday, v.slotStart, v.slotEnd,
      v.seatsPerWeek, input.effectiveAt ?? this.nowIso(), actor?.userId ?? "unknown",
    );
    return Number(info.lastInsertRowid);
  }

  // 某时刻机构资质是否有效（最新一行状态为 granted）。
  isFacilityQualified(facilityId, asOf = this.nowIso()) {
    const r = this.db.prepare(`
      SELECT status FROM qualification_versions
      WHERE facility_id=? AND effective_at<=?
      ORDER BY effective_at DESC, id DESC LIMIT 1
    `).get(facilityId, asOf);
    return r?.status === "granted";
  }

  #effectiveCapability(facilityId, diseaseCode, asOf) {
    return this.db.prepare(`
      SELECT * FROM disease_capability_versions
      WHERE facility_id=? AND disease_code=? AND effective_at<=?
      ORDER BY effective_at DESC, id DESC LIMIT 1
    `).get(facilityId, diseaseCode, asOf) ?? null;
  }

  // 某时刻某专科当前有效排班（同一 专科/星期/时段 取最新版本）。
  #effectiveSchedules(facilityId, specialty, asOf) {
    return this.db.prepare(`
      SELECT * FROM schedule_versions
      WHERE id IN (
        SELECT max(id) FROM schedule_versions
        WHERE facility_id=? AND specialty=? AND effective_at<=?
        GROUP BY specialty, weekday, slot_start
      )
    `).all(facilityId, specialty, asOf);
  }

  // ---------------------------------------------------------------
  // 患者假名（去标识、跨院指纹去重）
  // ---------------------------------------------------------------
  #upsertPatient(input, sourceFacilityId) {
    const token = input.patientToken;
    if (!token) throw new ValidationError("缺少 patientToken（患者假名）");
    const fp = input.identityFingerprint
      ?? fingerprint(token, input.sex ?? "", input.birthYear ?? "");
    const existingByToken = this.db.prepare("SELECT * FROM patients WHERE patient_token=?").get(token);
    let patientId;
    let linked = false;
    if (existingByToken) {
      patientId = existingByToken.id;
    } else {
      const info = this.db.prepare(`
        INSERT INTO patients (patient_token, fingerprint, sex, birth_year, first_seen_facility_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(token, fp, input.sex ?? null, input.birthYear ?? null, sourceFacilityId);
      patientId = Number(info.lastInsertRowid);
      linked = true;
    }
    return { patientId, fingerprint: fp, created: linked };
  }

  // 可能重复的患者：身份指纹相同但假名不同。
  findPotentialPatients(identityFingerprint) {
    return this.db.prepare(`
      SELECT id, patient_token, sex, birth_year, first_seen_facility_id, created_at
      FROM patients WHERE fingerprint=? ORDER BY id
    `).all(identityFingerprint);
  }

  // ---------------------------------------------------------------
  // 授权（含遗传/基因检测更严格范围与撤回）
  // ---------------------------------------------------------------
  grantConsent(input, actor) {
    const sourceFacilityId = actor?.facilityId ?? this.#requireFields(input, ["facilityId"]).facilityId;
    this.getFacility(sourceFacilityId);
    const { patientId } = this.#upsertPatient(
      {
        patientToken: input.patientToken,
        identityFingerprint: input.identityFingerprint,
        sex: input.sex, birthYear: input.birthYear,
      },
      sourceFacilityId,
    );
    const scope = input.scope ?? "referral-summary";
    if (!["referral-summary", "genetic"].includes(scope)) throw new ValidationError("授权范围非法");
    const info = this.db.prepare(`
      INSERT INTO consents
        (patient_id, scope, granted_by_facility_id, permitted_facility_ids, purpose, granted_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      patientId, scope, sourceFacilityId,
      (input.permittedFacilityIds ?? []).join(","),
      input.purpose ?? "rare-disease-referral",
      input.grantedAt ?? this.nowIso(),
      input.expiresAt ?? null,
    );
    const consentId = Number(info.lastInsertRowid);
    this.audit({ actor, action: "consent_grant", patientId, scope, granted: true });
    return { consentId, patientId, scope };
  }

  #activeConsent(patientId, scope, facilityId, at) {
    const rows = this.db.prepare(`
      SELECT * FROM consents
      WHERE patient_id=? AND scope=? AND status='active'
        AND granted_at<=? AND (expires_at IS NULL OR expires_at>?)
      ORDER BY id DESC
    `).all(patientId, scope, at, at);
    return rows.find((c) => {
      if (c.granted_by_facility_id === facilityId) return true;
      const permitted = c.permitted_facility_ids ? c.permitted_facility_ids.split(",") : [];
      return permitted.includes(facilityId);
    }) ?? null;
  }

  // 撤回授权：阻止新读取；业务事实与历史审计保留。
  withdrawConsent(input, actor) {
    const { consentId, reason } = this.#requireFields(input, ["consentId"]);
    return withTransaction(this.db, () => {
      const consent = this.db.prepare("SELECT * FROM consents WHERE id=?").get(consentId);
      if (!consent) throw new NotFoundError("授权不存在");
      if (consent.status !== "active") throw new ConflictError("授权已撤回或失效");
      this.db.prepare(`
        UPDATE consents SET status='withdrawn', withdrawn_at=?, withdrawn_by=?, reason=? WHERE id=?
      `).run(this.nowIso(), actor?.userId ?? null, reason ?? null, consentId);
      this.audit({
        actor, action: "consent_withdraw", patientId: consent.patient_id,
        scope: consent.scope, granted: true, reason: reason ?? null,
      });
      return { consentId, status: "withdrawn", scope: consent.scope };
    });
  }

  // ---------------------------------------------------------------
  // 转诊提交（校验材料、识别重复、幂等）
  // ---------------------------------------------------------------
  submitReferral(input, actor) {
    const sourceFacilityId = actor?.facilityId ?? input.sourceFacility;
    if (!sourceFacilityId) throw new ValidationError("缺少发起机构身份");
    this.getFacility(sourceFacilityId);
    const idemKey = input.idempotencyKey;
    return withTransaction(this.db, () => {
      // 幂等检查与写入放在同一事务，避免并发重复提交同时穿过检查。
      if (idemKey) {
        const seen = this.db.prepare("SELECT * FROM idempotency WHERE key=?").get(idemKey);
        if (seen) {
          return { referralId: seen.response_ref, replayed: true, note: "重复提交已幂等拦截" };
        }
      }
      const now = this.nowIso();
      const { patientId, fingerprint: fp } = this.#upsertPatient({
        patientToken: input.patientToken,
        identityFingerprint: input.identityFingerprint,
        sex: input.sex, birthYear: input.birthYear,
      }, sourceFacilityId);

      // 授权校验：普通摘要需要 referral-summary；遗传材料额外需要 genetic。
      const summaryConsent = this.#activeConsent(patientId, "referral-summary", sourceFacilityId, now);
      if (!summaryConsent) {
        this.audit({ actor, action: "submit", patientId, scope: "referral-summary", granted: false, reason: "no_consent" });
        throw new ConsentError("提交转诊前必须取得患者 referral-summary 授权", "missing_referral_consent");
      }
      const docs = Array.isArray(input.documents) ? input.documents : [];
      const containsGenetic = docs.some((d) => d.isGenetic) || !!input.containsGeneticMaterial;
      if (containsGenetic) {
        const geneticConsent = this.#activeConsent(patientId, "genetic", sourceFacilityId, now);
        if (!geneticConsent) {
          this.audit({ actor, action: "submit", patientId, scope: "genetic", granted: false, reason: "no_genetic_consent" });
          throw new ConsentError("遗传/基因检测资料需要患者单独的 genetic 授权", "missing_genetic_consent");
        }
      }

      // 必要材料校验（按病种分类的基线清单）。
      const category = input.suspectedCategory ?? "default";
      const required = REQUIRED_DOCUMENTS[category] ?? REQUIRED_DOCUMENTS.default;
      const presentTypes = new Set(docs.map((d) => d.docType));
      const missing = required.filter((t) => !presentTypes.has(t));
      if (missing.length) {
        this.audit({ actor, action: "submit", patientId, granted: false, reason: "material_incomplete" });
        throw new MaterialIncompleteError(missing);
      }

      // 可能重复的患者（同指纹不同假名）。
      const duplicatePatients = this.db.prepare(`
        SELECT patient_token, first_seen_facility_id FROM patients
        WHERE fingerprint=? AND id<>?
      `).all(fp, patientId);

      // 可能重复的检查与重复转诊（同患者 + 同内容哈希 / 同检查指纹）。
      const duplicateExams = [];
      const duplicateReferrals = [];
      for (const doc of docs) {
        if (doc.content != null) {
          const hash = doc.contentHash ?? sha256(JSON.stringify(doc.content));
          const hit = this.db.prepare(`
            SELECT r.id AS referral_id, rd.doc_type, rd.submitted_by_facility_id
            FROM referral_documents rd JOIN referrals r ON r.id = rd.referral_id
            WHERE rd.content_hash=? AND r.patient_id=?
            ORDER BY rd.id LIMIT 5
          `).get(hash, patientId);
          if (hit) duplicateReferrals.push({ docType: doc.docType, referralId: hit.referral_id, facility: hit.submitted_by_facility_id });
        }
        for (const exam of doc.exams ?? []) {
          const examFp = fingerprint(fp, exam.examType, exam.examCode, exam.examDate ?? "");
          const hit = this.db.prepare(`
            SELECT source_facility_id, exam_type, exam_code, exam_date FROM exam_fingerprints
            WHERE fingerprint=? LIMIT 5
          `).all(examFp);
          if (hit.length) duplicateExams.push(...hit.map((h) => ({ examType: h.exam_type, examCode: h.exam_code, examDate: h.exam_date, facility: h.source_facility_id })));
        }
      }

      const referralId = input.referralId ?? this.#generateReferralId(now);
      const dupId = this.db.prepare("SELECT id FROM referrals WHERE id=?").get(referralId);
      if (dupId) throw new ConflictError(`转诊单 ${referralId} 已存在（疑似重复提交）`);

      this.db.prepare(`
        INSERT INTO referrals
          (id, patient_id, source_facility_id, current_holder_facility_id,
           suspected_disease_code, suspected_category, urgency, status,
           material_complete, contains_genetic_material, created_at, updated_at, version)
        VALUES (?, ?, ?, NULL, ?, ?, ?, 'submitted', 1, ?, ?, ?, 0)
      `).run(
        referralId, patientId, sourceFacilityId,
        input.suspectedDiseaseCode ?? null, category,
        ["routine", "priority", "urgent"].includes(input.urgency) ? input.urgency : "routine",
        containsGenetic ? 1 : 0, now, now,
      );

      for (const doc of docs) {
        const hash = doc.contentHash ?? (doc.content != null ? sha256(JSON.stringify(doc.content)) : null);
        this.db.prepare(`
          INSERT INTO referral_documents
            (referral_id, doc_type, is_genetic, content_hash, content, submitted_by_facility_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(referralId, doc.docType, doc.isGenetic ? 1 : 0, hash,
          doc.content != null ? JSON.stringify(doc.content) : null, sourceFacilityId);
        for (const exam of doc.exams ?? []) {
          this.db.prepare(`
            INSERT INTO exam_fingerprints
              (patient_id, exam_type, exam_code, exam_date, fingerprint, source_facility_id)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            patientId, exam.examType, exam.examCode, exam.examDate ?? null,
            fingerprint(fp, exam.examType, exam.examCode, exam.examDate ?? ""),
            sourceFacilityId,
          );
        }
      }

      this.#insertEvent(referralId, {
        eventType: "submitted", toStatus: "submitted",
        actor, responsibleFacilityId: sourceFacilityId,
        payload: { urgency: input.urgency ?? "routine", duplicatePatients, duplicateExams, duplicateReferrals },
      }, now);

      if (idemKey) {
        this.db.prepare(`
          INSERT INTO idempotency (key, request_hash, response_ref) VALUES (?, ?, ?)
        `).run(idemKey, sha256(JSON.stringify(this.#idemStable(input))), referralId);
      }
      this.audit({ actor, action: "submit", referralId, patientId, granted: true });

      return {
        referralId, status: "submitted", patientId,
        warnings: {
          possibleDuplicatePatients: duplicatePatients,
          possibleDuplicateExams: dedupe(duplicateExams),
          possibleDuplicateReferrals: dedupe(duplicateReferrals),
        },
      };
    });
  }

  #idemStable(input) {
    const { idempotencyKey, ...rest } = input;
    return rest;
  }

  #generateReferralId(now) {
    const d = now.slice(0, 10).replace(/-/g, "");
    const rand = this.db.prepare("SELECT hex(randomblob(4)) AS r").get().r.toLowerCase();
    return `ref-${d}-${rand}`;
  }

  // ---------------------------------------------------------------
  // 候选机构（可解释：能力/距离/候诊/紧急度；只推荐，不诊断）
  // ---------------------------------------------------------------
  generateCandidates(referralId, actor, asOf = this.nowIso()) {
    const referral = this.#requireReferral(referralId);
    const source = this.getFacility(referral.source_facility_id);
    const specialty = referral.suspected_category;
    const candidates = [];
    const facilities = this.db.prepare("SELECT * FROM facilities WHERE active=1 AND id<>?").all(referral.source_facility_id);

    for (const fr of facilities) {
      const f = this.#mapFacility(fr);
      const explanation = [];
      if (!this.isFacilityQualified(f.id, asOf)) {
        explanation.push("该机构在此时点无有效罕见病门诊资质");
        continue;
      }
      const cap = this.#effectiveCapability(f.id, referral.suspected_disease_code, asOf);
      if (!cap || !cap.can_accept) {
        explanation.push(`不具备病种 ${referral.suspected_disease_code ?? "(未填)"} 的接诊能力`);
        continue;
      }
      explanation.push(`具备病种 ${cap.disease_name}（${cap.disease_code}）当前有效接诊能力`);

      if (referral.contains_genetic_material && !cap.genetics_enabled) {
        explanation.push("注意：含遗传资料但该机构不具备遗传/基因检测条件，仅可在授权范围内查看非遗传内容");
      }

      const slots = this.#effectiveSchedules(f.id, specialty, asOf);
      const seatsPerWeek = slots.reduce((s, x) => s + x.seats_per_week, 0);
      if (seatsPerWeek <= 0) {
        explanation.push(`专科「${specialty}」当前无有效坐诊排班，服务不可达`);
        continue;
      }
      const openLoad = this.db.prepare(`
        SELECT count(*) AS c FROM tasks
        WHERE responsible_facility_id=? AND status='open'
          AND task_type IN ('accept','mdt','transfer')
      `).get(f.id).c;
      const waitDays = (7 * (openLoad + 1)) / seatsPerWeek;
      explanation.push(`当前周座位 ${seatsPerWeek}，在途待办 ${openLoad}，估算候诊 ${waitDays.toFixed(1)} 天`);

      const distance = haversineKm(source, f);
      explanation.push(distance == null ? "距离未知（缺少坐标）" : `距发起机构约 ${distance.toFixed(1)} 公里`);

      const distanceScore = distance == null ? 50 : 100 / (1 + distance / 50);
      const waitScore = 100 / (1 + waitDays / 7);
      const urgencyBonus = (URGENCY_WAIT_FACTOR[referral.urgency] ?? 0) / (1 + waitDays / 3);
      let capabilityScore = 100;
      if (referral.contains_genetic_material && cap.genetics_enabled) {
        capabilityScore += GENETIC_MATCH_BONUS;
        explanation.push("具备遗传/基因检测条件，匹配遗传资料接诊需求");
      }
      explanation.push(`紧急度 ${referral.urgency}：候诊越短加分越高（+${urgencyBonus.toFixed(1)}）`);

      const total =
        WEIGHTS.capability * capabilityScore +
        WEIGHTS.distance * distanceScore +
        WEIGHTS.wait * waitScore +
        urgencyBonus;

      candidates.push({
        facilityId: f.id, facilityName: f.name, level: f.level, regionCode: f.regionCode,
        total: Number(total.toFixed(2)),
        capabilityMatch: 1,
        distanceKm: distance == null ? null : Number(distance.toFixed(1)),
        estimatedWaitDays: Number(waitDays.toFixed(1)),
        urgencyBonus: Number(urgencyBonus.toFixed(2)),
        explanations: explanation,
      });
    }

    candidates.sort((a, b) => b.total - a.total || a.facilityId.localeCompare(b.facilityId));
    candidates.forEach((c, i) => (c.rank = i + 1));

    const popVersion = this.effectivePopulation(source.regionCode, asOf);
    const info = this.db.prepare(`
      INSERT INTO candidate_snapshots (referral_id, generated_at, as_of_population_version)
      VALUES (?, ?, ?)
    `).run(referralId, asOf, popVersion?.id ?? null);
    const snapshotId = Number(info.lastInsertRowid);
    const insItem = this.db.prepare(`
      INSERT INTO candidate_items
        (snapshot_id, facility_id, rank, total_score, capability_match, distance_km,
         estimated_wait_days, urgency_bonus, explanations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of candidates) {
      insItem.run(snapshotId, c.facilityId, c.rank, c.total, 1, c.distanceKm,
        c.estimatedWaitDays, c.urgencyBonus, JSON.stringify(c.explanations));
    }
    this.audit({ actor, action: "generate_candidates", referralId, patientId: referral.patient_id, granted: true });
    return {
      referralId, asOf, snapshotId,
      note: "候选仅依据病种能力、距离、候诊时间与紧急度排序，供医生参考，不构成诊断或自动派单",
      candidates,
    };
  }

  // ---------------------------------------------------------------
  // 工作流：派单 / 接诊 / 补料 / 退回 / 会诊 / 转接 / 随访
  // ---------------------------------------------------------------
  #requireReferral(id) {
    const r = this.db.prepare("SELECT * FROM referrals WHERE id=?").get(id);
    if (!r) throw new NotFoundError(`转诊单 ${id} 不存在`);
    return r;
  }

  #insertEvent(referralId, e, at = this.nowIso()) {
    const info = this.db.prepare(`
      INSERT INTO referral_events
        (referral_id, event_type, from_status, to_status, actor_facility_id, actor_user,
         responsible_facility_id, responsible_user, due_at, executed_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      referralId, e.eventType, e.fromStatus ?? null, e.toStatus ?? null,
      e.actor?.facilityId ?? null, e.actor?.userId ?? null,
      e.responsibleFacilityId ?? null, e.responsibleUser ?? null,
      e.dueAt ?? null, at, e.payload ? JSON.stringify(e.payload) : null,
    );
    return Number(info.lastInsertRowid);
  }

  #createTask(referralId, eventId, taskType, facilityId, userId, dueAt) {
    this.db.prepare(`
      INSERT INTO tasks (referral_id, event_id, task_type, responsible_facility_id, responsible_user, due_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(referralId, eventId, taskType, facilityId, userId, dueAt);
  }

  #closeOpenTasks(referralId, taskType, resultEventId) {
    this.db.prepare(`
      UPDATE tasks SET status='done', result_event_id=?
      WHERE referral_id=? AND task_type=? AND status IN ('open','overdue')
    `).run(resultEventId, referralId, taskType);
  }

  // 乐观锁状态流转（自带事务，供单步操作使用）。
  #transition(referral, opts) {
    return withTransaction(this.db, () => {
      const cur = this.db.prepare("SELECT * FROM referrals WHERE id=?").get(referral.id);
      return this.#applyTransition(cur, opts);
    });
  }

  // 事务内应用状态流转；复合流程（要同时写任务/会诊等）必须在一个 withTransaction 内调用。
  #applyTransition(cur, { allow, to, actor, eventType, taskType = null, targetFacilityId = null, payload = null, dueAt = null, responsibleFacilityId = null, responsibleUserId = null }) {
    const now = this.nowIso();
    if (!allow.includes(cur.status)) {
      throw new ConflictError(`转诊单当前状态 ${cur.status}，不能执行 ${eventType}`);
    }
    const result = this.db.prepare(`
      UPDATE referrals
        SET status=?, current_holder_facility_id=COALESCE(?, current_holder_facility_id),
            updated_at=?, version=version+1
      WHERE id=? AND version=?
    `).run(to, targetFacilityId, now, cur.id, cur.version);
    if (result.changes === 0) {
      throw new ConflictError("转诊单已被并发操作更新，请刷新后重试");
    }
    const eventId = this.#insertEvent(cur.id, {
      eventType, fromStatus: cur.status, toStatus: to, actor,
      responsibleFacilityId: responsibleFacilityId ?? targetFacilityId ?? cur.current_holder_facility_id,
      responsibleUser: responsibleUserId ?? actor?.userId ?? null,
      dueAt, payload,
    }, now);
    if (taskType) this.#closeOpenTasks(cur.id, taskType, eventId);
    this.audit({ actor, action: eventType, referralId: cur.id, patientId: cur.patient_id, granted: true });
    return { eventId, version: cur.version + 1, status: to, at: now };
  }

  // 医生从候选中选定机构派单（系统不自动派单）。
  routeReferral(referralId, input, actor) {
    const referral = this.#requireReferral(referralId);
    const { facilityId } = this.#requireFields(input ?? {}, ["facilityId"]);
    this.getFacility(facilityId);
    const asOf = this.nowIso();
    if (!this.isFacilityQualified(facilityId, asOf)) throw new ConflictError("目标机构无有效资质");
    if (referral.suspected_disease_code) {
      const cap = this.#effectiveCapability(facilityId, referral.suspected_disease_code, asOf);
      if (!cap?.can_accept) throw new ConflictError("目标机构不具备该病种接诊能力");
    }
    if (referral.contains_genetic_material &&
        !this.#activeConsent(referral.patient_id, "genetic", facilityId, asOf)) {
      throw new ConsentError("向该机构流转遗传资料前，须先取得覆盖该机构的 genetic 授权", "genetic_consent_not_permitted");
    }
    const result = this.#transition(referral, {
      allow: ["submitted"], to: "routed", actor, eventType: "routed",
      targetFacilityId: facilityId,
      responsibleFacilityId: facilityId,
      dueAt: addHours(asOf, SLA_HOURS.accept[referral.urgency]),
    });
    this.#createTask(referralId, result.eventId, "accept", facilityId, actor?.userId ?? null, result.at ? addHours(result.at, SLA_HOURS.accept[referral.urgency]) : result.dueAt);
    return result;
  }

  acceptReferral(referralId, actor) {
    const referral = this.#requireReferral(referralId);
    if (actor.facilityId !== referral.current_holder_facility_id) {
      this.audit({ actor, action: "accept", referralId, patientId: referral.patient_id, granted: false, reason: "not_holder" });
      throw new AuthorizationError("只有当前被派单/转接的机构可以接诊");
    }
    return this.#transition(referral, {
      allow: ["routed", "transferred"], to: "accepted", actor, eventType: "accepted",
      taskType: "accept",
    });
  }

  requestSupplement(referralId, input, actor) {
    const referral = this.#requireReferral(referralId);
    if (actor.facilityId !== referral.current_holder_facility_id) throw new AuthorizationError("只有接诊机构可要求补充材料");
    const body = input ?? {};
    const docTypes = body.docTypes ?? [];
    if (!docTypes.length) throw new ValidationError("需指明补充材料类型 docTypes");
    const dueAt = addHours(this.nowIso(), SLA_HOURS.supplement[referral.urgency]);
    const result = this.#transition(referral, {
      allow: ["accepted", "consultation"], to: "awaiting_materials", actor, eventType: "supplement_requested",
      payload: { docTypes, note: body.note ?? null },
      responsibleFacilityId: referral.source_facility_id,
      dueAt,
    });
    this.#createTask(referralId, result.eventId, "supplement", referral.source_facility_id, null, addHours(result.at, SLA_HOURS.supplement[referral.urgency]));
    return result;
  }

  submitSupplement(referralId, input, actor) {
    const referral = this.#requireReferral(referralId);
    if (actor.facilityId !== referral.source_facility_id) throw new AuthorizationError("只有发起机构可补充材料");
    const docs = input?.documents ?? [];
    if (!docs.length) throw new ValidationError("缺少补充材料 documents");
    return withTransaction(this.db, () => {
      const now = this.nowIso();
      const hasGenetic = docs.some((d) => d.isGenetic);
      if (hasGenetic && !this.#activeConsent(referral.patient_id, "genetic", actor.facilityId, now)) {
        this.audit({ actor, action: "read_genetic", referralId, patientId: referral.patient_id, scope: "genetic", granted: false, reason: "withdrawn_or_missing" });
        throw new ConsentError("遗传材料补充需要有效 genetic 授权", "missing_genetic_consent");
      }
      for (const doc of docs) {
        const hash = doc.contentHash ?? (doc.content != null ? sha256(JSON.stringify(doc.content)) : null);
        this.db.prepare(`
          INSERT INTO referral_documents (referral_id, doc_type, is_genetic, content_hash, content, submitted_by_facility_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(referralId, doc.docType, doc.isGenetic ? 1 : 0, hash,
          doc.content != null ? JSON.stringify(doc.content) : null, actor.facilityId);
      }
      const cur = this.db.prepare("SELECT * FROM referrals WHERE id=?").get(referralId);
      const result = this.#applyTransition(cur, {
        allow: ["awaiting_materials"], to: "accepted", actor, eventType: "supplement_submitted",
        taskType: "supplement", payload: { docTypes: docs.map((d) => d.docType) },
        targetFacilityId: referral.current_holder_facility_id,
      });
      return result;
    });
  }

  returnReferral(referralId, input, actor) {
    const referral = this.#requireReferral(referralId);
    if (actor.facilityId !== referral.current_holder_facility_id) throw new AuthorizationError("只有接诊机构可退回");
    const result = this.#transition(referral, {
      allow: ["routed", "accepted", "awaiting_materials", "consultation", "transferred"],
      to: "returned", actor, eventType: "returned",
      payload: { reason: input?.reason ?? null },
      responsibleFacilityId: referral.source_facility_id,
      dueAt: addHours(this.nowIso(), SLA_HOURS.notify_return),
    });
    // 退回后终止未完成待办，并给发起机构建退回告知时限任务。
    this.db.prepare("UPDATE tasks SET status='cancelled' WHERE referral_id=? AND status IN ('open','overdue')").run(referralId);
    this.#createTask(referralId, result.eventId, "return", referral.source_facility_id, null, addHours(result.at, SLA_HOURS.notify_return));
    return result;
  }

  // 多学科会诊：申请 -> 排期（统一反馈时限开始）-> 完成反馈。
  requestConsultation(referralId, input, actor) {
    const referral = this.#requireReferral(referralId);
    if (actor.facilityId !== referral.current_holder_facility_id) throw new AuthorizationError("只有接诊机构可发起会诊");
    return withTransaction(this.db, () => {
      const info = this.db.prepare(`
        INSERT INTO consultations (referral_id, requested_by_facility_id, participants, status)
        VALUES (?, ?, ?, 'requested')
      `).run(referralId, actor.facilityId, JSON.stringify(input?.participants ?? []));
      const consultationId = Number(info.lastInsertRowid);
      const cur = this.db.prepare("SELECT * FROM referrals WHERE id=?").get(referralId);
      const result = this.#applyTransition(cur, {
        allow: ["accepted"], to: "consultation", actor, eventType: "consultation_requested",
        payload: { consultationId, participants: input?.participants ?? [] },
        dueAt: addHours(this.nowIso(), SLA_HOURS.mdt_schedule),
      });
      this.#createTask(referralId, result.eventId, "mdt", actor.facilityId, actor.userId ?? null, addHours(result.at, SLA_HOURS.mdt_schedule));
      return { consultationId, ...result };
    });
  }

  scheduleConsultation(consultationId, input, actor) {
    const c = this.db.prepare("SELECT * FROM consultations WHERE id=?").get(consultationId);
    if (!c) throw new NotFoundError("会诊不存在");
    if (c.status !== "requested") throw new ConflictError("会诊已排期或结束");
    const scheduledAt = this.#requireFields(input ?? {}, ["scheduledAt"]).scheduledAt;
    return withTransaction(this.db, () => {
      this.db.prepare("UPDATE consultations SET status='scheduled', scheduled_at=? WHERE id=?").run(scheduledAt, consultationId);
      const eventId = this.#insertEvent(c.referral_id, {
        eventType: "consultation_scheduled", fromStatus: "consultation", toStatus: "consultation",
        actor, payload: { consultationId, scheduledAt },
      });
      // 排期待办办结；会诊完成后统一反馈另有时限（自排期时间起 mdt_feedback 小时）。
      const closeRes = this.db.prepare(`
        UPDATE tasks SET status='done', result_event_id=?
        WHERE referral_id=? AND task_type='mdt' AND status IN ('open','overdue')
      `).run(eventId, c.referral_id);
      const feedbackDue = new Date(new Date(scheduledAt).getTime() + SLA_HOURS.mdt_feedback * 3600_000).toISOString();
      this.#createTask(c.referral_id, eventId, "mdt_feedback", c.requested_by_facility_id, actor.userId ?? null, feedbackDue);
      this.audit({ actor, action: "consultation_scheduled", referralId: c.referral_id, granted: true });
      return { consultationId, status: "scheduled", scheduledAt, feedbackDue };
    });
  }

  completeConsultation(consultationId, input, actor) {
    const c = this.db.prepare("SELECT * FROM consultations WHERE id=?").get(consultationId);
    if (!c) throw new NotFoundError("会诊不存在");
    if (!["scheduled", "requested"].includes(c.status)) throw new ConflictError("会诊状态不可完成");
    const referral = this.#requireReferral(c.referral_id);
    return withTransaction(this.db, () => {
      const now = this.nowIso();
      this.db.prepare("UPDATE consultations SET status='completed', feedback=?, feedback_at=? WHERE id=?")
        .run(input?.feedback ?? null, now, consultationId);
      const cur = this.db.prepare("SELECT * FROM referrals WHERE id=?").get(c.referral_id);
      const result = this.#applyTransition(cur, {
        allow: ["consultation"], to: "accepted", actor, eventType: "consultation_completed",
        taskType: "mdt_feedback", payload: { consultationId, feedback: input?.feedback ?? null },
      });
      // 未排期直接完成的情形也一并关闭 mdt 待办。
      this.db.prepare(`
        UPDATE tasks SET status='done', result_event_id=?
        WHERE referral_id=? AND task_type='mdt' AND status IN ('open','overdue')
      `).run(result.eventId, c.referral_id);
      return { consultationId, ...result };
    });
  }

  // 跨院转接：责任与接诊时限转移到目标机构。
  transferReferral(referralId, input, actor) {
    const referral = this.#requireReferral(referralId);
    if (actor.facilityId !== referral.current_holder_facility_id) throw new AuthorizationError("只有当前接诊机构可跨院转接");
    const { facilityId } = this.#requireFields(input ?? {}, ["facilityId"]);
    this.getFacility(facilityId);
    if (!this.isFacilityQualified(facilityId)) throw new ConflictError("目标机构无有效资质");
    if (referral.contains_genetic_material &&
        !this.#activeConsent(referral.patient_id, "genetic", facilityId, this.nowIso())) {
      throw new ConsentError("向该机构转接遗传资料前，须先取得覆盖该机构的 genetic 授权", "genetic_consent_not_permitted");
    }
    const result = this.#transition(referral, {
      allow: ["accepted", "consultation"], to: "transferred", actor, eventType: "transferred",
      targetFacilityId: facilityId,
      dueAt: addHours(this.nowIso(), SLA_HOURS.accept[referral.urgency]),
      payload: { reason: input?.reason ?? null },
    });
    this.db.prepare("UPDATE tasks SET status='cancelled' WHERE referral_id=? AND status IN ('open','overdue')").run(referralId);
    this.#createTask(referralId, result.eventId, "accept", facilityId, null, addHours(result.at, SLA_HOURS.accept[referral.urgency]));
    return result;
  }

  // 随访：每次尝试留痕；多次未达可标记失联（终态）。
  scheduleFollowup(referralId, input, actor) {
    const referral = this.#requireReferral(referralId);
    const scheduledAt = input?.scheduledAt ?? addHours(this.nowIso(), SLA_HOURS.followup);
    return withTransaction(this.db, () => {
      const attemptNo = (this.db.prepare("SELECT coalesce(max(attempt_no),0)+1 AS n FROM followups WHERE referral_id=?").get(referralId).n);
      this.db.prepare("INSERT INTO followups (referral_id, attempt_no, scheduled_at) VALUES (?, ?, ?)")
        .run(referralId, attemptNo, scheduledAt);
      const eventId = this.#insertEvent(referralId, {
        eventType: "followup_scheduled", actor, payload: { attemptNo, scheduledAt },
        responsibleFacilityId: referral.current_holder_facility_id ?? referral.source_facility_id,
      });
      this.#createTask(referralId, eventId, "followup",
        referral.current_holder_facility_id ?? referral.source_facility_id, null, scheduledAt);
      this.audit({ actor, action: "followup_scheduled", referralId, patientId: referral.patient_id, granted: true });
      return { attemptNo, scheduledAt };
    });
  }

  recordFollowup(referralId, input, actor) {
    const referral = this.#requireReferral(referralId);
    const reached = !!input?.reached;
    return withTransaction(this.db, () => {
      const row = this.db.prepare(`
        SELECT * FROM followups WHERE referral_id=? AND reached_at IS NULL
        ORDER BY attempt_no DESC LIMIT 1
      `).get(referralId);
      if (!row) throw new ConflictError("没有待反馈的随访安排");
      const now = this.nowIso();
      this.db.prepare("UPDATE followups SET reached_at=?, result=? WHERE id=?")
        .run(now, reached ? "reached" : "lost", row.id);
      const eventId = this.#insertEvent(referralId, {
        eventType: reached ? "followup_reached" : "followup_attempt_lost",
        actor, payload: { attemptNo: row.attempt_no, note: input?.note ?? null },
      });
      this.#closeOpenTasks(referralId, "followup", eventId);
      const cur = this.db.prepare("SELECT * FROM referrals WHERE id=?").get(referralId);
      if (!reached && (input?.markLost || row.attempt_no >= 3)) {
        return this.#applyTransition(cur, {
          allow: ["accepted", "transferred", "consultation", "awaiting_materials"],
          to: "lost_to_followup", actor, eventType: "lost_to_followup",
          payload: { attemptNo: row.attempt_no, note: input?.note ?? null },
        });
      }
      if (reached) {
        return this.#applyTransition(cur, {
          allow: ["accepted", "transferred", "consultation", "awaiting_materials"],
          to: "completed", actor, eventType: "completed",
          payload: { attemptNo: row.attempt_no },
        });
      }
      this.audit({ actor, action: "followup_recorded", referralId, patientId: referral.patient_id, granted: true });
      return { attemptNo: row.attempt_no, result: "lost", status: cur.status };
    });
  }

  // ---------------------------------------------------------------
  // 读取（授权门控 + 审计；遗传资料更严格）
  // ---------------------------------------------------------------
  #canReadReferral(referral, actor, at = this.nowIso()) {
    if (actor?.role === "regulator") return { ok: true, asRegulator: true };
    const fid = actor?.facilityId;
    if (!fid) return { ok: false, reason: "no_identity" };
    if (fid === referral.source_facility_id || fid === referral.current_holder_facility_id) return { ok: true };
    const consent = this.#activeConsent(referral.patient_id, "referral-summary", fid, at);
    return consent ? { ok: true } : { ok: false, reason: "no_consent" };
  }

  getReferralView(referralId, actor) {
    const referral = this.#requireReferral(referralId);
    const access = this.#canReadReferral(referral, actor);
    if (!access.ok) {
      this.audit({ actor, action: "read_referral", referralId, patientId: referral.patient_id, granted: false, reason: access.reason });
      throw new AuthorizationError("无权查看该转诊");
    }
    this.audit({ actor, action: "read_referral", referralId, patientId: referral.patient_id, granted: true });
    const docs = this.db.prepare("SELECT * FROM referral_documents WHERE referral_id=? ORDER BY id").all(referralId);
    const at = this.nowIso();
    const documents = docs.map((d) => {
      const base = {
        id: d.id, docType: d.doc_type, isGenetic: !!d.is_genetic,
        contentHash: d.content_hash, submittedByFacilityId: d.submitted_by_facility_id,
      };
      if (!d.is_genetic) return { ...base, content: d.content ? JSON.parse(d.content) : null };
      // 遗传资料：需要有效 genetic 授权；撤回后一律拒绝新读取。
      const allowed = actor.role === "regulator"
        ? false
        : !!this.#activeConsent(referral.patient_id, "genetic", actor.facilityId, at);
      this.audit({
        actor, action: "read_genetic", referralId, patientId: referral.patient_id,
        scope: "genetic", granted: allowed,
        reason: allowed ? null : "genetic_consent_missing_or_withdrawn",
      });
      return allowed
        ? { ...base, content: d.content ? JSON.parse(d.content) : null }
        : { ...base, content: null, restricted: true, reason: "需 genetic 授权；授权撤回或未覆盖本机构" };
    });
    const events = this.getTimeline(referralId);
    const tasks = this.db.prepare("SELECT * FROM tasks WHERE referral_id=? ORDER BY id").all(referralId)
      .map((t) => ({
        id: t.id, type: t.task_type, responsibleFacilityId: t.responsible_facility_id,
        responsibleUser: t.responsible_user, dueAt: t.due_at, status: t.status,
      }));
    return {
      id: referral.id,
      patientId: referral.patient_id,
      sourceFacilityId: referral.source_facility_id,
      currentHolderFacilityId: referral.current_holder_facility_id,
      suspectedDiseaseCode: referral.suspected_disease_code,
      suspectedCategory: referral.suspected_category,
      urgency: referral.urgency,
      status: referral.status,
      materialComplete: !!referral.material_complete,
      containsGeneticMaterial: !!referral.contains_genetic_material,
      version: referral.version,
      createdAt: referral.created_at,
      updatedAt: referral.updated_at,
      documents,
      tasks,
      timeline: events,
    };
  }

  getTimeline(referralId) {
    return this.db.prepare(`
      SELECT id, event_type, from_status, to_status, actor_facility_id, actor_user,
             responsible_facility_id, responsible_user, due_at, executed_at, payload
      FROM referral_events WHERE referral_id=? ORDER BY id
    `).all(referralId).map((e) => ({
      id: e.id,
      type: e.event_type,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      actorFacilityId: e.actor_facility_id,
      actorUser: e.actor_user,
      responsibleFacilityId: e.responsible_facility_id,
      responsibleUser: e.responsible_user,
      dueAt: e.due_at,
      executedAt: e.executed_at,
      payload: e.payload ? JSON.parse(e.payload) : null,
    }));
  }

  // ---------------------------------------------------------------
  // 监管：as-of 覆盖缺口 / 转诊积压 / 超时
  // ---------------------------------------------------------------

  // 地区覆盖缺口：目标地市（按 asOf 有效人口口径认定）是否拥有可达门诊
  // （有效资质 + 至少一个可接诊病种 + 专科坐诊）。历史时点用历史版本判断。
  coverageGap(asOf = this.nowIso()) {
    const regions = this.db.prepare(`
      SELECT * FROM region_population_versions v
      WHERE id = (SELECT max(id) FROM region_population_versions
                  WHERE region_code = v.region_code AND effective_at<=?)
        AND is_target_city=1
      ORDER BY v.region_code
    `).all(asOf);

    const report = regions.map((v) => {
      const facilities = this.db.prepare("SELECT * FROM facilities WHERE region_code=? AND active=1").all(v.region_code);
      const reachable = [];
      for (const fr of facilities) {
        if (!this.isFacilityQualified(fr.id, asOf)) continue;
        const caps = this.db.prepare(`
          SELECT * FROM disease_capability_versions
          WHERE id IN (SELECT max(id) FROM disease_capability_versions
                       WHERE facility_id=? AND effective_at<=? GROUP BY disease_code)
            AND can_accept=1
        `).all(fr.id, asOf);
        if (!caps.length) continue;
        const seats = this.db.prepare(`
          SELECT coalesce(sum(seats_per_week),0) AS s FROM schedule_versions
          WHERE id IN (SELECT max(id) FROM schedule_versions
                       WHERE facility_id=? AND effective_at<=? GROUP BY specialty, weekday, slot_start)
        `).get(fr.id, asOf).s;
        if (seats <= 0) continue;
        reachable.push({ facilityId: fr.id, name: fr.name, diseases: caps.map((c) => c.disease_code), seatsPerWeek: seats });
      }
      return {
        regionCode: v.region_code,
        population: v.population,
        populationVersionId: v.id,
        covered: reachable.length > 0,
        gapReason: reachable.length > 0 ? null : "无同时具备有效资质、可接诊病种与坐诊排班的机构",
        reachableFacilities: reachable,
      };
    });

    const provincial = this.db.prepare("SELECT * FROM facilities WHERE level='provincial' AND active=1").all();
    const provincialReady = provincial.filter((f) => {
      if (!this.isFacilityQualified(f.id, asOf)) return false;
      const caps = this.db.prepare(`
        SELECT count(*) AS c FROM disease_capability_versions
        WHERE id IN (SELECT max(id) FROM disease_capability_versions
                     WHERE facility_id=? AND effective_at<=? GROUP BY disease_code)
          AND can_accept=1
      `).get(f.id, asOf).c;
      return caps > 0;
    }).map((f) => f.id);

    const targetPopulation = report.reduce((s, r) => s + r.population, 0);
    const coveredPopulation = report.filter((r) => r.covered).reduce((s, r) => s + r.population, 0);
    return {
      asOf,
      targetCities: report,
      uncoveredRegions: report.filter((r) => !r.covered).map((r) => r.regionCode),
      provincialReadyFacilities: provincialReady,
      targetPopulation,
      coveredPopulation,
      coverageRate: targetPopulation ? Number((coveredPopulation / targetPopulation).toFixed(4)) : null,
    };
  }

  // as-of 状态：取 executed_at <= asOf 的最后一个事件的 to_status。
  #statusAt(referralId, asOf) {
    const r = this.db.prepare("SELECT created_at FROM referrals WHERE id=?").get(referralId);
    if (!r || r.created_at > asOf) return null;
    const e = this.db.prepare(`
      SELECT to_status FROM referral_events
      WHERE referral_id=? AND executed_at<=? AND to_status IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `).get(referralId, asOf);
    return e?.to_status ?? "submitted";
  }

  // 转诊积压：asOf 时点仍未进入终态的转诊（状态由事件历史还原）。
  backlog(asOf = this.nowIso()) {
    const rows = this.db.prepare("SELECT id, urgency, source_facility_id, current_holder_facility_id, created_at FROM referrals WHERE created_at<=?").all(asOf);
    const items = [];
    for (const r of rows) {
      const status = this.#statusAt(r.id, asOf);
      if (status && !["returned", "completed", "lost_to_followup"].includes(status)) {
        items.push({ referralId: r.id, status, urgency: r.urgency, holderFacilityId: r.current_holder_facility_id, ageHours: Number(((new Date(asOf) - new Date(r.created_at)) / 3600_000).toFixed(1)) });
      }
    }
    const byStatus = {};
    for (const i of items) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
    return { asOf, total: items.length, byStatus, items: items.sort((a, b) => b.ageHours - a.ageHours) };
  }

  // 超时：asOf 时点已到时限且未在时限前办结的任务（办结时间取结果事件 executed_at）。
  overdue(asOf = this.nowIso()) {
    const tasks = this.db.prepare(`
      SELECT t.*, e.executed_at AS resolved_at FROM tasks t
      LEFT JOIN referral_events e ON e.id = t.result_event_id
      WHERE t.due_at<=?
      ORDER BY t.due_at
    `).all(asOf);
    const items = [];
    for (const t of tasks) {
      if (t.status === "cancelled") continue;
      const resolvedInTime = t.resolved_at && t.resolved_at <= asOf && t.resolved_at <= t.due_at;
      const resolvedLate = t.resolved_at && (t.resolved_at > t.due_at);
      if (resolvedInTime) continue;
      items.push({
        referralId: t.referral_id,
        taskType: t.task_type,
        responsibleFacilityId: t.responsible_facility_id,
        responsibleUser: t.responsible_user,
        dueAt: t.due_at,
        overdueHours: Number(((new Date(asOf) - new Date(t.due_at)) / 3600_000).toFixed(1)),
        status: resolvedLate ? "resolved_late" : (t.status === "done" ? "done" : "open"),
      });
    }
    const byFacility = {};
    for (const i of items) {
      byFacility[i.responsibleFacilityId] ??= { count: 0, overdueHours: 0 };
      byFacility[i.responsibleFacilityId].count += 1;
      byFacility[i.responsibleFacilityId].overdueHours += i.overdueHours;
    }
    return { asOf, total: items.length, byFacility, items };
  }

  // 审计查询（监管）。
  queryAudit({ referralId, patientId, scope, action, limit = 200 } = {}) {
    const where = [];
    const params = {};
    if (referralId) { where.push("referral_id = @referralId"); params.referralId = referralId; }
    if (patientId) { where.push("patient_id = @patientId"); params.patientId = Number(patientId); }
    if (scope) { where.push("scope = @scope"); params.scope = scope; }
    if (action) { where.push("action = @action"); params.action = action; }
    const sql = `SELECT * FROM access_audit ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${Number(limit)}`;
    return this.db.prepare(sql).all(params).map((r) => ({
      id: r.id, actorFacilityId: r.actor_facility_id, actorUser: r.actor_user,
      action: r.action, referralId: r.referral_id, patientId: r.patient_id,
      scope: r.scope, granted: !!r.granted, reason: r.reason, at: r.at,
    }));
  }

  // ---------------------------------------------------------------
  // 服务重启恢复（幂等）：超时扫描 + 一致性检查修复
  // ---------------------------------------------------------------
  recover(now = this.nowIso()) {
    return withTransaction(this.db, () => {
      const unfinished = this.db.prepare(`
        SELECT run_token, at FROM recovery_log WHERE phase='started'
          AND run_token NOT IN (SELECT run_token FROM recovery_log WHERE phase='finished')
      `).all();

      // 1) 到点未办的任务标记 overdue。
      const overdueRes = this.db.prepare(`
        UPDATE tasks SET status='overdue'
        WHERE status='open' AND due_at<=?
      `).run(now);
      const tasksOverdueMarked = overdueRes.changes;

      // 2) 一致性检查与修复。
      const repairs = [];

      // 2a) routed/transferred 但持有机构没有未完成接诊任务：按事件中的 due_at 补建。
      const stuck = this.db.prepare(`
        SELECT r.id AS rid, r.status, r.current_holder_facility_id AS holder, r.urgency,
               (SELECT due_at FROM referral_events WHERE referral_id=r.id AND due_at IS NOT NULL
                ORDER BY id DESC LIMIT 1) AS last_due
        FROM referrals r
        WHERE r.status IN ('routed','transferred')
          AND NOT EXISTS (
            SELECT 1 FROM tasks t WHERE t.referral_id=r.id AND t.task_type='accept'
              AND t.status IN ('open','overdue')
          )
      `).all();
      for (const s of stuck) {
        const due = s.last_due ?? addHours(now, SLA_HOURS.accept[s.urgency]);
        this.db.prepare(`
          INSERT INTO tasks (referral_id, task_type, responsible_facility_id, due_at, status)
          VALUES (?, 'accept', ?, ?, CASE WHEN ? > ? THEN 'overdue' ELSE 'open' END)
        `).run(s.rid, s.holder, due, now, due);
        repairs.push({ type: "recreate_missing_accept_task", referralId: s.rid });
      }

      // 2b) 终态转诊仍挂着开放任务：取消。
      const dangling = this.db.prepare(`
        UPDATE tasks SET status='cancelled'
        WHERE status IN ('open','overdue')
          AND referral_id IN (SELECT id FROM referrals WHERE status IN ('returned','completed','lost_to_followup'))
      `).run();
      if (dangling.changes) repairs.push({ type: "cancel_dangling_tasks", count: dangling.changes });

      // 2c) 事件链检查：每张转诊单必须有 submitted 事件（只报告，无法凭空补造业务事实）。
      const noEvent = this.db.prepare(`
        SELECT r.id FROM referrals r
        WHERE NOT EXISTS (SELECT 1 FROM referral_events e WHERE e.referral_id=r.id AND e.event_type='submitted')
      `).all();
      for (const x of noEvent) repairs.push({ type: "missing_submitted_event", referralId: x.rid, repaired: false });

      const runToken = `run-${this.db.prepare("SELECT hex(randomblob(6)) AS r").get().r.toLowerCase()}`;
      const detail = JSON.stringify({ previousInterruptedRuns: unfinished.map((u) => u.run_token), repairs });
      this.db.prepare(`
        INSERT INTO recovery_log (run_token, phase, tasks_overdue_marked, inconsistent_repaired, detail, at)
        VALUES (?, 'started', ?, ?, ?, ?)
      `).run(runToken, tasksOverdueMarked, repairs.length, detail, now);
      this.db.prepare(`
        INSERT INTO recovery_log (run_token, phase, tasks_overdue_marked, inconsistent_repaired, detail, at)
        VALUES (?, 'finished', ?, ?, ?, ?)
      `).run(runToken, tasksOverdueMarked, repairs.length, detail, now);

      return {
        runToken, asOf: now,
        tasksOverdueMarked,
        repairs,
        previousRunInterrupted: unfinished.length > 0,
        previousInterruptedRuns: unfinished.map((u) => u.run_token),
      };
    });
  }

  // ---------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------
  #requireFields(input, fields) {
    const out = {};
    const missing = [];
    for (const f of fields) {
      if (input?.[f] === undefined || input?.[f] === null || input?.[f] === "") missing.push(f);
      out[f] = input[f];
    }
    if (missing.length) throw new ValidationError(`缺少必填字段：${missing.join(", ")}`);
    return out;
  }
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
