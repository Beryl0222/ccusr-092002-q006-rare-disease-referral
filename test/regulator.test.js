import assert from "node:assert/strict";
import test from "node:test";
import { buildNetwork, seedCityOneCapabilities, grantAndSubmit, ACTORS, fakeClock } from "../test-support/fixture.js";

test("as-of 转诊积压：历史时点按当时状态计数，办结后不再积压", () => {
  const clock = fakeClock("2026-09-01T00:00:00.000Z");
  const { svc } = buildNetwork(undefined, clock);
  seedCityOneCapabilities(svc, "2026-09-01T00:00:00.000Z");
  const r = grantAndSubmit(svc, { genetic: false });
  const tSubmit = clock.iso();
  clock.advanceMs(60_000);
  svc.routeReferral(r.referralId, { facilityId: "hosp-city-1" }, ACTORS.clinic);
  clock.advanceMs(3600_000);
  svc.acceptReferral(r.referralId, ACTORS.city);
  clock.advanceMs(2 * 3600_000);
  svc.scheduleFollowup(r.referralId, {}, ACTORS.city);
  clock.advanceMs(3600_000);
  svc.recordFollowup(r.referralId, { reached: true }, ACTORS.city);
  const tDone = clock.iso();

  // 刚提交后：1 张积压，状态 submitted
  const atSubmit = svc.backlog(tSubmit);
  assert.equal(atSubmit.total, 1);
  assert.equal(atSubmit.byStatus.submitted, 1);

  // 办结后：0 张积压
  assert.equal(svc.backlog(tDone).total, 0);

  // 回到提交时点：仍能还原出 1 张积压（历史不被当前状态重写）
  assert.equal(svc.backlog(tSubmit).total, 1);
});

test("as-of 超时：按时限判断，按期办结不算超时，逾期未办/迟办被识别", () => {
  const clock = fakeClock("2026-09-01T00:00:00.000Z");
  const { svc } = buildNetwork(undefined, clock);
  seedCityOneCapabilities(svc, "2026-09-01T00:00:00.000Z");
  const r1 = grantAndSubmit(svc, { token: "t-fast", urgency: "urgent", genetic: false });
  svc.routeReferral(r1.referralId, { facilityId: "hosp-city-1" }, ACTORS.clinic);
  // urgent 接诊时限 24 小时；10 小时后接诊（按期）
  clock.advanceMs(10 * 3600_000);
  svc.acceptReferral(r1.referralId, ACTORS.city);

  // 第二张：routine（72 小时），一直不接诊
  const r2 = grantAndSubmit(svc, { token: "t-slow", urgency: "routine", genetic: false });
  svc.routeReferral(r2.referralId, { facilityId: "hosp-city-1" }, ACTORS.clinic);

  const after20h = clock.iso();
  // 20 小时：r1 已按期接诊；r2 时限 72h 尚未到期 → 无超时
  assert.equal(svc.overdue(after20h).total, 0);

  // 再过 100 小时：r2 的接诊任务超时
  clock.advanceMs(100 * 3600_000);
  svc.recover(clock.iso()); // 重启恢复会把到点未办任务标 overdue
  const late = svc.overdue(clock.iso());
  const r2Overdue = late.items.find((i) => i.referralId === r2.referralId && i.taskType === "accept");
  assert.ok(r2Overdue, "r2 接诊任务应被判定超时");
  assert.equal(r2Overdue.responsibleFacilityId, "hosp-city-1");
  // r1 不出现在超时列表（24h 内已办结）
  assert.ok(!late.items.some((i) => i.referralId === r1.referralId));
});

