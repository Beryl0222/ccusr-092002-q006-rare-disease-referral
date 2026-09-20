import { nowIso, transaction } from "../util.js";
import { ValidationError, NotFoundError, ConflictError } from "../errors.js";

function effectiveRow(rows) {
  return rows[0] ?? null; // 查询均按 valid_from DESC，首条即当时有效版本
}

/** 机构与辖区目录：所有能力数据以版本链维护，只追加新版本。 */
export class RegistryService {
  constructor(db, clock = nowIso) {
    this.db = db;
    this.clock = clock;
  }

  registerFacility(input) {
    const facilityId = requireText(input.facility_id, "facility_id");
    const ts = this.clock();
    const v = input.version ?? {};
    const name = requireText(v.name, "version.name");
    const level = requireText(v.level, "version.level");
    const regionCode = requireText(v.region_code, "version.region_code");
    const lat = Number(v.lat);
    const lng = Number(v.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new ValidationError("机构坐标无效");
    }
    const validFrom = input.valid_from ?? ts;
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO facilities (facility_id, created_at) VALUES (?, ?)
           ON CONFLICT(facility_id) DO NOTHING`,
        )
        .run(facilityId, ts);
      this.#guardVersionOverlap("facility_versions", "facility_id", facilityId, validFrom);
      this.db
        .prepare(
          `INSERT INTO facility_versions (facility_id, valid_from, name, level, region_code, lat, lng)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(facilityId, validFrom, name, level, regionCode, lat, lng);
    });
    return this.getFacility(facilityId, validFrom);
  }

  addFacilityVersion(facilityId, input) {
    const ts = this.clock();
    const validFrom = input.valid_from ?? ts;
    const current = this.db
      .prepare("SELECT facility_id FROM facilities WHERE facility_id = ?")
      .get(facilityId);
    if (!current) throw new NotFoundError(`机构 ${facilityId} 不存在`);
    const latest = this.getFacility(facilityId);
    transaction(this.db, () => {
      this.#guardVersionOverlap("facility_versions", "facility_id", facilityId, validFrom);
      this.db
        .prepare(
          `INSERT INTO facility_versions (facility_id, valid_from, name, level, region_code, lat, lng)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          facilityId,
          validFrom,
          requireText(input.name ?? latest?.name, "name"),
          requireText(input.level ?? latest?.level, "level"),
          requireText(input.region_code ?? latest?.region_code, "region_code"),
          numOr(input.lat, latest?.lat),
          numOr(input.lng, latest?.lng),
        );
    });
    return this.getFacility(facilityId, validFrom);
  }

  getFacility(facilityId, asOf = this.clock()) {
    return this.db
      .prepare(
        `SELECT * FROM facility_versions
         WHERE facility_id = ? AND valid_from <= ?
         ORDER BY valid_from DESC LIMIT 1`,
      )
      .get(facilityId, asOf);
  }

  listFacilities(asOf = this.clock()) {
    return this.db
      .prepare(
        `SELECT f.facility_id, fv.* FROM facilities f
         JOIN facility_versions fv ON fv.facility_id = f.facility_id
         WHERE fv.valid_from = (
           SELECT MAX(valid_from) FROM facility_versions
           WHERE facility_id = f.facility_id AND valid_from <= ?
         )
         ORDER BY f.facility_id`,
      )
      .all(asOf);
  }

  putPopulationVersion(input) {
    const regionCode = requireText(input.region_code, "region_code");
    const regionName = requireText(input.region_name, "region_name");
    const regionLevel = requireText(input.region_level, "region_level");
    const population = Number(input.population);
    if (!Number.isInteger(population) || population < 0) {
      throw new ValidationError("人口数必须为非负整数");
    }
    const validFrom = input.valid_from ?? this.clock();
    transaction(this.db, () => {
      this.#guardVersionOverlap("population_versions", "region_code", regionCode, validFrom);
      this.db
        .prepare(
          `INSERT INTO population_versions (region_code, valid_from, region_name, region_level, population)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(regionCode, validFrom, regionName, regionLevel, population);
    });
    return this.getPopulation(regionCode, validFrom);
  }

  getPopulation(regionCode, asOf = this.clock()) {
    return effectiveRow(
      this.db
        .prepare(
          `SELECT * FROM population_versions
           WHERE region_code = ? AND valid_from <= ?
           ORDER BY valid_from DESC LIMIT 1`,
        )
        .all(regionCode, asOf),
    );
  }

  listPopulations(asOf = this.clock()) {
    return this.db
      .prepare(
        `SELECT pv.* FROM population_versions pv
         WHERE pv.valid_from = (
           SELECT MAX(valid_from) FROM population_versions
           WHERE region_code = pv.region_code AND valid_from <= ?
         )
         ORDER BY pv.region_code`,
      )
      .all(asOf);
  }

  putQualification(input) {
    const facilityId = requireText(input.facility_id, "facility_id");
    const qualType = requireText(input.qual_type, "qual_type");
    const status = input.status ?? "active";
    const validFrom = input.valid_from ?? this.clock();
    this.#assertFacility(facilityId);
    transaction(this.db, () => {
      this.#guardVersionOverlap2(
        "qualification_versions",
        "facility_id",
        facilityId,
        "qual_type",
        qualType,
        validFrom,
      );
      this.db
        .prepare(
          `INSERT INTO qualification_versions (facility_id, valid_from, qual_type, status, issued_by)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(facilityId, validFrom, qualType, status, input.issued_by ?? null);
    });
    return this.getQualification(facilityId, qualType, validFrom);
  }

  getQualification(facilityId, qualType, asOf = this.clock()) {
    return this.db
      .prepare(
        `SELECT * FROM qualification_versions
         WHERE facility_id = ? AND qual_type = ? AND valid_from <= ?
         ORDER BY valid_from DESC LIMIT 1`,
      )
      .get(facilityId, qualType, asOf);
  }

  /** 机构在 asOf 时是否持有有效的罕见病门诊资质（挂牌且未撤销）。 */
  hasActiveQualification(facilityId, asOf = this.clock()) {
    const row = this.db
      .prepare(
        `SELECT status FROM qualification_versions
         WHERE facility_id = ? AND valid_from <= ?
         ORDER BY valid_from DESC LIMIT 1`,
      )
      .get(facilityId, asOf);
    return row?.status === "active";
  }

  putCapability(input) {
    const facilityId = requireText(input.facility_id, "facility_id");
    const diseaseCode = requireText(input.disease_code, "disease_code");
    const status = input.status ?? "active";
    const capLevel = requireText(input.cap_level ?? "specialty", "cap_level");
    const validFrom = input.valid_from ?? this.clock();
    this.#assertFacility(facilityId);
    transaction(this.db, () => {
      this.#guardVersionOverlap2(
        "capability_versions",
        "facility_id",
        facilityId,
        "disease_code",
        diseaseCode,
        validFrom,
      );
      this.db
        .prepare(
          `INSERT INTO capability_versions
             (facility_id, disease_code, valid_from, disease_name, disease_category, specialty, cap_level, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          facilityId,
          diseaseCode,
          validFrom,
          requireText(input.disease_name, "disease_name"),
          requireText(input.disease_category, "disease_category"),
          requireText(input.specialty, "specialty"),
          capLevel,
          status,
        );
    });
    return this.getCapability(facilityId, diseaseCode, validFrom);
  }

  getCapability(facilityId, diseaseCode, asOf = this.clock()) {
    return this.db
      .prepare(
        `SELECT * FROM capability_versions
         WHERE facility_id = ? AND disease_code = ? AND valid_from <= ?
         ORDER BY valid_from DESC LIMIT 1`,
      )
      .get(facilityId, diseaseCode, asOf);
  }

  listCapabilities(diseaseCode, asOf = this.clock()) {
    return this.db
      .prepare(
        `SELECT cv.* FROM capability_versions cv
         WHERE cv.disease_code = ? AND cv.status = 'active' AND cv.valid_from <= ?
         AND cv.valid_from = (
           SELECT MAX(valid_from) FROM capability_versions
           WHERE facility_id = cv.facility_id AND disease_code = cv.disease_code AND valid_from <= ?
         )
         ORDER BY cv.facility_id`,
      )
      .all(diseaseCode, asOf, asOf);
  }

  putSchedule(input) {
    const facilityId = requireText(input.facility_id, "facility_id");
    const specialty = requireText(input.specialty, "specialty");
    const weeklySlots = Number(input.weekly_slots);
    const baseLeadDays = Number(input.base_lead_days);
    if (!Number.isInteger(weeklySlots) || weeklySlots < 0) {
      throw new ValidationError("weekly_slots 必须为非负整数");
    }
    if (!Number.isInteger(baseLeadDays) || baseLeadDays < 0) {
      throw new ValidationError("base_lead_days 必须为非负整数");
    }
    const validFrom = input.valid_from ?? this.clock();
    this.#assertFacility(facilityId);
    transaction(this.db, () => {
      this.#guardVersionOverlap2(
        "schedule_versions",
        "facility_id",
        facilityId,
        "specialty",
        specialty,
        validFrom,
      );
      this.db
        .prepare(
          `INSERT INTO schedule_versions
             (facility_id, specialty, valid_from, weekly_slots, base_lead_days, status)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(facilityId, specialty, validFrom, weeklySlots, baseLeadDays, input.status ?? "active");
    });
    return this.getSchedule(facilityId, specialty, validFrom);
  }

  getSchedule(facilityId, specialty, asOf = this.clock()) {
    return this.db
      .prepare(
        `SELECT * FROM schedule_versions
         WHERE facility_id = ? AND specialty = ? AND valid_from <= ?
         ORDER BY valid_from DESC LIMIT 1`,
      )
      .get(facilityId, specialty, asOf);
  }

  /**
   * 估计 asOf 时某机构某专科的候诊天数：
   * 基础排期 + 未完成号源占用（每周号源折算每天）。号源暂停时返回 null（不可接诊）。
   */
  estimateWaitingDays(facilityId, specialty, asOfIso = this.clock()) {
    const schedule = this.getSchedule(facilityId, specialty, asOfIso);
    if (!schedule || schedule.status !== "active" || schedule.weekly_slots === 0) {
      return null;
    }
    const pending = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM referral_events e
         JOIN referrals r ON r.referral_id = e.referral_id
         WHERE e.recorded_at <= ?
           AND e.open_phase IN ('triage','supplement_review','mdt_feedback','transfer')
           AND e.assignee_facility_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM referral_events c
             WHERE c.referral_id = e.referral_id AND c.seq > e.seq AND c.recorded_at <= ?
           )`,
      )
      .get(asOfIso, facilityId, asOfIso).n;
    const dailyCapacity = Math.max(schedule.weekly_slots / 7, 0.1);
    return schedule.base_lead_days + Math.round(pending / dailyCapacity);
  }

  #assertFacility(facilityId) {
    const row = this.db.prepare("SELECT 1 FROM facilities WHERE facility_id = ?").get(facilityId);
    if (!row) throw new NotFoundError(`机构 ${facilityId} 不存在`);
  }

  // 同一实体不允许两条版本具有相同生效时刻（那会让"当时有效版本"不再唯一）
  #guardVersionOverlap(table, keyColumn, keyValue, validFrom) {
    const row = this.db
      .prepare(`SELECT 1 FROM ${table} WHERE ${keyColumn} = ? AND valid_from = ?`)
      .get(keyValue, validFrom);
    if (row) throw new ConflictError(`${table} 在 ${validFrom} 已存在版本，请改用新的生效时间`);
  }

  #guardVersionOverlap2(table, col1, v1, col2, v2, validFrom) {
    const row = this.db
      .prepare(
        `SELECT 1 FROM ${table} WHERE ${col1} = ? AND ${col2} = ? AND valid_from = ?`,
      )
      .get(v1, v2, validFrom);
    if (row) throw new ConflictError(`${table} 在 ${validFrom} 已存在版本，请改用新的生效时间`);
  }
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`字段 ${field} 必填`);
  }
  return value;
}

function numOr(value, fallback) {
  const n = Number(value);
  if (value == null || value === "") {
    if (fallback == null) throw new ValidationError("数值字段缺失");
    return fallback;
  }
  if (!Number.isFinite(n)) throw new ValidationError("数值字段无效");
  return n;
}

