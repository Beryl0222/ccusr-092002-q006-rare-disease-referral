import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, seedScenario, baseReferralInput, FakeClock } from "./helpers.js";
import { AuthorizationService, SCOPES } from "../src/services/authorization.js";

function setup() {
  const h = createHarness();
  const ids = seedScenario(h);
  h.authz.grant({
    auth_id: "auth-001",
    patient_token: "pseudonym-7a91",
    scopes: [SCOPES.REFERRAL_SUMMARY],
    granted_by_facility_id: "clinic-1",
  });
  return { ...h, ...ids };
}

// ---------- 提交校验与幂等 ----------

test("提交：材料不完整被拒收并记录 rejected 尝试", () => {
  const h = setup();
  const input = baseReferralInput({
    documents: [{ doc_type: "clinical-summary", content_ref: "obj://sum-1" }],
  });
  assert.throws(
    () => h.referrals.submit(input),
    /转诊材料校验未通过/,
  );
  const attempts = h.db.prepare("SELECT result, reasons_json FROM submission_attempts").all();
  assert.equal(attempts[0].result, "rejected");
  assert.ok(JSON.parse(attempts[0].reasons_json).some((r) => r.includes("laboratory-index")));
});

test("提交：缺少授权被拒绝并写拒绝审计", () => {
  const h = setup();
  const input = baseReferralInput({ auth_id: "auth-missing" });
  assert.throws(() => h.referrals.submit(input), /授权不存在/);
  const denied = h.db.prepare("SELECT decision FROM access_audits WHERE decision='deny'").all();
  assert.ok(denied.length >= 1);
});

test("提交：同一 idempotency_key 重复提交返回原转诊", () => {
  const h = setup();
  const first = h.referrals.submit(baseReferralInput({ idempotency_key: "k-1" }));
  const second = h.referrals.submit(baseReferralInput({ idempotency_key: "k-1", referral_id: "ref-other" }));
  assert.equal(second.referral_id, first.referral_id);
  assert.equal(second.duplicate, true);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM referrals").get().n, 1);
});

test("提交：相同负载不同键被识别为重复提交", () => {
  const h = setup();
  h.referrals.submit(baseReferralInput({ idempotency_key: "k-1" }));
  const again = h.referrals.submit(baseReferralInput({ idempotency_key: "k-2" }));
  assert.equal(again.duplicate, true);
  assert.equal(again.duplicate_reason, "same_payload");
});

test("提交：基因材料在无 genetic 授权时被逐项拒绝", () => {
  const h = setup();
  const input = baseReferralInput({
    documents: [
      ...baseReferralInput().documents,
      { doc_type: "genetic-test-report", content_ref: "obj://gene-1" },
    ],
  });
  let caught;
  try {
    h.referrals.submit(input);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "应当抛出校验错误");
  assert.deepEqual(Array.isArray(caught.details), true);
  assert.ok(caught.details.some((r) => r.includes("基因材料") && r.includes("授权范围不含")));
});

test("提交：基因授权限定白名单，白名单外机构仍被拒", () => {
  const h = setup();
  h.authz.grant({
    auth_id: "auth-gene",
    patient_token: "pseudonym-7a91",
    scopes: [SCOPES.REFERRAL_SUMMARY, SCOPES.GENETIC_RESULTS],
    genetic_facilities: ["prov-hosp-1"],
    granted_by_facility_id: "clinic-1",
  });
  // 授权时强制要求白名单
  assert.throws(
    () =>
      h.authz.grant({
        auth_id: "auth-gene-bad",
        patient_token: "pseudonym-9",
        scopes: [SCOPES.GENETIC_RESULTS],
        genetic_facilities: [],
        granted_by_facility_id: "clinic-1",
      }),
    /必须指定可访问机构白名单/,
  );
  // 基层（非白名单）提交携带基因材料 -> 拒绝
  const input = baseReferralInput({
    auth_id: "auth-gene",
    documents: [
      ...baseReferralInput().documents,
      { doc_type: "genetic-test-report", content_ref: "obj://gene-1" },
    ],
  });
  let caught;
  try {
    h.referrals.submit(input);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "应当抛出校验错误");
  assert.ok(caught.details.some((r) => r.includes("基因材料")));
});

