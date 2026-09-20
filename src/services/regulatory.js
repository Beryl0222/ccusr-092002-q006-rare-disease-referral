import { createId, nowIso } from "../util.js";
import { COVERAGE_POPULATION_THRESHOLD } from "../policy.js";
import { replayState, overdueOpenStates, TERMINAL_STATUSES } from "./events.js";

/**
 * 监管服务：所有判断都按 as_of 时点重建。
 * - 人口/机构/资质/能力/排班取 valid_from <= as_of 的最新版本
 * - 转诊状态由 append-only 事件重放（recorded_at <= as_of）
 * - 报告本身写入 regulatory_snapshots，只追加，永不重写
 */
export class RegulatoryService {
  constructor(db, { registry, clock = nowIso } = {}) {
    this.db = db;
    this.registry = registry;
    this.clock = clock;
  }

  /**
   * 覆盖缺口：挂牌（有有效资质）与真正可达（资质 + 至少一项活跃病种能力 + 该专科有活跃号源）分开统计。
   * 范围：省级医院 + 三百万人口以上地市。
   */
  coverageReport({ asOf = this.clock(), persist = true } = {}) {
    const populations = this.registry.listPopulations(asOf);
    const facilities = this.registry.listFacilities(asOf);

    const facilityStatus = (facilityId) => {
      const listed = this.registry.hasActiveQualification(facilityId, asOf);
      let reachable = false;
      let reachableSpecialties = [];
      if (listed) {
        const caps = this.db
          .prepare(
            `SELECT DISTINCT specialty FROM capability_versions cv
             WHERE cv.facility_id = ? AND cv.status = 'active' AND cv.valid_from <= ?
             AND cv.valid_from = (
               SELECT MAX(valid_from) FROM capability_versions
               WHERE facility_id = cv.facility_id AND disease_code = cv.disease_code AND valid_from <= ?
             )`,
          )
          .all(facilityId, asOf, asOf);
        reachableSpecialties = caps
          .map((c) => c.specialty)
          .filter((specialty) => {
            const s = this.registry.getSchedule(facilityId, specialty, asOf);
            return s && s.status === "active" && s.weekly_slots > 0;
          });
        reachable = reachableSpecialties.length > 0;
      }
      return { listed, reachable, reachableSpecialties };
    };

    // 省级医院覆盖（不受地市人口门槛限制）
    const provincial = facilities.filter((f) => f.level === "provincial");
    const provincialDetail = provincial.map((f) => ({
      facility_id: f.facility_id,
      name: f.name,
      region_code: f.region_code,
      ...facilityStatus(f.facility_id),
    }));

    // 三百万人口以上地市
    const largeCities = populations.filter(
      (p) => p.region_level === "city" && p.population >= COVERAGE_POPULATION_THRESHOLD,
    );
    const cityDetail = largeCities.map((city) => {
      const cityFacilities = facilities.filter(
        (f) => f.region_code === city.region_code && f.level !== "provincial",
      );
      const detail = cityFacilities.map((f) => ({
        facility_id: f.facility_id,
        name: f.name,
        ...facilityStatus(f.facility_id),
      }));
      const listed = detail.filter((d) => d.listed);
      const reachable = detail.filter((d) => d.reachable);
      return {
        region_code: city.region_code,
        region_name: city.region_name,
        population_as_of: city.population,
        population_version_valid_from: city.valid_from,
        listed_count: listed.length,
        reachable_count: reachable.length,
        gap:
          reachable.length === 0
            ? listed.length === 0
              ? "未挂牌"
              : "已挂牌但无活跃病种能力或号源，服务不可达"
            : null,
        facilities: detail,
      };
    });

    const report = {
      kind: "coverage",
      as_of: asOf,
      policy: {
        population_threshold: COVERAGE_POPULATION_THRESHOLD,
        reachable_definition: "有效门诊资质 + 至少一项活跃病种能力 + 对应专科有活跃坐诊号源",
      },
      provincial: {
        listed_count: provincialDetail.filter((d) => d.listed).length,
        reachable_count: provincialDetail.filter((d) => d.reachable).length,
        facilities: provincialDetail,
      },
      large_cities: {
        total: cityDetail.length,
        covered: cityDetail.filter((c) => c.reachable_count > 0).length,
        gaps: cityDetail.filter((c) => c.gap),
        regions: cityDetail,
      },
    };
    if (persist) report.report_id = this.#persist("coverage", null, report, asOf);
    return report;
  }

