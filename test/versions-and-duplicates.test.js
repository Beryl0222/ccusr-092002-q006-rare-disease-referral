import assert from "node:assert/strict";
import test from "node:test";
import { buildNetwork, seedCityOneCapabilities, grantAndSubmit, ACTORS, T0, T1, T2 } from "../test-support/fixture.js";

test("人口与能力版本只追加：调整后历史 as-of 口径不被重写", () => {
  const { db, svc } = buildNetwork();
  seedCityOneCapabilities(svc, T0);

  // T0 时点：330100 为目标地市且已覆盖
  const covAtT0 = svc.coverageGap(T0);
  assert.deepEqual(covAtT0.uncoveredRegions, []);
  assert.equal(covAtT0.targetCities[0].population, 12_000_000);

  // T1 人口修订（如统计口径更新到 1250 万），并新增另一个目标地市 330200（当时无机构=缺口）
  svc.registerFacility({ id: "clinic-201", name: "另一地市社区", level: "primary", regionCode: "330200" });
  svc.addPopulationVersion({ regionCode: "330100", population: 12_500_000, isTargetCity: true, effectiveAt: T1 }, ACTORS.regulator);
  svc.addPopulationVersion({ regionCode: "330200", population: 4_200_000, isTargetCity: true, effectiveAt: T1 }, ACTORS.regulator);

  const covAtT1 = svc.coverageGap(T1);
  assert.deepEqual(covAtT1.uncoveredRegions.sort(), ["330200"]);
  assert.equal(covAtT1.targetCities.find((r) => r.regionCode === "330100").population, 12_500_000);

  // 回到 T0：仍是旧人口、且 330200 尚未进入目标范围——历史统计未被重写
  const backAtT0 = svc.coverageGap(T0);
  assert.equal(backAtT0.targetCities[0].population, 12_000_000);
  assert.ok(!backAtT0.targetCities.some((r) => r.regionCode === "330200"));

  // 直接改写历史版本必须被触发器拒绝
  assert.throws(
    () => db.prepare("UPDATE region_population_versions SET population=1 WHERE id=1").run(),
    /只允许插新版本/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM region_population_versions WHERE id=1").run(),
    /不可删除/,
  );
});

test("机构能力停诊只插新版本：历史时点仍可接诊，当前时点不可达", () => {
  const { svc } = buildNetwork();
  seedCityOneCapabilities(svc, T0);
  // T1 暂停 D-IME-1 接诊
  svc.addCapabilityVersion({
    facilityId: "hosp-city-1", diseaseCode: "D-IME-1", diseaseName: "苯丙酮尿症",
    canAccept: false, effectiveAt: T1,
  }, ACTORS.regulator);

  assert.equal(svc.coverageGap(T0).uncoveredRegions.length, 0);
  assert.deepEqual(svc.coverageGap(T1).uncoveredRegions, ["330100"]);
});

test("必要材料缺失时被校验拒绝并返回缺项", () => {
  const { svc } = buildNetwork();
  seedCityOneCapabilities(svc);
  svc.grantConsent({ patientToken: "tok-x", scope: "referral-summary" }, ACTORS.clinic);
  assert.throws(
    () => svc.submitReferral({
      patientToken: "tok-x",
      suspectedCategory: "遗传代谢类",
      documents: [{ docType: "clinical-summary", content: {} }],
    }, ACTORS.clinic),
    (err) => err.code === "material_incomplete" &&
      JSON.stringify(err.details.missing_materials) === JSON.stringify(["laboratory-index"]),
  );
});

test("无授权提交被拒绝", () => {
  const { svc } = buildNetwork();
  seedCityOneCapabilities(svc);
  assert.throws(() => svc.submitReferral({
    patientToken: "tok-noauth",
    suspectedCategory: "遗传代谢类",
    documents: [
      { docType: "clinical-summary", content: {} },
      { docType: "laboratory-index", content: {} },
    ],
  }, ACTORS.clinic), (err) => err.code === "consent_required");
});

test("识别可能重复的患者（同指纹不同假名）与重复检查", () => {
  const { svc } = buildNetwork();
  seedCityOneCapabilities(svc);
  // 同一身份指纹（相同性别+出生年，由 token 派生时不同 token 指纹不同；
  // 这里显式提交同一 identityFingerprint 模拟跨院同一患者的不同假名）
  const sharedFp = "fp-shared-patient-0001";
  svc.grantConsent({ patientToken: "tok-A", identityFingerprint: sharedFp, scope: "referral-summary" }, ACTORS.clinic);
  const first = svc.submitReferral({
    patientToken: "tok-A", identityFingerprint: sharedFp,
    suspectedCategory: "遗传代谢类",
    documents: [{
      docType: "laboratory-index",
      content: { phe: 240 },
      exams: [{ examType: "blood", examCode: "PHE", examDate: "2026-08-01" }],
    }, { docType: "clinical-summary", content: {} }],
  }, ACTORS.clinic);
  assert.deepEqual(first.warnings.possibleDuplicatePatients, []);

  // 另一机构以新假名、同指纹再次建档提交
  svc.registerFacility({ id: "clinic-209", name: "另一社区", level: "primary", regionCode: "330100" });
  const other = { role: "facility", facilityId: "clinic-209", userId: "dr-other" };
  svc.grantConsent({ patientToken: "tok-B", identityFingerprint: sharedFp, scope: "referral-summary" }, other);
  const second = svc.submitReferral({
    patientToken: "tok-B", identityFingerprint: sharedFp,
    suspectedCategory: "遗传代谢类",
    documents: [{
      docType: "laboratory-index",
      content: { phe: 245 },
      exams: [{ examType: "blood", examCode: "PHE", examDate: "2026-08-01" }],
    }, { docType: "clinical-summary", content: {} }],
  }, other);
  assert.equal(second.warnings.possibleDuplicatePatients.length, 1);
  assert.equal(second.warnings.possibleDuplicatePatients[0].patient_token, "tok-A");
  assert.equal(second.warnings.possibleDuplicateExams[0].examCode, "PHE");
});

test("完全相同材料重复提交（同内容哈希）会被提示", () => {
  const { svc } = buildNetwork();
  seedCityOneCapabilities(svc);
  const r1 = grantAndSubmit(svc, { token: "tok-dup" });
  // 同患者、同一文档内容再次提交
  const r2 = grantAndSubmit(svc, { token: "tok-dup", idempotencyKey: undefined });
  // 第二次是新转诊单，但被标记可能重复转诊
  assert.notEqual(r1.referralId, r2.referralId);
  assert.ok(r2.warnings.possibleDuplicateReferrals.some((d) => d.referralId === r1.referralId));
});