// ---------- 授权撤回 ----------

test("授权撤回：阻断新读取但保留审计与历史业务事实", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  // 接诊后由接诊机构读取普通材料成功
  h.referrals.accept(ref.referral_id, { facility_id: "city-hosp-A1", user: "dr-wang" });
  const doc = h.db.prepare("SELECT * FROM referral_documents WHERE referral_id = ? LIMIT 1").get(ref.referral_id);
  assert.doesNotThrow(() =>
    h.referrals.readDocument(doc.document_id, { facility_id: "city-hosp-A1", user: "dr-wang" }),
  );

  h.authz.revoke("auth-001", { reason: "患者要求撤回", revokedBy: "clinic-1" });
  assert.throws(
    () => h.referrals.readDocument(doc.document_id, { facility_id: "city-hosp-A1", user: "dr-wang" }),
    /授权已撤回/,
  );
  // 历史转诊事实仍可查询（去标识化业务记录保留）
  const stored = h.referrals.getReferral(ref.referral_id);
  assert.equal(stored.status, "accepted");
  // 审计里能看到撤回后的拒绝记录
  const deniedAfter = h.db
    .prepare("SELECT COUNT(*) AS n FROM access_audits WHERE decision='deny' AND reason='授权已撤回'")
    .get().n;
  assert.ok(deniedAfter >= 1);
  // 重复撤回报错
  assert.throws(() => h.authz.revoke("auth-001"), /已被撤回/);
});

test("基因材料：白名单机构可读取，其他机构被拒绝并审计", () => {
  const h = setup();
  h.authz.grant({
    auth_id: "auth-gene",
    patient_token: "pseudonym-7a91",
    scopes: [SCOPES.REFERRAL_SUMMARY, SCOPES.GENETIC_RESULTS],
    genetic_facilities: ["prov-hosp-1"],
    granted_by_facility_id: "clinic-1",
  });
  // 省院接诊后在院内完成基因检测，由白名单机构挂载基因材料
  const ref = h.referrals.submit(baseReferralInput({ auth_id: "auth-gene" }));
  h.referrals.accept(ref.referral_id, { facility_id: "prov-hosp-1", user: "dr-chen" });
  h.referrals.addDocument(ref.referral_id, {
    facility_id: "prov-hosp-1", user: "dr-chen",
    doc_type: "genetic-test-report", content_ref: "obj://gene-9", is_genetic: true,
  });
  const geneDoc = h.db.prepare("SELECT document_id FROM referral_documents WHERE is_genetic=1").get();
  assert.doesNotThrow(() =>
    h.referrals.readDocument(geneDoc.document_id, { facility_id: "prov-hosp-1", user: "dr-chen" }),
  );
  assert.throws(
    () => h.referrals.readDocument(geneDoc.document_id, { facility_id: "city-hosp-A1", user: "dr-wang" }),
    /机构未参与该转诊|遗传资料仅限授权白名单机构访问/,
  );
});

// ---------- 重复识别 ----------

test("重复患者与重复检查被识别并可供人工复核", () => {
  const h = setup();
  const first = h.referrals.submit(baseReferralInput({
    referral_id: "ref-a", idempotency_key: "ka", patient_token: "pseudo-A",
  }));
  const second = h.referrals.submit(
    baseReferralInput({
      referral_id: "ref-b",
      idempotency_key: "kb",
      patient_token: "pseudo-B",
      checks: [{ check_code: "LAB-PHE", check_name: "血苯丙氨酸", check_date: "2026-01-05", facility_id: "clinic-1" }],
    }),
  );
  const dups = h.referrals.listDuplicates(second.referral_id);
  assert.ok(dups.patients.some((d) => d.other_referral_id === "ref-a"));
  assert.ok(dups.checks.some((d) => d.check_code === "LAB-PHE"));
  // 人工判定 A/B 为不同身份后，同一身份（token B）再来建档时不再提示与 A 重复
  h.referrals.resolvePatientDuplicate(dups.patients[0].duplicate_id, { status: "dismissed", resolved_by: "reg-1" });
  const third = h.referrals.submit(
    baseReferralInput({ referral_id: "ref-c", idempotency_key: "kc", patient_token: "pseudo-B" }),
  );
  const dups3 = h.referrals.listDuplicates(third.referral_id);
  assert.ok(!dups3.patients.some((d) => d.other_referral_id === "ref-a"));
  assert.ok(first);
});