  /**
   * 转诊积压与超时：按 as_of 重放事件。
   * backlog = 当时未终结的转诊；overdue = 最近事件开有待办且时限已过。
   */
  backlogReport({ asOf = this.clock(), regionScope = null, persist = true } = {}) {
    const referralIds = this.db
      .prepare("SELECT referral_id, created_at FROM referrals WHERE created_at <= ? ORDER BY created_at")
      .all(asOf)
      .map((r) => r.referral_id);

    const byPhase = new Map();
    const items = [];
    for (const id of referralIds) {
      const state = replayState(this.db, id, asOf);
      if (!state || TERMINAL_STATUSES.has(state.status)) continue;
      const referral = this.db.prepare("SELECT * FROM referrals WHERE referral_id = ?").get(id);
      const sourceFacility = this.registry.getFacility(referral.source_facility_id, asOf);
      if (regionScope && sourceFacility?.region_code !== regionScope) continue;
      const overdue = state.sla_due_at != null && Date.parse(state.sla_due_at) < Date.parse(asOf);
      const item = {
        referral_id: id,
        urgency: referral.urgency,
        status: state.status,
        open_phase: state.open_phase,
        assignee_facility_id: state.assignee_facility_id,
        source_facility_id: referral.source_facility_id,
        source_region_code: sourceFacility?.region_code ?? null,
        sla_due_at: state.sla_due_at,
        overdue,
        submitted_at: referral.created_at,
      };
      items.push(item);
      const key = `${state.open_phase ?? state.status}`;
      const entry = byPhase.get(key) ?? { total: 0, overdue: 0 };
      entry.total += 1;
      if (overdue) entry.overdue += 1;
      byPhase.set(key, entry);
    }

    const overdueEvents = overdueOpenStates(this.db, asOf);
    const overdueDetail = overdueEvents
      .map((e) => {
        const referral = this.db.prepare("SELECT * FROM referrals WHERE referral_id = ?").get(e.referral_id);
        if (!referral) return null;
        const sourceFacility = this.registry.getFacility(referral.source_facility_id, asOf);
        if (regionScope && sourceFacility?.region_code !== regionScope) return null;
        return {
          referral_id: e.referral_id,
          phase: e.open_phase,
          assignee_facility_id: e.assignee_facility_id,
          sla_due_at: e.sla_due_at,
          overdue_hours: Math.round(
            (Date.parse(asOf) - Date.parse(e.sla_due_at)) / 3_600_000,
          ),
          urgency: referral.urgency,
          source_region_code: sourceFacility?.region_code ?? null,
        };
      })
      .filter(Boolean);

    const report = {
      kind: "backlog",
      as_of: asOf,
      region_scope: regionScope,
      open_total: items.length,
      overdue_total: overdueDetail.length,
      by_phase: Object.fromEntries([...byPhase.entries()].map(([k, v]) => [k, v])),
      overdue: overdueDetail,
      open_referrals: items,
    };
    if (persist) report.report_id = this.#persist("backlog", regionScope, report, asOf);
    return report;
  }

