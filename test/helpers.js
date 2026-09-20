import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../src/database.js";
import { RegistryService } from "../src/services/registry.js";
import { AuthorizationService } from "../src/services/authorization.js";
import { ReferralService } from "../src/services/referral.js";
import { RegulatoryService } from "../src/services/regulatory.js";

export const BASE_TIME = "2026-01-01T00:00:00.000Z";

export class FakeClock {
  constructor(start = BASE_TIME) {
    this.current = start;
  }
  now() {
    return this.current;
  }
  advance(hours) {
    this.current = new Date(Date.parse(this.current) + hours * 3_600_000).toISOString();
    return this.current;
  }
  advanceDays(days) {
    return this.advance(days * 24);
  }
  set(iso) {
    this.current = iso;
  }
}

export function createHarness({ dbPath = ":memory:", clock = new FakeClock() } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec("PRAGMA journal_mode = WAL");
  migrateDatabase(db);
  const registry = new RegistryService(db, () => clock.now());
  const authz = new AuthorizationService(db, () => clock.now());
  const referrals = new ReferralService(db, { registry, authz, clock: () => clock.now() });
  const regulatory = new RegulatoryService(db, { registry, clock: () => clock.now() });
  return {
    db,
    clock,
    registry,
    authz,
    referrals,
    regulatory,
    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
    cleanup() {
      if (dbPath !== ":memory:") {
        for (const suffix of ["", "-wal", "-shm"]) {
          rmSync(dbPath + suffix, { force: true });
        }
      }
    },
  };
}

export function tempDbPath() {
  return join(tmpdir(), `rd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/**
 * 标准监管场景：
 * - city-A：人口 2025 年 280 万（未达标），2026 年 400 万（达标）；有省级医院与两所市医院
 * - city-B：200 万，永不纳入三百万门槛
 * - city-C：350 万但无任何挂牌机构（覆盖缺口）
 * - city-hosp-A2 挂牌但号源暂停（挂牌而不可达）
 */
export function seedScenario(h, { validFrom = "2026-01-01T00:00:00.000Z" } = {}) {
  const r = h.registry;
  // 人口版本
  r.putPopulationVersion({ region_code: "city-A", region_name: "A 市", region_level: "city", population: 2_800_000, valid_from: "2025-01-01T00:00:00.000Z" });
  r.putPopulationVersion({ region_code: "city-A", region_name: "A 市", region_level: "city", population: 4_000_000, valid_from: validFrom });
  r.putPopulationVersion({ region_code: "city-B", region_name: "B 市", region_level: "city", population: 2_000_000, valid_from: validFrom });
  r.putPopulationVersion({ region_code: "city-C", region_name: "C 市", region_level: "city", population: 3_500_000, valid_from: validFrom });

  // 机构（坐标：经度区分距离，clinic-1 最靠近 city-hosp-A1）
  r.registerFacility({
    facility_id: "clinic-1",
    valid_from: validFrom,
    version: { name: "城关社区卫生服务中心", level: "primary", region_code: "city-A", lat: 30.0, lng: 120.0 },
  });
  r.registerFacility({
    facility_id: "prov-hosp-1",
    valid_from: validFrom,
    version: { name: "省人民医院罕见病中心", level: "provincial", region_code: "city-A", lat: 30.5, lng: 120.5 },
  });
  r.registerFacility({
    facility_id: "city-hosp-A1",
    valid_from: validFrom,
    version: { name: "A 市第一医院", level: "city", region_code: "city-A", lat: 30.02, lng: 120.02 },
  });
  r.registerFacility({
    facility_id: "city-hosp-A2",
    valid_from: validFrom,
    version: { name: "A 市第二医院", level: "city", region_code: "city-A", lat: 30.1, lng: 120.1 },
  });

  // 资质
  for (const id of ["prov-hosp-1", "city-hosp-A1", "city-hosp-A2"]) {
    r.putQualification({ facility_id: id, qual_type: "rare-disease-clinic", status: "active", valid_from: validFrom });
  }

  // 病种能力
  r.putCapability({
    facility_id: "prov-hosp-1", disease_code: "RD-001", disease_name: "苯丙酮尿症",
    disease_category: "遗传代谢类", specialty: "遗传代谢科", cap_level: "designated", status: "active", valid_from: validFrom,
  });
  r.putCapability({
    facility_id: "city-hosp-A1", disease_code: "RD-001", disease_name: "苯丙酮尿症",
    disease_category: "遗传代谢类", specialty: "遗传代谢科", cap_level: "specialty", status: "active", valid_from: validFrom,
  });
  r.putCapability({
    facility_id: "city-hosp-A2", disease_code: "RD-001", disease_name: "苯丙酮尿症",
    disease_category: "遗传代谢类", specialty: "遗传代谢科", cap_level: "general", status: "active", valid_from: validFrom,
  });

  // 排班号源：A2 暂停
  r.putSchedule({ facility_id: "prov-hosp-1", specialty: "遗传代谢科", weekly_slots: 20, base_lead_days: 5, status: "active", valid_from: validFrom });
  r.putSchedule({ facility_id: "city-hosp-A1", specialty: "遗传代谢科", weekly_slots: 35, base_lead_days: 2, status: "active", valid_from: validFrom });
  r.putSchedule({ facility_id: "city-hosp-A2", specialty: "遗传代谢科", weekly_slots: 0, base_lead_days: 10, status: "suspended", valid_from: validFrom });

  return {
    clinic: "clinic-1",
    provincial: "prov-hosp-1",
    cityHospital: "city-hosp-A1",
    suspendedHospital: "city-hosp-A2",
  };
}

export function baseReferralInput(overrides = {}) {
  return {
    referral_id: "ref-001",
    source_facility_id: "clinic-1",
    patient_token: "pseudonym-7a91",
    auth_id: "auth-001",
    birth_year: 2018,
    gender: "F",
    residence_region_code: "city-A",
    contact_hash: "hash-contact-x",
    phenotype_codes: ["HP:0001250", "HP:0001943"],
    suspected_category: "遗传代谢类",
    suspected_disease_code: "RD-001",
    urgency: "priority",
    origin_lat: 30.0,
    origin_lng: 120.0,
    submitter: "dr-li",
    documents: [
      { doc_type: "clinical-summary", content_ref: "obj://sum-1" },
      { doc_type: "laboratory-index", content_ref: "obj://lab-1" },
      { doc_type: "phenotype-record", content_ref: "obj://pheno-1" },
    ],
    checks: [
      { check_code: "LAB-PHE", check_name: "血苯丙氨酸", check_date: "2025-12-28", facility_id: "clinic-1" },
    ],
    ...overrides,
  };
}