// ---------- 候选排序 ----------

test("候选机构：按能力/距离/候诊/紧急度可解释排序，暂停号源被排除", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  const candidates = h.referrals.generateCandidates(ref.referral_id);
  const ids = candidates.results.map((r) => r.facility_id);
  assert.ok(ids.includes("city-hosp-A1"));
  assert.ok(ids.includes("prov-hosp-1"));
  assert.ok(!ids.includes("city-hosp-A2"), "号源暂停机构不应入选");
  assert.ok(candidates.excluded.some((e) => e.facility_id === "city-hosp-A2"));
  const top = candidates.results[0];
  // 距离最近、候诊更短的市一医院应领先；且每个因子与理由都返回
  assert.equal(top.facility_id, "city-hosp-A1");
  for (const key of ["capability", "distance", "waiting", "urgency_fit"]) {
    assert.ok(typeof top.factors[key] === "number");
  }
  assert.ok(top.reasons.length >= 3);
  assert.ok(candidates.notice.includes("不构成诊断"));
});

// ---------- 状态机：接诊/补材/会诊/转接/随访 ----------

test("状态机：接诊 -> 补材 -> 复核 -> 完结，全程有责任人和时限", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  assert.equal(ref.status, "submitted");
  assert.equal(ref.open_phase, "triage");

  const candidates = h.referrals.generateCandidates(ref.referral_id);
  h.referrals.selectCandidate(ref.referral_id, {
    snapshot_id: candidates.snapshot_id, facility_id: "city-hosp-A1", selected_by: "dr-li",
  });
  const accepted = h.referrals.accept(ref.referral_id, { facility_id: "city-hosp-A1", user: "dr-wang" });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.current_holder_facility_id, "city-hosp-A1");

  const sup = h.referrals.requestSupplement(ref.referral_id, {
    facility_id: "city-hosp-A1", user: "dr-wang", missing_documents: ["imaging-report"],
  });
  assert.ok(sup.due_at);
  h.referrals.submitSupplement(ref.referral_id, {
    facility_id: "clinic-1", user: "dr-li",
    documents: [{ doc_type: "imaging-report", content_ref: "obj://img-1" }],
  });
  const after = h.referrals.getReferral(ref.referral_id);
  assert.equal(after.open_phase, "supplement_review");
  assert.equal(after.assignee_facility_id, "city-hosp-A1");

  h.referrals.complete(ref.referral_id, { facility_id: "city-hosp-A1", user: "dr-wang" });
  assert.equal(h.referrals.getReferral(ref.referral_id).status, "completed");
});

test("状态机：多学科会诊请求/排期/反馈各有 SLA", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  h.referrals.accept(ref.referral_id, { facility_id: "city-hosp-A1", user: "dr-wang" });
  const mdt = h.referrals.requestMdt(ref.referral_id, {
    facility_id: "city-hosp-A1", user: "dr-wang", participants: ["遗传代谢科", "神经内科"],
  });
  h.clock.advance(10);
  h.referrals.scheduleMdt(mdt.mdt_id, {
    facility_id: "city-hosp-A1", scheduled_at: h.clock.now(),
  });
  h.referrals.recordMdtFeedback(mdt.mdt_id, {
    facility_id: "city-hosp-A1", feedback: "建议基因确诊并饮食干预", recommendation: "PKU 管理路径",
  });
  assert.equal(h.referrals.getReferral(ref.referral_id).status, "accepted");
});

test("状态机：跨院转接 -> 目标机构接诊，持有人切换", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  h.referrals.accept(ref.referral_id, { facility_id: "city-hosp-A1", user: "dr-wang" });
  const transfer = h.referrals.requestTransfer(ref.referral_id, {
    facility_id: "city-hosp-A1", user: "dr-wang", to_facility_id: "prov-hosp-1", reason: "需省级基因检测",
  });
  assert.equal(h.referrals.getReferral(ref.referral_id).status, "transfer_requested");
  // 非目标机构不能接诊
  assert.throws(
    () => h.referrals.accept(ref.referral_id, { facility_id: "city-hosp-A2", user: "x" }),
    /仅转接目标机构可以接诊/,
  );
  h.referrals.accept(ref.referral_id, { facility_id: "prov-hosp-1", user: "dr-chen" });
  const after = h.referrals.getReferral(ref.referral_id);
  assert.equal(after.status, "accepted");
  assert.equal(after.current_holder_facility_id, "prov-hosp-1");
  assert.ok(transfer.deadline_at);
});