  /** 一致性核查：供重启后与日常核验使用，返回发现的问题（空数组即一致）。 */
  consistencyCheck({ asOf = this.clock() } = {}) {
    const issues = [];

    // 1. 投影 referrals.status 必须与事件重放一致（投影可由事件重建）
    const rows = this.db.prepare("SELECT referral_id, status FROM referrals").all();
    for (const row of rows) {
      const state = replayState(this.db, row.referral_id, asOf);
      if (state && state.status !== row.status) {
        issues.push({
          type: "projection_drift",
          referral_id: row.referral_id,
          projected: row.status,
          replayed: state.status,
        });
      }
    }

    // 2. 同一转诊不得出现"未通过转接流程的并发接诊"：
    //    按事件顺序走查，处于持有状态时，另一机构的 accepted（而非 transfer_accepted）即为冲突。
    const acceptedReferrals = this.db
      .prepare(
        `SELECT DISTINCT referral_id FROM referral_events
         WHERE event_type IN ('accepted','transfer_accepted')`,
      )
      .all();
    for (const { referral_id } of acceptedReferrals) {
      const evs = this.db
        .prepare(
          `SELECT event_type, actor_facility_id FROM referral_events WHERE referral_id = ? ORDER BY seq`,
        )
        .all(referral_id);
      let holder = null;
      for (const e of evs) {
        if (e.event_type === "accepted") {
          if (holder != null && holder !== e.actor_facility_id) {
            issues.push({ type: "concurrent_acceptance", referral_id, holders: [holder, e.actor_facility_id] });
            break;
          }
          holder = e.actor_facility_id;
        } else if (e.event_type === "transfer_requested") {
          // 转接期间责任暂交目标机构响应，原持有者保留，transfer_accepted 后才正式切换
        } else if (e.event_type === "transfer_accepted") {
          holder = e.actor_facility_id;
        } else if (e.event_type === "transfer_declined" || e.event_type === "transfer_expired") {
          // 目标未接诊，持有人不变（仍为发起转接的机构）
        } else if (e.event_type === "returned") {
          holder = null;
        }
      }
    }

    // 3. 每个转诊的事件 seq 必须连续
    const seqGaps = this.db
      .prepare(
        `SELECT referral_id, GROUP_CONCAT(seq) AS seqs FROM referral_events GROUP BY referral_id`,
      )
      .all();
    for (const row of seqGaps) {
      const seqs = row.seqs.split(",").map(Number);
      for (let i = 0; i < seqs.length; i += 1) {
        if (seqs[i] !== i + 1) {
          issues.push({ type: "event_seq_gap", referral_id: row.referral_id });
          break;
        }
      }
    }

    // 4. 悬挂的 requested 邀请/转接不得超过各自时限（未清扫）
    const staleAssignments = this.db
      .prepare("SELECT COUNT(*) AS n FROM referral_assignments WHERE status = 'requested' AND deadline_at < ?")
      .get(asOf).n;
    if (staleAssignments > 0) issues.push({ type: "unswept_assignments", count: staleAssignments });
    const staleTransfers = this.db
      .prepare("SELECT COUNT(*) AS n FROM transfers WHERE status = 'requested' AND deadline_at < ?")
      .get(asOf).n;
    if (staleTransfers > 0) issues.push({ type: "unswept_transfers", count: staleTransfers });

    return { checked_at: asOf, consistent: issues.length === 0, issues };
  }

  getSnapshot(reportId) {
    const row = this.db.prepare("SELECT * FROM regulatory_snapshots WHERE report_id = ?").get(reportId);
    if (!row) return null;
    return { ...row, payload: JSON.parse(row.payload_json) };
  }

  listSnapshots({ kind, asOf } = {}) {
    let sql = "SELECT * FROM regulatory_snapshots WHERE 1=1";
    const params = [];
    if (kind) {
      sql += " AND kind = ?";
      params.push(kind);
    }
    if (asOf) {
      sql += " AND as_of = ?";
      params.push(asOf);
    }
    sql += " ORDER BY generated_at DESC";
    return this.db.prepare(sql).all(...params).map((r) => ({ ...r, payload: JSON.parse(r.payload_json) }));
  }

  #persist(kind, regionScope, payload, asOf) {
    const reportId = createId("rpt");
    this.db
      .prepare(
        `INSERT INTO regulatory_snapshots (report_id, generated_at, as_of, kind, region_scope, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(reportId, this.clock(), asOf, kind, regionScope, JSON.stringify(payload));
    return reportId;
  }
}
