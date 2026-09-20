import assert from "node:assert/strict";
import test from "node:test";
import { buildNetwork, seedCityOneCapabilities, grantAndSubmit, ACTORS } from "../test-support/fixture.js";

function routeAndAccept(svc, referralId, routingActor = ACTORS.clinic) {
  svc.routeReferral(referralId, { facilityId: "hosp-city-1" }, routingActor);
  return svc.acceptReferral(referralId, ACTORS.city);
}

test("完整工作流：候选解释→派单→接诊→补料→会诊→转接→随访完成，全程有责任人和时限", () => {
  const { svc } = buildNetwork();
  seedCityOneCapabilities(svc);
  const r = grantAndSubmit(svc);

  const candidates = svc.generateCandidates(r.referralId, ACTORS.clinic);
  assert.ok(candidates.candidates.length >= 1);
  const first = candidates.candidates[0];
  assert.equal(first.facilityId, "hosp-city-1");
  assert.ok(first.explanations.some((x) => x.includes("接诊能力")));
  assert.match(candidates.note, /不构成诊断/);
  // 快照已留痕
  assert.ok(first.rank === 1);

  svc.routeReferral(r.referralId, { facilityId: "hosp-city-1" }, ACTORS.clinic);
  // 派单后生成接诊时限任务，责任机构是被派单机构
  let view = svc.getReferralView(r.referralId, ACTORS.city);
  const acceptTask = view.tasks.find((t) => t.type === "accept");
  assert.equal(acceptTask.responsibleFacilityId, "hosp-city-1");
  assert.ok(new Date(acceptTask.dueAt) > new Date(view.createdAt));

  svc.acceptReferral(r.referralId, ACTORS.city);
  // 非持有机构接诊应被拒绝
  assert.throws(() => svc.acceptReferral(r.referralId, ACTORS.city2), /只有当前/);

  // 补料
  svc.requestSupplement(r.referralId, { docTypes: ["imaging"], note: "补头颅 MRI" }, ACTORS.city);
  view = svc.getReferralView(r.referralId, ACTORS.clinic);
  assert.equal(view.status, "awaiting_materials");
  const supTask = view.tasks.find((t) => t.type === "supplement");
  assert.equal(supTask.responsibleFacilityId, "clinic-104");
  assert.ok(supTask.dueAt);
  svc.submitSupplement(r.referralId, { documents: [{ docType: "imaging", content: { mri: "normal" } }] }, ACTORS.clinic);

  // 多学科会诊：申请、排期、完成反馈
  const c = svc.requestConsultation(r.referralId, { participants: [{ facilityId: "hosp-prov-1", specialty: "遗传" }] }, ACTORS.city);
  const scheduled = svc.scheduleConsultation(c.consultationId, { scheduledAt: "2026-09-20T03:00:00.000Z" }, ACTORS.city);
  assert.ok(scheduled.feedbackDue);
  svc.completeConsultation(c.consultationId, { feedback: "建议饮食治疗并随访" }, ACTORS.city);

  // 跨院转接到省级医院（省级也需要资质、能力与遗传授权）
  assert.throws(
    () => svc.transferReferral(r.referralId, { facilityId: "hosp-prov-1" }, ACTORS.city),
    (err) => err.status === 409,
  ); // 省院尚无资质/能力
  // 给省院授权与能力
  svc.grantConsent({ patientToken: "tok-1", scope: "genetic", permittedFacilityIds: ["hosp-prov-1"] }, ACTORS.clinic);
  assert.throws(
    () => svc.transferReferral(r.referralId, { facilityId: "hosp-prov-1" }, ACTORS.city),
    /无有效资质/,
  );
  // 监管补齐省院资质与能力
  seedProvincial(svc);
  const transfer = svc.transferReferral(r.referralId, { facilityId: "hosp-prov-1", reason: "需基因确诊" }, ACTORS.city);
  assert.equal(transfer.status, "transferred");
  view = svc.getReferralView(r.referralId, ACTORS.provincial);
  const newAccept = view.tasks.find((t) => t.type === "accept" && t.status === "open");
  assert.equal(newAccept.responsibleFacilityId, "hosp-prov-1");
  // 原机构不得接诊
  assert.throws(() => svc.acceptReferral(r.referralId, ACTORS.city), /只有当前/);
  svc.acceptReferral(r.referralId, ACTORS.provincial);

  // 随访完成
  svc.scheduleFollowup(r.referralId, {}, ACTORS.provincial);
  svc.recordFollowup(r.referralId, { reached: true }, ACTORS.provincial);
  view = svc.getReferralView(r.referralId, ACTORS.provincial);
  assert.equal(view.status, "completed");
  assert.ok(view.tasks.every((t) => t.status === "done" || t.status === "cancelled"));
  // 事件链完整且不可变
  assert.ok(view.timeline.find((e) => e.type === "submitted"));
  assert.ok(view.timeline.find((e) => e.type === "transferred"));
});