test("状态机：转接被拒后退回原持有人", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  h.referrals.accept(ref.referral_id, { facility_id: "city-hosp-A1", user: "dr-wang" });
  const transfer = h.referrals.requestTransfer(ref.referral_id, {
    facility_id: "city-hosp-A1", to_facility_id: "prov-hosp-1",
  });
  h.referrals.declineTransfer(transfer.transfer_id, {
    facility_id: "prov-hosp-1", reason: "无号源",
  });
  assert.equal(h.referrals.getReferral(ref.referral_id).current_holder_facility_id, "city-hosp-A1");
});

test("状态机：随访连续 3 次失败判定失联", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  h.referrals.accept(ref.referral_id, { facility_id: "city-hosp-A1", user: "dr-wang" });
  h.referrals.complete(ref.referral_id, { facility_id: "city-hosp-A1", user: "dr-wang" });
  const fu = h.referrals.scheduleFollowUp(ref.referral_id, {
    facility_id: "city-hosp-A1", due_at: h.clock.advanceDays(14),
  });
  h.clock.advance(24 * 14);
  for (let i = 0; i < 2; i += 1) {
    const r = h.referrals.recordFollowUpAttempt(fu.follow_up_id, {
      facility_id: "city-hosp-A1", result: "failed",
    });
    assert.equal(r.status, "failed");
  }
  const lost = h.referrals.recordFollowUpAttempt(fu.follow_up_id, {
    facility_id: "city-hosp-A1", result: "failed",
  });
  assert.equal(lost.status, "lost");
  assert.equal(h.referrals.getReferral(ref.referral_id).status, "lost_contact");
});

test("非持有人不能执行持有人操作", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  h.referrals.accept(ref.referral_id, { facility_id: "city-hosp-A1", user: "dr-wang" });
  assert.throws(
    () => h.referrals.requestMdt(ref.referral_id, { facility_id: "prov-hosp-1" }),
    /当前责任机构/,
  );
  assert.throws(
    () => h.referrals.returnReferral(ref.referral_id, { facility_id: "prov-hosp-1", reason: "x" }),
    /当前责任机构/,
  );
});

// ---------- SLA 超时 ----------

test("SLA：超过接诊时限的邀请清扫失效，超时可被监管识别", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  const candidates = h.referrals.generateCandidates(ref.referral_id);
  h.referrals.selectCandidate(ref.referral_id, {
    snapshot_id: candidates.snapshot_id, facility_id: "city-hosp-A1", selected_by: "dr-li",
  });
  // priority 接诊时限 12 小时
  h.clock.advance(13);
  const overdue = h.regulatory.backlogReport({ asOf: h.clock.now(), persist: false });
  assert.ok(overdue.overdue_total >= 1);
  const swept = h.referrals.sweepTimeouts(h.clock.now());
  assert.equal(swept.assignments_expired, 1);
  // 清扫后其他机构可以接诊
  h.referrals.accept(ref.referral_id, { facility_id: "prov-hosp-1", user: "dr-chen" });
  assert.equal(h.referrals.getReferral(ref.referral_id).status, "accepted");
});

test("SLA：转接超时自动退回原机构", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  h.referrals.accept(ref.referral_id, { facility_id: "city-hosp-A1", user: "dr-wang" });
  h.referrals.requestTransfer(ref.referral_id, {
    facility_id: "city-hosp-A1", to_facility_id: "prov-hosp-1",
  });
  h.clock.advance(25); // 普通转接时限 24h
  h.referrals.sweepTimeouts(h.clock.now());
  assert.equal(h.referrals.getReferral(ref.referral_id).status, "accepted");
  assert.equal(h.referrals.getReferral(ref.referral_id).current_holder_facility_id, "city-hosp-A1");
});

