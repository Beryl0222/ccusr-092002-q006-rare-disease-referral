import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { tempDbPath } from "./helpers.js";

async function start(dbPath) {
  const server = createApp(dbPath).listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    base,
    async call(method, path, body, headers = {}) {
      const response = await fetch(base + path, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body == null ? undefined : JSON.stringify(body),
      });
      const json = await response.json().catch(() => ({}));
      return { status: response.status, body: json };
    },
  };
}

const CLINIC_HEADERS = { "x-facility-id": "clinic-1", "x-user": "dr-li", "x-role": "primary" };
const CITY_HEADERS = { "x-facility-id": "city-hosp-A1", "x-user": "dr-wang", "x-role": "specialist" };
const PROV_HEADERS = { "x-facility-id": "prov-hosp-1", "x-user": "dr-chen", "x-role": "specialist" };
const REG_HEADERS = { "x-role": "regulator" };

test("健康检查连接数据库", async () => {
  const api = await start(":memory:");
  try {
    const r = await api.call("GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "ok");
  } finally {
    await new Promise((resolve) => api.server.close(resolve));
  }
});

async function seedWorld(api) {
  await api.call("PUT", "/v1/populations", { region_code: "city-A", region_name: "A 市", region_level: "city", population: 4_000_000 });
  await api.call("PUT", "/v1/populations", { region_code: "city-C", region_name: "C 市", region_level: "city", population: 3_500_000 });
  for (const [id, name, level, region, lat, lng] of [
    ["clinic-1", "城关社区卫生服务中心", "primary", "city-A", 30.0, 120.0],
    ["prov-hosp-1", "省人民医院罕见病中心", "provincial", "city-A", 30.5, 120.5],
    ["city-hosp-A1", "A 市第一医院", "city", "city-A", 30.02, 120.02],
  ]) {
    const r = await api.call("POST", "/v1/facilities", {
      facility_id: id, version: { name, level, region_code: region, lat, lng },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  for (const id of ["prov-hosp-1", "city-hosp-A1"]) {
    await api.call("PUT", `/v1/facilities/${id}/qualifications`, { qual_type: "rare-disease-clinic", status: "active" });
    await api.call("PUT", `/v1/facilities/${id}/capabilities`, {
      disease_code: "RD-001", disease_name: "苯丙酮尿症", disease_category: "遗传代谢类",
      specialty: "遗传代谢科", cap_level: id === "prov-hosp-1" ? "designated" : "specialty", status: "active",
    });
    await api.call("PUT", `/v1/facilities/${id}/schedules`, {
      specialty: "遗传代谢科", weekly_slots: id === "prov-hosp-1" ? 20 : 35, base_lead_days: id === "prov-hosp-1" ? 5 : 2, status: "active",
    });
  }
}

test("HTTP 端到端：授权 -> 提交 -> 候选 -> 接诊 -> 完结 -> 监管可见", async () => {
  const dbPath = tempDbPath();
  const api = await start(dbPath);
  try {
    await seedWorld(api);

    const auth = await api.call("POST", "/v1/authorizations", {
      auth_id: "auth-http-1", patient_token: "pseudo-http-1",
      scopes: ["referral_summary"], granted_by_facility_id: "clinic-1",
    });
    assert.equal(auth.status, 201);

    const bad = await api.call("POST", "/v1/referrals", {
      source_facility_id: "clinic-1", auth_id: "auth-http-1", patient_token: "pseudo-http-1",
      suspected_category: "遗传代谢类", urgency: "priority",
      documents: [{ doc_type: "clinical-summary", content_ref: "o" }],
    }, CLINIC_HEADERS);
    assert.equal(bad.status, 400);
    assert.ok(Array.isArray(bad.body.details));

    const submitted = await api.call("POST", "/v1/referrals", {
      idempotency_key: "http-k-1",
      source_facility_id: "clinic-1", auth_id: "auth-http-1", patient_token: "pseudo-http-1",
      birth_year: 2018, gender: "F", residence_region_code: "city-A",
      suspected_category: "遗传代谢类", suspected_disease_code: "RD-001", urgency: "priority",
      origin_lat: 30.0, origin_lng: 120.0,
      documents: [
        { doc_type: "clinical-summary", content_ref: "o1" },
        { doc_type: "laboratory-index", content_ref: "o2" },
        { doc_type: "phenotype-record", content_ref: "o3" },
      ],
    }, CLINIC_HEADERS);
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    const referralId = submitted.body.referral_id;

    const duplicate = await api.call("POST", "/v1/referrals", submitted.body, CLINIC_HEADERS);
    assert.equal(duplicate.body.duplicate, true);

    const candidates = await api.call("POST", `/v1/referrals/${referralId}/candidates`, {});
    assert.equal(candidates.status, 200);
    assert.equal(candidates.body.results[0].facility_id, "city-hosp-A1");

    const select = await api.call("POST", `/v1/referrals/${referralId}/candidate-selections`, {
      snapshot_id: candidates.body.snapshot_id, facility_id: "city-hosp-A1",
    }, CLINIC_HEADERS);
    assert.equal(select.status, 201);

    const wrongAccept = await api.call("POST", `/v1/referrals/${referralId}/accept`, { facility_id: "prov-hosp-1" }, PROV_HEADERS);
    assert.equal(wrongAccept.status, 409);

    const accepted = await api.call("POST", `/v1/referrals/${referralId}/accept`, { facility_id: "city-hosp-A1" }, CITY_HEADERS);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.current_holder_facility_id, "city-hosp-A1");

    await api.call("POST", `/v1/referrals/${referralId}/complete`, { facility_id: "city-hosp-A1" }, CITY_HEADERS);

    // 监管端：覆盖与积压
    const coverage = await api.call("GET", "/v1/regulatory/coverage", null, REG_HEADERS);
    assert.equal(coverage.status, 200);
    assert.equal(coverage.body.large_cities.total, 2);
    const cityC = coverage.body.large_cities.gaps.find((g) => g.region_code === "city-C");
    assert.equal(cityC.gap, "未挂牌");

    const backlog = await api.call("GET", "/v1/regulatory/backlog", null, REG_HEADERS);
    assert.equal(backlog.body.open_total, 0);

    // 非监管角色不能访问监管端
    const forbidden = await api.call("GET", "/v1/regulatory/coverage", null, CITY_HEADERS);
    assert.equal(forbidden.status, 403);
  } finally {
    await new Promise((resolve) => api.server.close(resolve));
  }
});

test("HTTP：基因材料白名单 + 撤回后 403，审计可查", async () => {
  const dbPath = tempDbPath();
  const api = await start(dbPath);
  try {
    await seedWorld(api);
    await api.call("POST", "/v1/authorizations", {
      auth_id: "auth-g1", patient_token: "pseudo-g1",
      scopes: ["referral_summary", "genetic_results"], genetic_facilities: ["prov-hosp-1"],
      granted_by_facility_id: "clinic-1",
    });
    const submitted = await api.call("POST", "/v1/referrals", {
      source_facility_id: "clinic-1", auth_id: "auth-g1", patient_token: "pseudo-g1",
      suspected_category: "遗传代谢类", suspected_disease_code: "RD-001", urgency: "urgent",
      origin_lat: 30.0, origin_lng: 120.0,
      documents: [
        { doc_type: "clinical-summary", content_ref: "o1" },
        { doc_type: "laboratory-index", content_ref: "o2" },
        { doc_type: "phenotype-record", content_ref: "o3" },
      ],
    }, CLINIC_HEADERS);
    const id = submitted.body.referral_id;
    await api.call("POST", `/v1/referrals/${id}/accept`, { facility_id: "prov-hosp-1" }, PROV_HEADERS);
    const attached = await api.call("POST", `/v1/referrals/${id}/documents`, {
      doc_type: "genetic-test-report", content_ref: "gene-obj-1", is_genetic: true,
    }, PROV_HEADERS);
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    const docId = attached.body.document_id;

    const okRead = await api.call("GET", `/v1/documents/${docId}`, null, PROV_HEADERS);
    assert.equal(okRead.status, 200);
    const deniedRead = await api.call("GET", `/v1/documents/${docId}`, null, CITY_HEADERS);
    assert.equal(deniedRead.status, 403);

    // 撤回授权后白名单机构同样 403
    await api.call("POST", "/v1/authorizations/auth-g1/revoke", { reason: "患者撤回" }, CLINIC_HEADERS);
    const afterRevoke = await api.call("GET", `/v1/documents/${docId}`, null, PROV_HEADERS);
    assert.equal(afterRevoke.status, 403);

    const audit = await api.call("GET", `/v1/referrals/${id}/audit`, null, REG_HEADERS);
    assert.ok(audit.body.audits.some((a) => a.decision === "deny"));
  } finally {
    await new Promise((resolve) => api.server.close(resolve));
  }
});

test("重启一致性：服务重启后数据、状态、不可变快照保持", async () => {
  const dbPath = tempDbPath();
  let api = await start(dbPath);
  let referralId;
  let snapshotId;
  try {
    await seedWorld(api);
    await api.call("POST", "/v1/authorizations", {
      auth_id: "auth-r1", patient_token: "pseudo-r1",
      scopes: ["referral_summary"], granted_by_facility_id: "clinic-1",
    });
    const submitted = await api.call("POST", "/v1/referrals", {
      source_facility_id: "clinic-1", auth_id: "auth-r1", patient_token: "pseudo-r1",
      suspected_category: "遗传代谢类", suspected_disease_code: "RD-001", urgency: "routine",
      origin_lat: 30.0, origin_lng: 120.0,
      documents: [
        { doc_type: "clinical-summary", content_ref: "o1" },
        { doc_type: "laboratory-index", content_ref: "o2" },
        { doc_type: "phenotype-record", content_ref: "o3" },
      ],
    }, CLINIC_HEADERS);
    referralId = submitted.body.referral_id;
    const candidates = await api.call("POST", `/v1/referrals/${referralId}/candidates`, {});
    snapshotId = candidates.body.snapshot_id;
    await api.call("POST", `/v1/referrals/${referralId}/accept`, { facility_id: "city-hosp-A1" }, CITY_HEADERS);
  } finally {
    await new Promise((resolve) => api.server.close(resolve));
  }

  // 重新打开同一数据库文件，验证持久化与迁移幂等
  api = await start(dbPath);
  try {
    const detail = await api.call("GET", `/v1/referrals/${referralId}`, null, CITY_HEADERS);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.status, "accepted");
    assert.equal(detail.body.current_holder_facility_id, "city-hosp-A1");
    // 事件流完整（该用例未经过候选指派，直接接诊）
    const types = detail.body.events.map((e) => e.event_type);
    assert.equal(types[0], "submitted");
    assert.ok(types.includes("accepted"));
    // 候选快照不可变
    const snap = api.server.services.db
      .prepare("SELECT results_json FROM candidate_snapshots WHERE snapshot_id = ?")
      .get(snapshotId);
    assert.ok(JSON.parse(snap.results_json).some((r) => r.facility_id === "city-hosp-A1"));
    // 一致性核查通过
    const check = await api.call("GET", "/v1/regulatory/consistency", null, REG_HEADERS);
    assert.equal(check.body.consistent, true, JSON.stringify(check.body.issues));
  } finally {
    await new Promise((resolve) => api.server.close(resolve));
  }
});
