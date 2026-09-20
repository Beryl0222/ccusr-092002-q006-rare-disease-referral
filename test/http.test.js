import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";

async function withServer(run) {
  const dir = mkdtempSync(path.join(tmpdir(), "rdrn-http-"));
  const dbPath = path.join(dir, "network.db");
  const server = createApp(dbPath).listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const REG = { "x-role": "regulator", "x-user-id": "reg-zhang" };
const CLINIC = { "x-facility-id": "clinic-104", "x-user-id": "dr-li" };
const CITY = { "x-facility-id": "hosp-city-1", "x-user-id": "dr-wang" };

async function json(base, method, route, body, headers = {}) {
  const res = await fetch(base + route, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  const text = await res.text();
  if (text) parsed = JSON.parse(text);
  return { status: res.status, body: parsed, headers: res.headers };
}

async function seed(base) {
  await json(base, "POST", "/admin/facilities", { id: "clinic-104", name: "社区中心", level: "primary", regionCode: "330100", lat: 30.25, lon: 120.15 }, REG);
  await json(base, "POST", "/admin/facilities", { id: "hosp-city-1", name: "市一院", level: "city", regionCode: "330100", lat: 30.27, lon: 120.17 }, REG);
  await json(base, "POST", "/admin/population-versions", { regionCode: "330100", population: 12_000_000, isTargetCity: true }, REG);
  await json(base, "POST", "/admin/facilities/hosp-city-1/qualifications", { qualificationType: "rare-clinic", status: "granted" }, REG);
  await json(base, "POST", "/admin/facilities/hosp-city-1/capabilities", { diseaseCode: "D-IME-1", diseaseName: "苯丙酮尿症", canAccept: true, geneticsEnabled: true }, REG);
  await json(base, "POST", "/admin/facilities/hosp-city-1/schedules", { specialty: "遗传代谢类", weekday: 1, slotStart: "09:00", slotEnd: "11:00", seatsPerWeek: 5 }, REG);
  await json(base, "POST", "/consents", { patientToken: "tok-1", sex: "F", birthYear: 2012, scope: "referral-summary" }, CLINIC);
  await json(base, "POST", "/consents", { patientToken: "tok-1", scope: "genetic", permittedFacilityIds: ["hosp-city-1"] }, CLINIC);
}

test("HTTP 健康检查", async () => {
  await withServer(async (base) => {
    const res = await json(base, "GET", "/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "ok");
  });
});

test("HTTP 端到端：提交→候选→派单→接诊，幂等键与权限头生效", async () => {
  await withServer(async (base) => {
    await seed(base);
    const payload = {
      patientToken: "tok-1", sex: "F", birthYear: 2012,
      suspectedCategory: "遗传代谢类", suspectedDiseaseCode: "D-IME-1", urgency: "urgent",
      containsGeneticMaterial: true,
      documents: [
        { docType: "clinical-summary", content: { note: "发育迟缓" } },
        { docType: "laboratory-index", content: { phe: 240 } },
        { docType: "genetics-report", isGenetic: true, content: { gene: "PAH" } },
      ],
    };
    const created = await json(base, "POST", "/referrals", payload, { ...CLINIC, "idempotency-key": "http-key-1" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.referralId;

    // 同幂等键重放
    const replay = await json(base, "POST", "/referrals", payload, { ...CLINIC, "idempotency-key": "http-key-1" });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.referralId, id);

    // 候选机构
    const cand = await json(base, "POST", `/referrals/${id}/candidates`, {}, CLINIC);
    assert.equal(cand.status, 200);
    assert.equal(cand.body.candidates[0].facilityId, "hosp-city-1");
    assert.match(cand.body.note, /不构成诊断/);

    // 无机构身份派单被拒
    const noId = await json(base, "POST", `/referrals/${id}/route`, { facilityId: "hosp-city-1" }, {});
    assert.equal(noId.status, 401);

    const routed = await json(base, "POST", `/referrals/${id}/route`, { facilityId: "hosp-city-1" }, CLINIC);
    assert.equal(routed.status, 200);

    // 非持有机构接诊 403
    const other = await json(base, "POST", `/referrals/${id}/accept`, undefined, { "x-facility-id": "hosp-city-2", "x-user-id": "x" });
    assert.equal(other.status, 403);

    const accepted = await json(base, "POST", `/referrals/${id}/accept`, undefined, CITY);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, "accepted");
  });
});

test("HTTP：材料不全返回 422 与缺项；无授权返回 403", async () => {
  await withServer(async (base) => {
    await seed(base);
    const bad = await json(base, "POST", "/referrals", {
      patientToken: "tok-1",
      suspectedCategory: "遗传代谢类",
      documents: [{ docType: "clinical-summary", content: {} }],
    }, CLINIC);
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error, "material_incomplete");
    assert.deepEqual(bad.body.details.missing_materials, ["laboratory-index"]);

    const noConsent = await json(base, "POST", "/referrals", {
      patientToken: "tok-stranger",
      suspectedCategory: "遗传代谢类",
      documents: [
        { docType: "clinical-summary", content: {} },
        { docType: "laboratory-index", content: {} },
      ],
    }, CLINIC);
    assert.equal(noConsent.status, 403);
    assert.equal(noConsent.body.error, "consent_required");
  });
});

test("HTTP：遗传授权撤回后读取被脱敏并记审计；监管接口仅监管可用", async () => {
  await withServer(async (base) => {
    await seed(base);
    const created = await json(base, "POST", "/referrals", {
      patientToken: "tok-1", suspectedCategory: "遗传代谢类", suspectedDiseaseCode: "D-IME-1",
      urgency: "routine", containsGeneticMaterial: true,
      documents: [
        { docType: "clinical-summary", content: {} },
        { docType: "laboratory-index", content: {} },
        { docType: "genetics-report", isGenetic: true, content: { gene: "PAH" } },
      ],
    }, CLINIC);
    const id = created.body.referralId;
    await json(base, "POST", `/referrals/${id}/route`, { facilityId: "hosp-city-1" }, CLINIC);
    await json(base, "POST", `/referrals/${id}/accept`, undefined, CITY);

    // 撤回 genetic 授权（查 id）
    const viewBefore = await json(base, "GET", `/referrals/${id}`, undefined, CITY);
    assert.ok(viewBefore.body.documents.find((d) => d.isGenetic).content);

    // 通过数据库无法在 HTTP 内拿 consent id；提供一个查询途径：用监管审计不必要。
    // 这里直接调用撤回接口，id 用已知的第 2 条授权（genetic 为后授予）。
    const withdrawn = await json(base, "POST", "/consents/2/withdraw", { reason: "患者撤回" }, CLINIC);
    assert.equal(withdrawn.status, 200);

    const viewAfter = await json(base, "GET", `/referrals/${id}`, undefined, CITY);
    const genetic = viewAfter.body.documents.find((d) => d.isGenetic);
    assert.equal(genetic.content, null);
    assert.equal(genetic.restricted, true);

    // 机构不能访问监管接口
    const forbidden = await json(base, "GET", "/regulator/coverage", undefined, CLINIC);
    assert.equal(forbidden.status, 403);

    const cov = await json(base, "GET", "/regulator/coverage", undefined, REG);
    assert.equal(cov.status, 200);
    assert.deepEqual(cov.body.uncoveredRegions, []);

    const audit = await json(base, "GET", `/regulator/audit?referralId=${id}&scope=genetic`, undefined, REG);
    assert.ok(audit.body.some((a) => a.action === "read_genetic" && a.granted === false));
  });
});