// ---------- 版本化与监管口径 ----------

test("版本化：人口调整后历史覆盖口径不被重写", () => {
  const h = setup();
  // 2025 年 A 市 280 万，未达三百万门槛 -> 不在 large_cities
  const oldReport = h.regulatory.coverageReport({ asOf: "2025-06-01T00:00:00.000Z", persist: false });
  assert.ok(!oldReport.large_cities.regions.some((c) => c.region_code === "city-A"));
  // 2026 年 A 市 400 万 -> 纳入且覆盖可达
  const newReport = h.regulatory.coverageReport({ asOf: "2026-02-01T00:00:00.000Z", persist: false });
  const cityA = newReport.large_cities.regions.find((c) => c.region_code === "city-A");
  assert.ok(cityA);
  assert.ok(cityA.reachable_count >= 1);
  // city-C 350 万但无挂牌 -> 缺口为未挂牌
  const cityC = newReport.large_cities.regions.find((c) => c.region_code === "city-C");
  assert.equal(cityC.gap, "未挂牌");
  // 挂牌但不可达：A2 号源暂停 -> 设施级标记
  const a2 = cityA.facilities.find((f) => f.facility_id === "city-hosp-A2");
  assert.equal(a2.listed, true);
  assert.equal(a2.reachable, false);
});

test("版本化：能力撤销后历史时点仍可见，当前候选不再包含", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  const before = h.referrals.generateCandidates(ref.referral_id);
  assert.ok(before.results.some((r) => r.facility_id === "city-hosp-A1"));
  // 市一医院撤销该病种能力（新版本，不删旧版本）
  h.clock.advance(48);
  h.registry.putCapability({
    facility_id: "city-hosp-A1", disease_code: "RD-001", disease_name: "苯丙酮尿症",
    disease_category: "遗传代谢类", specialty: "遗传代谢科", cap_level: "specialty", status: "withdrawn",
  });
  const after = h.referrals.generateCandidates(ref.referral_id);
  assert.ok(!after.results.some((r) => r.facility_id === "city-hosp-A1"));
  // 历史快照内容未变
  const historical = JSON.parse(
    h.db.prepare("SELECT results_json FROM candidate_snapshots WHERE snapshot_id = ?").get(before.snapshot_id).results_json,
  );
  assert.ok(historical.some((r) => r.facility_id === "city-hosp-A1"));
});

test("监管：积压按 as_of 重放，完结后从积压消失", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  const submittedAt = ref.created_at;
  const during = h.regulatory.backlogReport({ asOf: submittedAt, persist: false });
  assert.equal(during.open_total, 1);
  h.clock.advance(2);
  h.referrals.accept(ref.referral_id, { facility_id: "city-hosp-A1", user: "dr-wang" });
  h.clock.advance(2);
  h.referrals.complete(ref.referral_id, { facility_id: "city-hosp-A1", user: "dr-wang" });
  const after = h.regulatory.backlogReport({ persist: false });
  assert.equal(after.open_total, 0);
  // 以提交时刻重放仍能还原积压
  const historical = h.regulatory.backlogReport({ asOf: submittedAt, persist: false });
  assert.equal(historical.open_total, 1);
});

test("不可变表：更新与删除被数据库阻止", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  assert.throws(
    () => h.db.prepare("UPDATE referral_events SET event_type='x' WHERE referral_id=?").run(ref.referral_id),
    /只追加表/,
  );
  assert.throws(
    () => h.db.prepare("DELETE FROM referral_events WHERE referral_id=?").run(ref.referral_id),
    /只追加表/,
  );
  assert.throws(
    () => h.db.prepare("UPDATE population_versions SET population=1 WHERE region_code='city-A'").run(),
    /只追加表/,
  );
});

test("一致性核查：正常状态下报告 consistent", () => {
  const h = setup();
  const ref = h.referrals.submit(baseReferralInput());
  h.referrals.generateCandidates(ref.referral_id);
  h.referrals.accept(ref.referral_id, { facility_id: "city-hosp-A1", user: "dr-wang" });
  const report = h.regulatory.consistencyCheck();
  assert.equal(report.consistent, true, JSON.stringify(report.issues));
});
