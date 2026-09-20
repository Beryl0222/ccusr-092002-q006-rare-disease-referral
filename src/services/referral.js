import { createId, nowIso, sha256, transaction, isoHoursLater } from "../util.js";
import { ValidationError, NotFoundError, ConflictError, AuthorizationError } from "../errors.js";
import { documentRule, urgencyTriageHours, urgencyTransferHours, FOLLOW_UP_FAILURE_LIMIT } from "../policy.js";
import { appendEvent, listEvents, replayState } from "./events.js";
import { findSuspectedPatients, findSuspectedChecks, rankCandidates } from "./matching.js";

const SUBMITTABLE_STATUSES = new Set(["submitted", "transfer_requested"]);

export class ReferralService {
  constructor(db, { registry, authz, clock = nowIso } = {}) {
    this.db = db;
    this.registry = registry;
    this.authz = authz;
    this.clock = clock;
  }

  // ---------- 提交 ----------

  submit(input) {
    const ts = this.clock();
    const sourceFacilityId = req(input.source_facility_id, "source_facility_id");
    if (!this.registry.getFacility(sourceFacilityId, ts)) {
      throw new ValidationError(`发起机构 ${sourceFacilityId} 不存在或在该时点无有效登记`);
    }
    const authId = req(input.auth_id ?? input.patient_authorization_id, "auth_id");
    const urgency = ["routine", "priority", "urgent"].includes(input.urgency) ? input.urgency : "routine";
    const category = req(input.suspected_category, "suspected_category");
    const documents = Array.isArray(input.documents) ? input.documents : [];
    const checks = Array.isArray(input.checks) ? input.checks : [];

    // 先做授权判定（允许/拒绝都入审计），再做幂等与重复提交判定，避免未授权探测
    this.authz.authorizeAccess({
      authId,
      facilityId: sourceFacilityId,
      user: input.submitter,
      role: "primary_clinician",
      scope: "referral_summary",
      action: "submit",
      resourceId: authId,
    });

    // 幂等：相同键直接返回原转诊；同源同负载识别为重复提交
    const idempotencyKey = input.idempotency_key ? String(input.idempotency_key) : null;
    const payloadHash = sha256(canonicalJson(stripKey(input)));
    if (idempotencyKey) {
      const existing = this.db
        .prepare("SELECT * FROM referrals WHERE idempotency_key = ?")
        .get(idempotencyKey);
      if (existing) {
        this.#recordAttempt({ idempotencyKey, referralId: existing.referral_id, sourceFacilityId, payloadHash, result: "duplicate", reasons: ["idempotency_key 重复"] });
        return { ...this.getReferral(existing.referral_id), duplicate: true, duplicate_reason: "idempotency_key" };
      }
    }
    const samePayload = this.db
      .prepare(
        `SELECT referral_id FROM submission_attempts
         WHERE source_facility_id = ? AND payload_hash = ? AND result = 'accepted'
         ORDER BY occurred_at DESC LIMIT 1`,
      )
      .get(sourceFacilityId, payloadHash);
    if (samePayload) {
      this.#recordAttempt({ idempotencyKey, referralId: samePayload.referral_id, sourceFacilityId, payloadHash, result: "duplicate", reasons: ["与已接受提交负载相同"] });
      return { ...this.getReferral(samePayload.referral_id), duplicate: true, duplicate_reason: "same_payload" };
    }

    const reasons = [];
    const rule = documentRule(category);
    const presentTypes = new Set(documents.map((d) => d.doc_type));
    for (const required of rule.required) {
      if (!presentTypes.has(required)) reasons.push(`缺少必要材料：${required}`);
    }
    for (const doc of documents) {
      if (!doc.doc_type || !doc.content_ref) {
        reasons.push("材料缺少 doc_type 或 content_ref");
        continue;
      }
      const isGenetic = doc.is_genetic === true || rule.genetic.includes(doc.doc_type);
      if (isGenetic) {
        const verdict = this.authz.canAccess(authId, sourceFacilityId, "genetic_results", ts);
        if (!verdict.allowed) {
          reasons.push(`基因材料 ${doc.doc_type} 被拒绝：${verdict.reason}`);
          this.authz.audit({
            authId, referralId: null, actorFacilityId: sourceFacilityId, actorUser: input.submitter,
            resourceType: "genetic_results", resourceId: doc.content_ref, action: "submit",
            decision: "deny", reason: verdict.reason,
          });
        }
      }
    }
    for (const check of checks) {
      if (!check.check_code || !check.check_name || !check.check_date) {
        reasons.push("检查记录缺少 check_code/check_name/check_date");
      } else if (!/^\d{4}-\d{2}-\d{2}$/.test(check.check_date)) {
        reasons.push(`检查日期格式必须为 YYYY-MM-DD：${check.check_date}`);
      }
    }
    if (reasons.length > 0) {
      this.#recordAttempt({ idempotencyKey, referralId: null, sourceFacilityId, payloadHash, result: "rejected", reasons });
      throw new ValidationError("转诊材料校验未通过", reasons);
    }

    const referralId = input.referral_id ?? createId("ref");
    const triageDue = isoHoursLater(ts, urgencyTriageHours(urgency));

    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO referrals
             (referral_id, idempotency_key, source_facility_id, patient_token, auth_id,
              birth_year, gender, residence_region_code, contact_hash, phenotype_codes_json,
              first_visit_date, suspected_category, suspected_disease_code, urgency,
              origin_lat, origin_lng, status, open_phase, sla_due_at, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', 'triage', ?, 1, ?, ?)`,
        )
        .run(
          referralId,
          idempotencyKey,
          sourceFacilityId,
          req(input.patient_token, "patient_token"),
          authId,
          input.birth_year ?? null,
          input.gender ?? null,
          input.residence_region_code ?? null,
          input.contact_hash ?? null,
          JSON.stringify(input.phenotype_codes ?? []),
          input.first_visit_date ?? null,
          category,
          input.suspected_disease_code ?? null,
          urgency,
          numOrNull(input.origin_lat),
          numOrNull(input.origin_lng),
          triageDue,
          ts,
          ts,
        );

      for (const doc of documents) {
        const isGenetic = doc.is_genetic === true || rule.genetic.includes(doc.doc_type);
        this.db
          .prepare(
            `INSERT INTO referral_documents
               (document_id, referral_id, doc_type, is_genetic, content_ref, checksum, supplied_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ) .run(
            createId("doc"), referralId, doc.doc_type, isGenetic ? 1 : 0,
            doc.content_ref, doc.checksum ?? null, sourceFacilityId, ts,
          );
      }
      for (const check of checks) {
        this.db
          .prepare(
            `INSERT INTO referral_checks
               (check_id, referral_id, check_code, check_name, check_date, facility_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(createId("chk"), referralId, check.check_code, check.check_name,
            check.check_date, check.facility_id ?? sourceFacilityId, ts);
      }

      appendEvent(this.db, {
        referral_id: referralId,
        event_type: "submitted",
        actor_facility_id: sourceFacilityId,
        actor_user: input.submitter,
        from_status: null,
        to_status: "submitted",
        open_phase: "triage",
        sla_due_at: triageDue,
        assignee_facility_id: null,
        payload: { urgency, triage_sla_hours: urgencyTriageHours(urgency) },
        recorded_at: ts,
      });
      this.#recordAttempt({ idempotencyKey, referralId, sourceFacilityId, payloadHash, result: "accepted", reasons: [] });
    });

    // 重复识别在事务后执行并独立落库（疑似结果不阻断业务）
    const result = this.getReferral(referralId);
    this.#detectDuplicates(result, ts);
    return this.getReferral(referralId);
  }