test("覆盖缺口：只有挂牌资质但无坐诊排班或病种能力不算可达", () => {
  const { svc } = buildNetwork();
  svc.addPopulationVersion({
    regionCode: "330100", population: 12_000_000, isTargetCity: true,
    effectiveAt: "2026-09-01T00:00:00.000Z",
  }, ACTORS.regulator);

  // 场景 1：只有资质，无病种能力和排班 → 缺口
  svc.addQualificationVersion({
    facilityId: "hosp-city-1", qualificationType: "rare-clinic", status: "granted",
    effectiveAt: "2026-09-01T00:00:00.000Z",
  }, ACTORS.regulator);
  let cov = svc.coverageGap("2026-09-02T00:00:00.000Z");
  assert.deepEqual(cov.uncoveredRegions, ["330100"]);
  assert.match(cov.targetCities[0].gapReason, /坐诊排班|可接诊病种|资质/);

  // 场景 2：补齐病种能力但无排班 → 仍缺口
  svc.addCapabilityVersion({
    facilityId: "hosp-city-1", diseaseCode: "D-1", diseaseName: "病A", canAccept: true,
    effectiveAt: "2026-09-03T00:00:00.000Z",
  }, ACTORS.regulator);
  cov = svc.coverageGap("2026-09-04T00:00:00.000Z");
  assert.deepEqual(cov.uncoveredRegions, ["330100"]);

  // 场景 3：补齐排班 → 覆盖（不是只统计挂牌数量）
  svc.addScheduleVersion({
    facilityId: "hosp-city-1", specialty: "遗传代谢类", weekday: 1,
    slotStart: "09:00", slotEnd: "11:00", seatsPerWeek: 5,
    effectiveAt: "2026-09-05T00:00:00.000Z",
  }, ACTORS.regulator);
  cov = svc.coverageGap("2026-09-06T00:00:00.000Z");
  assert.deepEqual(cov.uncoveredRegions, []);
  assert.equal(cov.targetCities[0].reachableFacilities[0].facilityId, "hosp-city-1");

  // 场景 4：资质在 9-10 被暂停 → 该时点重新变为缺口
  svc.addQualificationVersion({
    facilityId: "hosp-city-1", qualificationType: "rare-clinic", status: "suspended",
    effectiveAt: "2026-09-10T00:00:00.000Z",
  }, ACTORS.regulator);
  assert.deepEqual(svc.coverageGap("2026-09-11T00:00:00.000Z").uncoveredRegions, ["330100"]);
  // 9-06 时点仍然覆盖（历史不被重写）
  assert.deepEqual(svc.coverageGap("2026-09-06T00:00:00.000Z").uncoveredRegions, []);
});

test("监管口径可追溯人口版本：覆盖率分子分母使用当时有效人口", () => {
  const { svc } = buildNetwork();
  // 330100 覆盖、330200 不覆盖
  seedCityOneCapabilities(svc, "2026-09-01T00:00:00.000Z");
  svc.registerFacility({ id: "clinic-201", name: "B 市社区", level: "primary", regionCode: "330200" });
  svc.addPopulationVersion({
    regionCode: "330200", population: 3_000_000, isTargetCity: true,
    effectiveAt: "2026-09-01T00:00:00.000Z",
  }, ACTORS.regulator);
  const cov = svc.coverageGap("2026-09-02T00:00:00.000Z");
  assert.equal(cov.targetPopulation, 15_000_000);
  assert.equal(cov.coveredPopulation, 12_000_000);
  assert.equal(cov.coverageRate, 0.8);
});

test("审计查询可筛选遗传资料拒绝记录", () => {
  const { svc } = buildNetwork();
  seedCityOneCapabilities(svc);
  const r = grantAndSubmit(svc);
  svc.routeReferral(r.referralId, { facilityId: "hosp-city-1" }, ACTORS.clinic);
  svc.acceptReferral(r.referralId, ACTORS.city);
  const consent = svc.db.prepare("SELECT id FROM consents WHERE scope='genetic' AND status='active'").get();
  svc.withdrawConsent({ consentId: consent.id }, ACTORS.clinic);
  svc.getReferralView(r.referralId, ACTORS.city); // 触发一次被拒绝的遗传读取

  const denied = svc.queryAudit({ scope: "genetic", granted: undefined }).filter((a) => !a.granted);
  assert.ok(denied.some((a) => a.action === "read_genetic" && a.referralId === r.referralId));
});