function seedProvincial(svc) {
  svc.addQualificationVersion({ facilityId: "hosp-prov-1", qualificationType: "rare-clinic", status: "granted" }, ACTORS.regulator);
  svc.addCapabilityVersion({ facilityId: "hosp-prov-1", diseaseCode: "D-IME-1", diseaseName: "苯丙酮尿症", canAccept: true, geneticsEnabled: true }, ACTORS.regulator);
  svc.addScheduleVersion({ facilityId: "hosp-prov-1", specialty: "遗传代谢类", weekday: 2, slotStart: "14:00", slotEnd: "16:00", seatsPerWeek: 3 }, ACTORS.regulator);
}

test("遗传资料：授权撤回后阻止新读取，非遗传摘要仍可读，审计留痕", () => {
  const { svc } = buildNetwork();
  seedCityOneCapabilities(svc);
  const r = grantAndSubmit(svc);
  svc.routeReferral(r.referralId, { facilityId: "hosp-city-1" }, ACTORS.clinic);
  svc.acceptReferral(r.referralId, ACTORS.city);

  let view = svc.getReferralView(r.referralId, ACTORS.city);
  const geneticDoc = view.documents.find((d) => d.isGenetic);
  assert.ok(geneticDoc.content); // 授权有效，可读

  // 找到 genetic 授权并撤回
  const consents = svc.db.prepare("SELECT id FROM consents WHERE scope='genetic' AND status='active'").all();
  assert.ok(consents.length >= 1);
  svc.withdrawConsent({ consentId: consents[0].id, reason: "患者撤回基因资料授权" }, ACTORS.clinic);

  view = svc.getReferralView(r.referralId, ACTORS.city);
  const after = view.documents.find((d) => d.isGenetic);
  assert.equal(after.content, null);
  assert.equal(after.restricted, true);
  // 非遗传材料仍可读取
  assert.ok(view.documents.find((d) => d.docType === "clinical-summary").content);

  // 审计中存在被拒绝的 read_genetic
  const denied = svc.queryAudit({ referralId: r.referralId, scope: "genetic", action: "read_genetic" })
    .filter((a) => !a.granted);
  assert.ok(denied.length >= 1);
  // 撤回后补充遗传材料也被拒绝
  svc.requestSupplement(r.referralId, { docTypes: ["genetics-report"] }, ACTORS.city);
  assert.throws(
    () => svc.submitSupplement(r.referralId, { documents: [{ docType: "genetics-report", isGenetic: true, content: {} }] }, ACTORS.clinic),
    /genetic/,
  );
});

test("退回有告知时限，责任回到发起机构", () => {
  const { svc } = buildNetwork();
  seedCityOneCapabilities(svc);
  const r = grantAndSubmit(svc, { genetic: false, urgency: "routine" });
  svc.routeReferral(r.referralId, { facilityId: "hosp-city-1" }, ACTORS.clinic);
  svc.acceptReferral(r.referralId, ACTORS.city);
  const res = svc.returnReferral(r.referralId, { reason: "不属于该病种" }, ACTORS.city);
  assert.equal(res.status, "returned");
  const view = svc.getReferralView(r.referralId, ACTORS.clinic);
  const notify = view.tasks.find((t) => t.type === "return");
  assert.equal(notify.responsibleFacilityId, "clinic-104");
  assert.ok(notify.dueAt);
});

test("多次随访失联达到三次后进入 lost_to_followup 终态", () => {
  const { svc } = buildNetwork();
  seedCityOneCapabilities(svc);
  const r = grantAndSubmit(svc, { genetic: false });
  routeAndAccept(svc, r.referralId);
  for (let i = 0; i < 2; i++) {
    svc.scheduleFollowup(r.referralId, {}, ACTORS.city);
    const out = svc.recordFollowup(r.referralId, { reached: false }, ACTORS.city);
    assert.notEqual(out.status, "lost_to_followup");
  }
  svc.scheduleFollowup(r.referralId, {}, ACTORS.city);
  const third = svc.recordFollowup(r.referralId, { reached: false }, ACTORS.city);
  assert.equal(third.status, "lost_to_followup");
});