  #detectDuplicates(referral, asOf) {
    const patientHits = findSuspectedPatients(this.db, referral);
    for (const hit of patientHits) {
      this.db
        .prepare(
          `INSERT INTO suspected_duplicate_patients
             (duplicate_id, referral_id, other_referral_id, score, reasons_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'suspected', ?)`,
        )
        .run(createId("dup"), referral.referral_id, hit.referral_id, hit.score, JSON.stringify(hit.reasons), asOf);
    }
    const linkedIds = patientHits.map((h) => h.referral_id);
    if (referral.patient_token) {
      const sameToken = this.db
        .prepare("SELECT referral_id FROM referrals WHERE patient_token = ? AND referral_id <> ?")
        .all(referral.patient_token, referral.referral_id)
        .map((r) => r.referral_id);
      linkedIds.push(...sameToken);
    }
    const checks = this.db
      .prepare("SELECT check_code, check_name, check_date FROM referral_checks WHERE referral_id = ?")
      .all(referral.referral_id);
    const checkHits = findSuspectedChecks(this.db, referral, [...new Set(linkedIds)], checks, asOf);
    for (const hit of checkHits) {
      this.db
        .prepare(
          `INSERT INTO suspected_duplicate_checks
             (dup_check_id, referral_id, other_referral_id, check_code, check_date, other_date, days_apart, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'suspected', ?)`,
        )
        .run(createId("dupc"), referral.referral_id, hit.referral_id, hit.check_code,
          hit.check_date, hit.other_date, hit.days_apart, asOf);
    }
    return { patients: patientHits, checks: checkHits };
  }

  // ---------- 候选机构 ----------

  generateCandidates(referralId) {
    const ts = this.clock();
    const referral = this.#requireReferral(referralId);
    const ranked = rankCandidates(this.db, this.registry, referral, ts);
    const snapshotId = createId("snap");
    this.db
      .prepare(
        `INSERT INTO candidate_snapshots (snapshot_id, referral_id, generated_at, urgency, origin_lat, origin_lng, results_json, excluded_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshotId, referralId, ts, referral.urgency,
        referral.origin_lat ?? null, referral.origin_lng ?? null,
        JSON.stringify(ranked.results), JSON.stringify(ranked.excluded),
      );
    return { snapshot_id: snapshotId, ...ranked };
  }

  selectCandidate(referralId, input) {
    const ts = this.clock();
    const referral = this.#requireReferral(referralId);
    const snapshotId = req(input.snapshot_id, "snapshot_id");
    const facilityId = req(input.facility_id, "facility_id");
    const snapshot = this.db
      .prepare("SELECT * FROM candidate_snapshots WHERE snapshot_id = ? AND referral_id = ?")
      .get(snapshotId, referralId);
    if (!snapshot) throw new NotFoundError("候选快照不存在或不属于该转诊");
    const results = JSON.parse(snapshot.results_json);
    if (!results.some((r) => r.facility_id === facilityId)) {
      throw new ValidationError("所选机构不在该快照候选集中（可能已不可接诊，请重新生成候选）");
    }
    const state = replayState(this.db, referralId, ts);
    if (state.status !== "submitted") {
      throw new ConflictError(`转诊当前状态 ${state.status}，不能再指派候选`);
    }
    if (!this.#canServe(facilityId, referral, ts)) {
      throw new ConflictError("该机构当前已不具备该病种接诊能力");
    }
    return transaction(this.db, () => {
      const triageDue = state.sla_due_at;
      const assignmentId = createId("asgn");
      this.db
        .prepare(
          `INSERT INTO referral_assignments
             (assignment_id, referral_id, facility_id, requested_by, requested_at, deadline_at, status, version)
           VALUES (?, ?, ?, ?, ?, ?, 'requested', 1)`,
        )
        .run(assignmentId, referralId, facilityId, input.selected_by ?? referral.source_facility_id, ts, triageDue);
      this.#touch(referralId, ts, "submitted", "triage", triageDue, facilityId);
      appendEvent(this.db, {
        referral_id: referralId, event_type: "assignment_requested",
        actor_facility_id: referral.source_facility_id, actor_user: input.selected_by,
        from_status: "submitted", to_status: "submitted",
        open_phase: "triage", sla_due_at: triageDue, assignee_facility_id: facilityId,
        payload: { snapshot_id: snapshotId, assignment_id: assignmentId }, recorded_at: ts,
      });
      return { assignment_id: assignmentId, deadline_at: triageDue };
    });
  }

  // ---------- 接诊 / 退回 ----------

  accept(referralId, input) {
    const ts = this.clock();
    const facilityId = req(input.facility_id, "facility_id");
    const referral = this.#requireReferral(referralId);
    const state = replayState(this.db, referralId, ts);

    if (state.status === "accepted" || state.status === "mdt_requested" || state.status === "mdt_scheduled") {
      if (state.current_holder_facility_id === facilityId) {
        throw new ConflictError("本机构已接诊该转诊");
      }
      throw new ConflictError(`转诊已被 ${state.current_holder_facility_id} 接诊`);
    }
    if (state.is_terminal) throw new ConflictError(`转诊已终结（${state.status}）`);
    if (!SUBMITTABLE_STATUSES.has(state.status)) {
      throw new ConflictError(`状态 ${state.status} 下不能接诊`);
    }
    if (!this.#canServe(facilityId, referral, ts)) {
      throw new ConflictError("本机构当前不具备该病种有效资质或接诊能力");
    }
    if (state.status === "transfer_requested") {
      const pending = this.#pendingTransfer(referralId);
      if (!pending || pending.to_facility_id !== facilityId) {
        throw new ConflictError("仅转接目标机构可以接诊");
      }
      if (Date.parse(pending.deadline_at) < Date.parse(ts)) {
        this.#expireTransfer(pending, ts);
        throw new ConflictError("转接响应已超时，转诊退回原机构，请重新发起转接");
      }
    }
    const assignment = this.db
      .prepare(
        `SELECT * FROM referral_assignments
         WHERE referral_id = ? AND facility_id = ? AND status = 'requested'
         ORDER BY requested_at DESC LIMIT 1`,
      )
      .get(referralId, facilityId);
    if (state.status === "submitted" && state.assignee_facility_id && state.assignee_facility_id !== facilityId) {
      const open = this.db
        .prepare(
          `SELECT deadline_at FROM referral_assignments
           WHERE referral_id = ? AND facility_id = ? AND status = 'requested'
           ORDER BY requested_at DESC LIMIT 1`,
        )
        .get(referralId, state.assignee_facility_id);
      if (open && Date.parse(open.deadline_at) >= Date.parse(ts)) {
        throw new ConflictError(
          `转诊已指派给 ${state.assignee_facility_id}，须待其接诊或拒绝邀请`,
        );
      }
    }

    return transaction(this.db, () => {
      const changed = this.db
        .prepare(
          `UPDATE referrals SET status = 'accepted', current_holder_facility_id = ?,
             assignee_facility_id = ?, open_phase = NULL, sla_due_at = NULL,
             version = version + 1, updated_at = ?
           WHERE referral_id = ? AND status IN ('submitted','transfer_requested')`,
        )
        .run(facilityId, facilityId, ts, referralId).changes;
      if (changed === 0) {
        // 并发接诊竞争失败：另一方已先行接诊
        const winner = replayState(this.db, referralId, ts);
        throw new ConflictError(`并发接诊冲突，已由 ${winner.current_holder_facility_id ?? "其他机构"} 接诊`);
      }
      if (state.status === "transfer_requested") {
        const pending = this.#pendingTransfer(referralId);
        this.db.prepare("UPDATE transfers SET status = 'accepted', responded_at = ?, version = version + 1 WHERE transfer_id = ?")
          .run(ts, pending.transfer_id);
        appendEvent(this.db, {
          referral_id: referralId, event_type: "transfer_accepted",
          actor_facility_id: facilityId, actor_user: input.user,
          from_status: "transfer_requested", to_status: "accepted",
          payload: { transfer_id: pending.transfer_id }, recorded_at: ts,
        });
      } else {
        appendEvent(this.db, {
          referral_id: referralId, event_type: "accepted",
          actor_facility_id: facilityId, actor_user: input.user,
          from_status: "submitted", to_status: "accepted",
          payload: { assignment_id: assignment?.assignment_id ?? null }, recorded_at: ts,
        });
      }
      this.db
        .prepare("UPDATE referral_assignments SET status = 'superseded', version = version + 1 WHERE referral_id = ? AND status = 'requested'")
        .run(referralId);
      if (assignment) {
        this.db.prepare("UPDATE referral_assignments SET status = 'accepted', responded_at = ?, version = version + 1 WHERE assignment_id = ?")
          .run(ts, assignment.assignment_id);
      }
      return this.getReferral(referralId);
    });
  }

  declineAssignment(assignmentId, input) {
    const ts = this.clock();
    const row = this.db.prepare("SELECT * FROM referral_assignments WHERE assignment_id = ?").get(assignmentId);
    if (!row) throw new NotFoundError("接诊邀请不存在");
    if (row.status !== "requested") throw new ConflictError(`邀请状态为 ${row.status}`);
    if (row.facility_id !== input.facility_id) throw new AuthorizationError("仅被邀请机构可拒绝该邀请");
    return transaction(this.db, () => {
      this.db.prepare("UPDATE referral_assignments SET status = 'declined', responded_at = ?, version = version + 1 WHERE assignment_id = ? AND status = 'requested'")
        .run(ts, assignmentId);
      appendEvent(this.db, {
        referral_id: row.referral_id, event_type: "assignment_declined",
        actor_facility_id: row.facility_id, actor_user: input.user,
        from_status: "submitted", to_status: "submitted",
        open_phase: "triage", sla_due_at: row.deadline_at, assignee_facility_id: null,
        payload: { reason: input.reason ?? null, assignment_id: assignmentId }, recorded_at: ts,
      });
      this.#touch(row.referral_id, ts, "submitted", "triage", row.deadline_at, null);
      return { status: "declined" };
    });
  }

  returnReferral(referralId, input) {
    const ts = this.clock();
    const referral = this.#requireReferral(referralId);
    const state = this.#requireHolder(referralId, input.facility_id, ts);
    if (!["accepted", "mdt_requested", "mdt_scheduled"].includes(state.status)) {
      throw new ConflictError(`状态 ${state.status} 下不能退回`);
    }
    return transaction(this.db, () => {
      this.db
        .prepare("UPDATE referrals SET status = 'returned', open_phase = NULL, sla_due_at = NULL, assignee_facility_id = NULL, version = version + 1, updated_at = ? WHERE referral_id = ?")
        .run(ts, referralId);
      appendEvent(this.db, {
        referral_id: referralId, event_type: "returned",
        actor_facility_id: input.facility_id, actor_user: input.user,
        from_status: state.status, to_status: "returned",
        payload: { reason: req(input.reason, "reason") }, recorded_at: ts,
      });
      return this.getReferral(referralId);
    });
  }

  complete(referralId, input) {
    const ts = this.clock();
    const state = this.#requireHolder(referralId, input.facility_id, ts);
    if (!["accepted", "mdt_scheduled"].includes(state.status)) {
      throw new ConflictError(`状态 ${state.status} 下不能完结`);
    }
    return transaction(this.db, () => {
      this.db
        .prepare("UPDATE referrals SET status = 'completed', open_phase = NULL, sla_due_at = NULL, version = version + 1, updated_at = ? WHERE referral_id = ?")
        .run(ts, referralId);
      appendEvent(this.db, {
        referral_id: referralId, event_type: "completed",
        actor_facility_id: input.facility_id, actor_user: input.user,
        from_status: state.status, to_status: "completed",
        payload: { note: input.note ?? null }, recorded_at: ts,
      });
      return this.getReferral(referralId);
    });
  }

  // ---------- 补充材料 ----------

  requestSupplement(referralId, input) {
    const ts = this.clock();
    const referral = this.#requireReferral(referralId);
    const state = this.#requireHolder(referralId, input.facility_id, ts);
    if (state.status !== "accepted") throw new ConflictError(`状态 ${state.status} 下不能要求补材`);
    const missing = Array.isArray(input.missing_documents) ? input.missing_documents : [];
    if (missing.length === 0) throw new ValidationError("missing_documents 不能为空");
    const due = isoHoursLater(ts, 48);
    return transaction(this.db, () => {
      this.db
        .prepare("UPDATE referrals SET status = 'pending_supplement', open_phase = 'supplement', sla_due_at = ?, assignee_facility_id = ?, version = version + 1, updated_at = ? WHERE referral_id = ?")
        .run(due, referral.source_facility_id, ts, referralId);
      appendEvent(this.db, {
        referral_id: referralId, event_type: "supplement_requested",
        actor_facility_id: input.facility_id, actor_user: input.user,
        from_status: "accepted", to_status: "pending_supplement",
        open_phase: "supplement", sla_due_at: due, assignee_facility_id: referral.source_facility_id,
        payload: { missing_documents: missing, note: input.note ?? null, supplement_sla_hours: 48 },
        recorded_at: ts,
      });
      return { due_at: due };
    });
  }

  submitSupplement(referralId, input) {
    const ts = this.clock();
    const referral = this.#requireReferral(referralId);
    const state = replayState(this.db, referralId, ts);
    if (state.status !== "pending_supplement") throw new ConflictError(`状态 ${state.status} 下不能补交材料`);
    if (input.facility_id !== referral.source_facility_id) {
      throw new AuthorizationError("仅发起机构可以补交材料");
    }
    const documents = Array.isArray(input.documents) ? input.documents : [];
    if (documents.length === 0) throw new ValidationError("documents 不能为空");
    for (const doc of documents) {
      if (!doc.doc_type || !doc.content_ref) throw new ValidationError("材料缺少 doc_type 或 content_ref");
      const isGenetic = doc.is_genetic === true;
      if (isGenetic) {
        this.authz.authorizeAccess({
          authId: referral.auth_id, facilityId: input.facility_id, user: input.user,
          scope: "genetic_results", referralId, resourceId: doc.content_ref, action: "submit",
        });
      }
    }
    this.authz.authorizeAccess({
      authId: referral.auth_id, facilityId: input.facility_id, user: input.user,
      scope: "referral_summary", referralId, action: "supplement", resourceId: referralId,
    });
    const reviewDue = isoHoursLater(ts, 24);
    return transaction(this.db, () => {
      for (const doc of documents) {
        this.db
          .prepare(
            `INSERT INTO referral_documents
               (document_id, referral_id, doc_type, is_genetic, content_ref, checksum, supplied_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(createId("doc"), referralId, doc.doc_type, doc.is_genetic ? 1 : 0,
            doc.content_ref, doc.checksum ?? null, input.facility_id, ts);
      }
      this.db
        .prepare("UPDATE referrals SET status = 'accepted', open_phase = 'supplement_review', sla_due_at = ?, assignee_facility_id = ?, version = version + 1, updated_at = ? WHERE referral_id = ?")
        .run(reviewDue, state.current_holder_facility_id, ts, referralId);
      appendEvent(this.db, {
        referral_id: referralId, event_type: "documents_submitted",
        actor_facility_id: input.facility_id, actor_user: input.user,
        from_status: "pending_supplement", to_status: "accepted",
        open_phase: "supplement_review", sla_due_at: reviewDue,
        assignee_facility_id: state.current_holder_facility_id,
        payload: { doc_types: documents.map((d) => d.doc_type) }, recorded_at: ts,
      });
      return { due_at: reviewDue };
    });
  }

  // ---------- 多学科会诊 ----------

  requestMdt(referralId, input) {
    const ts = this.clock();
    const referral = this.#requireReferral(referralId);
    const state = this.#requireHolder(referralId, input.facility_id, ts);
    if (!["accepted", "mdt_scheduled"].includes(state.status)) {
      throw new ConflictError(`状态 ${state.status} 下不能发起会诊`);
    }
    const due = isoHoursLater(ts, 72);
    return transaction(this.db, () => {
      const mdtId = createId("mdt");
      this.db
        .prepare(
          `INSERT INTO mdt_consultations
             (mdt_id, referral_id, convening_facility_id, requested_at, schedule_due_at, status, version)
           VALUES (?, ?, ?, ?, ?, 'requested', 1)`,
        )
        .run(mdtId, referralId, input.facility_id, ts, due);
      this.db
        .prepare("UPDATE referrals SET status = 'mdt_requested', open_phase = 'mdt_schedule', sla_due_at = ?, version = version + 1, updated_at = ? WHERE referral_id = ?")
        .run(due, ts, referralId);
      appendEvent(this.db, {
        referral_id: referralId, event_type: "mdt_requested",
        actor_facility_id: input.facility_id, actor_user: input.user,
        from_status: state.status, to_status: "mdt_requested",
        open_phase: "mdt_schedule", sla_due_at: due, assignee_facility_id: input.facility_id,
        payload: { mdt_id: mdtId, participants: input.participants ?? [], note: input.note ?? null, schedule_sla_hours: 72 },
        recorded_at: ts,
      });
      return { mdt_id: mdtId, schedule_due_at: due };
    });
  }

  scheduleMdt(mdtId, input) {
    const ts = this.clock();
    const mdt = this.#requireMdt(mdtId);
    if (mdt.status !== "requested") throw new ConflictError(`会诊状态 ${mdt.status}`);
    if (input.facility_id !== mdt.convening_facility_id) throw new AuthorizationError("仅召集机构可排期");
    const scheduledAt = req(input.scheduled_at, "scheduled_at");
    if (Number.isNaN(Date.parse(scheduledAt))) throw new ValidationError("scheduled_at 时间无效");
    const feedbackDue = isoHoursLater(scheduledAt > ts ? scheduledAt : ts, 48);
    const referral = this.#requireReferral(mdt.referral_id);
    return transaction(this.db, () => {
      this.db
        .prepare("UPDATE mdt_consultations SET status = 'scheduled', scheduled_at = ?, version = version + 1 WHERE mdt_id = ?")
        .run(scheduledAt, mdtId);
      this.db
        .prepare("UPDATE referrals SET status = 'mdt_scheduled', open_phase = 'mdt_feedback', sla_due_at = ?, version = version + 1, updated_at = ? WHERE referral_id = ?")
        .run(feedbackDue, ts, referral.referral_id);
      appendEvent(this.db, {
        referral_id: referral.referral_id, event_type: "mdt_scheduled",
        actor_facility_id: input.facility_id, actor_user: input.user,
        from_status: "mdt_requested", to_status: "mdt_scheduled",
        open_phase: "mdt_feedback", sla_due_at: feedbackDue, assignee_facility_id: input.facility_id,
        payload: { mdt_id: mdtId, scheduled_at: scheduledAt, feedback_sla_hours: 48 }, recorded_at: ts,
      });
      return { feedback_due_at: feedbackDue };
    });
  }

  recordMdtFeedback(mdtId, input) {
    const ts = this.clock();
    const mdt = this.#requireMdt(mdtId);
    if (mdt.status !== "scheduled") throw new ConflictError(`会诊状态 ${mdt.status}，无法登记反馈`);
    if (input.facility_id !== mdt.convening_facility_id) throw new AuthorizationError("仅召集机构可登记反馈");
    return transaction(this.db, () => {
      this.db
        .prepare("UPDATE mdt_consultations SET status = 'completed', feedback = ?, feedback_recorded_at = ?, completed_at = ?, version = version + 1 WHERE mdt_id = ?")
        .run(req(input.feedback, "feedback"), ts, ts, mdtId);
      this.db
        .prepare("UPDATE referrals SET status = 'accepted', open_phase = NULL, sla_due_at = NULL, version = version + 1, updated_at = ? WHERE referral_id = ?")
        .run(ts, mdt.referral_id);
      appendEvent(this.db, {
        referral_id: mdt.referral_id, event_type: "mdt_completed",
        actor_facility_id: input.facility_id, actor_user: input.user,
        from_status: "mdt_scheduled", to_status: "accepted",
        payload: { mdt_id: mdtId, recommendation: input.recommendation ?? null }, recorded_at: ts,
      });
      return this.getReferral(mdt.referral_id);
    });
  }

  // ---------- 跨院转接 ----------

  requestTransfer(referralId, input) {
    const ts = this.clock();
    const referral = this.#requireReferral(referralId);
    const state = this.#requireHolder(referralId, input.facility_id, ts);
    if (!["accepted", "mdt_scheduled"].includes(state.status)) {
      throw new ConflictError(`状态 ${state.status} 下不能发起转接`);
    }
    const toFacilityId = req(input.to_facility_id, "to_facility_id");
    if (toFacilityId === input.facility_id) throw new ValidationError("不能转接到本机构");
    if (!this.#canServe(toFacilityId, referral, ts)) {
      throw new ConflictError("目标机构当前不具备该病种有效资质或接诊能力");
    }
    const hours = urgencyTransferHours(referral.urgency);
    const due = isoHoursLater(ts, hours);
    return transaction(this.db, () => {
      const transferId = createId("trf");
      this.db
        .prepare(
          `INSERT INTO transfers (transfer_id, referral_id, from_facility_id, to_facility_id, reason, requested_at, deadline_at, status, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', 1)`,
        )
        .run(transferId, referralId, input.facility_id, toFacilityId, input.reason ?? null, ts, due);
      this.db
        .prepare("UPDATE referrals SET status = 'transfer_requested', open_phase = 'transfer', sla_due_at = ?, assignee_facility_id = ?, version = version + 1, updated_at = ? WHERE referral_id = ?")
        .run(due, toFacilityId, ts, referralId);
      appendEvent(this.db, {
        referral_id: referralId, event_type: "transfer_requested",
        actor_facility_id: input.facility_id, actor_user: input.user,
        from_status: state.status, to_status: "transfer_requested",
        open_phase: "transfer", sla_due_at: due, assignee_facility_id: toFacilityId,
        payload: { transfer_id: transferId, to_facility_id: toFacilityId, transfer_sla_hours: hours },
        recorded_at: ts,
      });
      return { transfer_id: transferId, deadline_at: due };
    });
  }

  declineTransfer(transferId, input) {
    const ts = this.clock();
    const transfer = this.#requireTransfer(transferId);
    if (transfer.status !== "requested") throw new ConflictError(`转接状态 ${transfer.status}`);
    if (input.facility_id !== transfer.to_facility_id) throw new AuthorizationError("仅目标机构可拒绝转接");
    return transaction(this.db, () => {
      this.db.prepare("UPDATE transfers SET status = 'declined', responded_at = ?, version = version + 1 WHERE transfer_id = ?")
        .run(ts, transferId);
      this.db
        .prepare("UPDATE referrals SET status = 'accepted', current_holder_facility_id = ?, open_phase = NULL, sla_due_at = NULL, version = version + 1, updated_at = ? WHERE referral_id = ?")
        .run(transfer.from_facility_id, ts, transfer.referral_id);
      appendEvent(this.db, {
        referral_id: transfer.referral_id, event_type: "transfer_declined",
        actor_facility_id: input.facility_id, actor_user: input.user,
        from_status: "transfer_requested", to_status: "accepted",
        payload: { transfer_id: transferId, reason: input.reason ?? null }, recorded_at: ts,
      });
      return this.getReferral(transfer.referral_id);
    });
  }

  #expireTransfer(transfer, ts) {
    transaction(this.db, () => {
      this.db.prepare("UPDATE transfers SET status = 'expired', responded_at = ?, version = version + 1 WHERE transfer_id = ? AND status = 'requested'")
        .run(ts, transfer.transfer_id);
      this.db
        .prepare("UPDATE referrals SET status = 'accepted', open_phase = NULL, sla_due_at = NULL, version = version + 1, updated_at = ? WHERE referral_id = ?")
        .run(ts, transfer.referral_id);
      appendEvent(this.db, {
        referral_id: transfer.referral_id, event_type: "transfer_expired",
        actor_facility_id: null, actor_user: "system",
        from_status: "transfer_requested", to_status: "accepted",
        payload: { transfer_id: transfer.transfer_id }, recorded_at: ts,
      });
    });
  }

  // ---------- 随访与失联 ----------

  scheduleFollowUp(referralId, input) {
    const ts = this.clock();
    const referral = this.#requireReferral(referralId);
    const state = replayState(this.db, referralId, ts);
    if (input.facility_id !== referral.source_facility_id && input.facility_id !== state.current_holder_facility_id) {
      throw new AuthorizationError("仅接诊机构或发起机构可安排随访");
    }
    if (!["accepted", "completed"].includes(state.status)) {
      throw new ConflictError(`状态 ${state.status} 下不能安排随访`);
    }
    const dueAt = req(input.due_at, "due_at");
    if (Number.isNaN(Date.parse(dueAt))) throw new ValidationError("due_at 时间无效");
    return transaction(this.db, () => {
      const followUpId = createId("fu");
      this.db
        .prepare(
          `INSERT INTO follow_ups (follow_up_id, referral_id, due_at, opened_at, status, failed_count, version)
           VALUES (?, ?, ?, ?, 'scheduled', 0, 1)`,
        )
        .run(followUpId, referralId, dueAt, ts);
      this.db
        .prepare("UPDATE referrals SET status = 'follow_up', open_phase = 'follow_up', sla_due_at = ?, assignee_facility_id = ?, version = version + 1, updated_at = ? WHERE referral_id = ?")
        .run(dueAt, state.current_holder_facility_id ?? input.facility_id, ts, referralId);
      appendEvent(this.db, {
        referral_id: referralId, event_type: "follow_up_opened",
        actor_facility_id: input.facility_id, actor_user: input.user,
        from_status: state.status, to_status: "follow_up",
        open_phase: "follow_up", sla_due_at: dueAt,
        assignee_facility_id: state.current_holder_facility_id ?? input.facility_id,
        payload: { follow_up_id: followUpId }, recorded_at: ts,
      });
      return { follow_up_id: followUpId, due_at: dueAt };
    });
  }

  recordFollowUpAttempt(followUpId, input) {
    const ts = this.clock();
    const followUp = this.db.prepare("SELECT * FROM follow_ups WHERE follow_up_id = ?").get(followUpId);
    if (!followUp) throw new NotFoundError("随访不存在");
    if (!["scheduled", "failed"].includes(followUp.status)) throw new ConflictError(`随访状态 ${followUp.status}`);
    const result = input.result === "reached" ? "reached" : "failed";
    return transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO follow_up_attempts (attempt_id, follow_up_id, referral_id, result, note, actor_facility_id, actor_user, attempted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(createId("fua"), followUpId, followUp.referral_id, result, input.note ?? null,
          input.facility_id ?? null, input.user ?? null, ts);

      if (result === "reached") {
        this.db.prepare("UPDATE follow_ups SET status = 'reached', reached_at = ?, last_attempt_at = ?, version = version + 1 WHERE follow_up_id = ?")
          .run(ts, ts, followUpId);
        this.db
          .prepare("UPDATE referrals SET status = 'completed', open_phase = NULL, sla_due_at = NULL, version = version + 1, updated_at = ? WHERE referral_id = ?")
          .run(ts, followUp.referral_id);
        appendEvent(this.db, {
          referral_id: followUp.referral_id, event_type: "follow_up_reached",
          actor_facility_id: input.facility_id, actor_user: input.user,
          from_status: "follow_up", to_status: "completed",
          payload: { follow_up_id: followUpId }, recorded_at: ts,
        });
        return { status: "reached", referral_status: "completed" };
      }

      const failedCount = followUp.failed_count + 1;
      const lost = failedCount >= FOLLOW_UP_FAILURE_LIMIT;
      this.db
        .prepare("UPDATE follow_ups SET status = ?, failed_count = ?, last_attempt_at = ?, version = version + 1 WHERE follow_up_id = ?")
        .run(lost ? "lost" : "failed", failedCount, ts, followUpId);
      if (lost) {
        this.db
          .prepare("UPDATE referrals SET status = 'lost_contact', open_phase = NULL, sla_due_at = NULL, version = version + 1, updated_at = ? WHERE referral_id = ?")
          .run(ts, followUp.referral_id);
        appendEvent(this.db, {
          referral_id: followUp.referral_id, event_type: "lost_contact",
          actor_facility_id: input.facility_id, actor_user: input.user,
          from_status: "follow_up", to_status: "lost_contact",
          payload: { follow_up_id: followUpId, failed_count: failedCount }, recorded_at: ts,
        });
        return { status: "lost", failed_count: failedCount, referral_status: "lost_contact" };
      }
      appendEvent(this.db, {
        referral_id: followUp.referral_id, event_type: "follow_up_failed",
        actor_facility_id: input.facility_id, actor_user: input.user,
        from_status: "follow_up", to_status: "follow_up",
        open_phase: "follow_up", sla_due_at: followUp.due_at,
        assignee_facility_id: input.facility_id ?? null,
        payload: { follow_up_id: followUpId, failed_count: failedCount }, recorded_at: ts,
      });
      return { status: "failed", failed_count: failedCount, remaining_before_lost: FOLLOW_UP_FAILURE_LIMIT - failedCount };
    });
  }

  // ---------- 超时清扫（邀请/转接到期，可重复执行不产生重复事件） ----------

  sweepTimeouts(asOfIso = this.clock()) {
    const results = { assignments_expired: 0, transfers_expired: 0 };
    const expiredAssignments = this.db
      .prepare("SELECT * FROM referral_assignments WHERE status = 'requested' AND deadline_at < ?")
      .all(asOfIso);
    for (const a of expiredAssignments) {
      transaction(this.db, () => {
        const changed = this.db
          .prepare("UPDATE referral_assignments SET status = 'expired', responded_at = ?, version = version + 1 WHERE assignment_id = ? AND status = 'requested'")
          .run(asOfIso, a.assignment_id).changes;
        if (changed === 0) return;
        results.assignments_expired += 1;
        const state = replayState(this.db, a.referral_id, asOfIso);
        if (state.status === "submitted" && state.open_phase === "triage" && state.assignee_facility_id === a.facility_id) {
          appendEvent(this.db, {
            referral_id: a.referral_id, event_type: "assignment_expired",
            actor_facility_id: null, actor_user: "system",
            from_status: "submitted", to_status: "submitted",
            open_phase: "triage", sla_due_at: state.sla_due_at, assignee_facility_id: null,
            payload: { assignment_id: a.assignment_id }, recorded_at: asOfIso,
          });
          this.db
            .prepare("UPDATE referrals SET assignee_facility_id = NULL, updated_at = ? WHERE referral_id = ?")
            .run(asOfIso, a.referral_id);
        }
      });
    }

    const expiredTransfers = this.db
      .prepare("SELECT * FROM transfers WHERE status = 'requested' AND deadline_at < ?")
      .all(asOfIso);
    for (const t of expiredTransfers) {
      const state = replayState(this.db, t.referral_id, asOfIso);
      if (state.status !== "transfer_requested" || state.assignee_facility_id !== t.to_facility_id) {
        this.db.prepare("UPDATE transfers SET status = 'expired', responded_at = ?, version = version + 1 WHERE transfer_id = ? AND status = 'requested'")
          .run(asOfIso, t.transfer_id);
        continue;
      }
      this.#expireTransfer(t, asOfIso);
      results.transfers_expired += 1;
    }
    return results;
  }

  // ---------- 重复人工复核 ----------

  resolvePatientDuplicate(duplicateId, input) {
    const row = this.db.prepare("SELECT * FROM suspected_duplicate_patients WHERE duplicate_id = ?").get(duplicateId);
    if (!row) throw new NotFoundError("疑似重复记录不存在");
    const status = input.status === "confirmed" ? "confirmed" : "dismissed";
    const ts = this.clock();
    transaction(this.db, () => {
      this.db
        .prepare("UPDATE suspected_duplicate_patients SET status = ?, resolved_by = ?, resolved_at = ? WHERE duplicate_id = ?")
        .run(status, input.resolved_by ?? null, ts, duplicateId);
      // 记录到患者身份级别：同一伪名对子的后续转诊不再重复提示（different），或确认同人（same）
      const tokens = this.db
        .prepare(
          `SELECT patient_token FROM referrals WHERE referral_id IN (?, ?) ORDER BY patient_token`,
        )
        .all(row.referral_id, row.other_referral_id)
        .map((r) => r.patient_token)
        .filter(Boolean);
      if (tokens.length === 2 && tokens[0] !== tokens[1]) {
        this.db
          .prepare(
            `INSERT INTO patient_identity_decisions
               (decision_id, patient_token_a, patient_token_b, decision, decided_by, decided_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(patient_token_a, patient_token_b)
             DO UPDATE SET decision = excluded.decision, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
          )
          .run(createId("idd"), tokens[0], tokens[1], status === "confirmed" ? "same" : "different",
            input.resolved_by ?? null, ts);
      }
    });
    return { duplicate_id: duplicateId, status };
  }

  resolveCheckDuplicate(dupCheckId, input) {
    const row = this.db.prepare("SELECT * FROM suspected_duplicate_checks WHERE dup_check_id = ?").get(dupCheckId);
    if (!row) throw new NotFoundError("疑似重复检查记录不存在");
    const status = input.status === "confirmed" ? "confirmed" : "dismissed";
    this.db
      .prepare("UPDATE suspected_duplicate_checks SET status = ? WHERE dup_check_id = ?")
      .run(status, dupCheckId);
    return { dup_check_id: dupCheckId, status };
  }

  listDuplicates(referralId) {
    return {
      patients: this.db
        .prepare("SELECT * FROM suspected_duplicate_patients WHERE referral_id = ? ORDER BY score DESC")
        .all(referralId)
        .map((r) => ({ ...r, reasons: JSON.parse(r.reasons_json) })),
      checks: this.db
        .prepare("SELECT * FROM suspected_duplicate_checks WHERE referral_id = ? ORDER BY days_apart")
        .all(referralId),
    };
  }

  // ---------- 查询 ----------

  getReferral(referralId, { readerFacilityId, readerUser } = {}) {
    const row = this.db.prepare("SELECT * FROM referrals WHERE referral_id = ?").get(referralId);
    if (!row) throw new NotFoundError(`转诊 ${referralId} 不存在`);
    const asOf = this.clock();
    const state = replayState(this.db, referralId, asOf);
    const events = listEvents(this.db, referralId);
    const documents = this.db
      .prepare("SELECT document_id, doc_type, is_genetic, supplied_by, created_at FROM referral_documents WHERE referral_id = ? ORDER BY created_at")
      .all(referralId)
      .map((d) => ({ ...d, is_genetic: !!d.is_genetic }));
    return {
      ...row,
      phenotype_codes: JSON.parse(row.phenotype_codes_json),
      state,
      events: events.map((e) => ({ seq: e.seq, event_type: e.event_type, actor_facility_id: e.actor_facility_id,
        actor_user: e.actor_user, from_status: e.from_status, to_status: e.to_status,
        open_phase: e.open_phase, sla_due_at: e.sla_due_at, assignee_facility_id: e.assignee_facility_id,
        payload: e.payload, recorded_at: e.recorded_at })),
      documents,
      checks: this.db.prepare("SELECT * FROM referral_checks WHERE referral_id = ? ORDER BY check_date").all(referralId),
      created_at: row.created_at,
    };
  }

  /** 读取材料内容：非基因材料需基础授权，基因材料逐项强制白名单校验，全程审计。 */
  readDocument(documentId, input) {
    const ts = this.clock();
    const doc = this.db
      .prepare("SELECT d.*, r.auth_id FROM referral_documents d JOIN referrals r ON r.referral_id = d.referral_id WHERE d.document_id = ?")
      .get(documentId);
    if (!doc) throw new NotFoundError("材料不存在");
    if (!this.#isParticipant(doc.referral_id, input.facility_id, ts)) {
      this.authz.audit({
        ts, authId: doc.auth_id, referralId: doc.referral_id, actorFacilityId: input.facility_id,
        actorUser: input.user, resourceType: doc.is_genetic ? "genetic_results" : "referral_summary",
        resourceId: documentId, action: "read", decision: "deny", reason: "机构未参与该转诊",
      });
      throw new AuthorizationError("机构未参与该转诊");
    }
    this.authz.authorizeAccess({
      authId: doc.auth_id,
      facilityId: input.facility_id,
      user: input.user,
      role: input.role,
      scope: doc.is_genetic ? "genetic_results" : "referral_summary",
      referralId: doc.referral_id,
      resourceId: documentId,
      action: "read",
    });
    return { document_id: documentId, doc_type: doc.doc_type, is_genetic: !!doc.is_genetic, content_ref: doc.content_ref };
  }

  // ---------- 查询 ----------

  /**
   * 接诊机构在院内检查后挂载材料（例如基因检测结果）。
   * 基因材料仍强制要求该机构在授权白名单内；全程审计。
   */
  addDocument(referralId, input) {
    const ts = this.clock();
    const referral = this.#requireReferral(referralId);
    const facilityId = req(input.facility_id, "facility_id");
    if (!this.#isParticipant(referralId, facilityId, ts)) {
      throw new AuthorizationError("机构未参与该转诊");
    }
    const docType = req(input.doc_type, "doc_type");
    const contentRef = req(input.content_ref, "content_ref");
    const isGenetic = input.is_genetic === true;
    if (isGenetic) {
      this.authz.authorizeAccess({
        authId: referral.auth_id, facilityId, user: input.user,
        scope: "genetic_results", referralId, resourceId: contentRef, action: "upload",
      });
    } else {
      this.authz.authorizeAccess({
        authId: referral.auth_id, facilityId, user: input.user,
        scope: "referral_summary", referralId, resourceId: contentRef, action: "upload",
      });
    }
    const documentId = createId("doc");
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO referral_documents
             (document_id, referral_id, doc_type, is_genetic, content_ref, checksum, supplied_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(documentId, referralId, docType, isGenetic ? 1 : 0,
          contentRef, input.checksum ?? null, facilityId, ts);
      appendEvent(this.db, {
        referral_id: referralId, event_type: "document_attached",
        actor_facility_id: facilityId, actor_user: input.user,
        payload: { document_id: documentId, doc_type: docType, is_genetic: isGenetic },
        recorded_at: ts,
      });
    });
    return { document_id: documentId };
  }

  listAudit(referralId) {
    return this.db
      .prepare("SELECT * FROM access_audits WHERE referral_id = ? ORDER BY ts DESC, audit_id")
      .all(referralId);
  }

  // ---------- 内部辅助 ----------

  #canServe(facilityId, referral, asOf) {
    if (!this.registry.hasActiveQualification(facilityId, asOf)) return false;
    if (referral.suspected_disease_code) {
      const cap = this.registry.getCapability(facilityId, referral.suspected_disease_code, asOf);
      if (cap && cap.status === "active") return true;
    }
    const categoryCap = this.db
      .prepare(
        `SELECT 1 FROM capability_versions cv
         WHERE cv.facility_id = ? AND cv.disease_category = ? AND cv.status = 'active' AND cv.valid_from <= ?
         AND cv.valid_from = (SELECT MAX(valid_from) FROM capability_versions
           WHERE facility_id = cv.facility_id AND disease_code = cv.disease_code AND valid_from <= ?)
         LIMIT 1`,
      )
      .get(facilityId, referral.suspected_category, asOf, asOf);
    return !!categoryCap;
  }

  #isParticipant(referralId, facilityId, asOf) {
    const referral = this.db.prepare("SELECT source_facility_id FROM referrals WHERE referral_id = ?").get(referralId);
    if (!referral) return false;
    if (referral.source_facility_id === facilityId) return true;
    const acted = this.db
      .prepare(
        `SELECT 1 FROM referral_events
         WHERE referral_id = ? AND actor_facility_id = ?
         UNION ALL
         SELECT 1 FROM referral_events WHERE referral_id = ? AND assignee_facility_id = ?
         LIMIT 1`,
      )
      .get(referralId, facilityId, referralId, facilityId);
    return !!acted;
  }

  #pendingTransfer(referralId) {
    return this.db
      .prepare("SELECT * FROM transfers WHERE referral_id = ? AND status = 'requested' ORDER BY requested_at DESC LIMIT 1")
      .get(referralId);
  }

  #requireTransfer(transferId) {
    const row = this.db.prepare("SELECT * FROM transfers WHERE transfer_id = ?").get(transferId);
    if (!row) throw new NotFoundError("转接不存在");
    return row;
  }

  #requireMdt(mdtId) {
    const row = this.db.prepare("SELECT * FROM mdt_consultations WHERE mdt_id = ?").get(mdtId);
    if (!row) throw new NotFoundError("会诊不存在");
    return row;
  }

  #requireReferral(referralId) {
    const row = this.db.prepare("SELECT * FROM referrals WHERE referral_id = ?").get(referralId);
    if (!row) throw new NotFoundError(`转诊 ${referralId} 不存在`);
    return { ...row, phenotype_codes: JSON.parse(row.phenotype_codes_json) };
  }

  #requireHolder(referralId, facilityId, ts) {
    const state = replayState(this.db, referralId, ts);
    if (!state.current_holder_facility_id) throw new ConflictError("转诊尚未被接诊");
    if (state.current_holder_facility_id !== facilityId) {
      throw new AuthorizationError(`当前责任机构为 ${state.current_holder_facility_id}`);
    }
    return state;
  }

  #touch(referralId, ts, status, phase, due, assignee) {
    this.db
      .prepare("UPDATE referrals SET status = ?, open_phase = ?, sla_due_at = ?, assignee_facility_id = ?, updated_at = ? WHERE referral_id = ?")
      .run(status, phase, due, assignee, ts, referralId);
  }

  #recordAttempt({ idempotencyKey, referralId, sourceFacilityId, payloadHash, result, reasons }) {
    this.db
      .prepare(
        `INSERT INTO submission_attempts (attempt_id, idempotency_key, referral_id, source_facility_id, payload_hash, result, reasons_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(createId("att"), idempotencyKey, referralId, sourceFacilityId, payloadHash, result, JSON.stringify(reasons), this.clock());
  }
}

function req(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`字段 ${field} 必填`);
  }
  return value;
}

function numOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

function stripKey(input) {
  const { idempotency_key, ...rest } = input;
  return rest;
}
