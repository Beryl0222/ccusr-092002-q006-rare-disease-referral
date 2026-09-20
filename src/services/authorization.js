import { createId, nowIso, sha256, transaction } from "../util.js";
import { ValidationError, NotFoundError, ConflictError } from "../errors.js";

export const SCOPES = Object.freeze({
  REFERRAL_SUMMARY: "referral_summary", // 去标识化转诊摘要（基础范围）
  GENETIC_RESULTS: "genetic_results", // 遗传与基因检测资料（更严格）
});

/**
 * 患者授权服务。
 * - 基础范围 referral_summary：辖区内网络成员可读
 * - 严格范围 genetic_results：默认不可读，除非该机构被显式列入 genetic_facility 白名单
 * - 撤回只置 revoked_at：撤回后所有新读取被拒并记拒绝审计；审计与历史业务事实保留
 */
export class AuthorizationService {
  constructor(db, clock = nowIso) {
    this.db = db;
    this.clock = clock;
  }

  grant(input) {
    const patientToken = requireText(input.patient_token, "patient_token");
    const scopes = normalizeScopes(input.scopes);
    const facilityId = requireText(input.granted_by_facility_id, "granted_by_facility_id");
    const geneticFacilities = Array.isArray(input.genetic_facilities)
      ? input.genetic_facilities.map(String)
      : [];
    if (scopes.includes(SCOPES.GENETIC_RESULTS) && geneticFacilities.length === 0) {
      throw new ValidationError(
        "遗传与基因检测授权必须指定可访问机构白名单（genetic_facilities）",
      );
    }
    const ts = this.clock();
    const authId = input.auth_id ?? createId("auth");
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO patient_authorizations
             (auth_id, patient_token, scope_json, genetic_facility_json,
              granted_by_facility_id, valid_from, valid_to, version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          authId,
          patientToken,
          JSON.stringify(scopes),
          JSON.stringify([...new Set(geneticFacilities)]),
          facilityId,
          input.valid_from ?? ts,
          input.valid_to ?? null,
          ts,
        );
    });
    return this.getAuthorization(authId);
  }

  getAuthorization(authId) {
    const row = this.db
      .prepare("SELECT * FROM patient_authorizations WHERE auth_id = ?")
      .get(authId);
    if (!row) throw new NotFoundError(`授权 ${authId} 不存在`);
    return hydrateAuth(row);
  }

  listByPatient(patientToken) {
    return this.db
      .prepare("SELECT * FROM patient_authorizations WHERE patient_token = ? ORDER BY created_at")
      .all(patientToken)
      .map(hydrateAuth);
  }

  /**
   * 撤回授权：置位撤回，保留记录。撤回后新读取一律拒绝。
   * 已发生的接诊、审计等业务事实不被删除（依法保留）。
   */
  revoke(authId, { reason, revokedBy } = {}) {
    const ts = this.clock();
    const result = this.db
      .prepare(
        `UPDATE patient_authorizations
         SET revoked_at = ?, revoke_reason = COALESCE(?, revoke_reason),
             revoked_by = COALESCE(?, revoked_by), version = version + 1
         WHERE auth_id = ? AND revoked_at IS NULL`,
      )
      .run(ts, reason ?? null, revokedBy ?? null, authId);
    if (result.changes === 0) {
      const auth = this.db
        .prepare("SELECT revoked_at FROM patient_authorizations WHERE auth_id = ?")
        .get(authId);
      if (!auth) throw new NotFoundError(`授权 ${authId} 不存在`);
      throw new ConflictError("授权已被撤回，不能重复撤回");
    }
    this.audit({
      authId,
      resourceType: "authorization",
      resourceId: authId,
      action: "revoke",
      decision: "allow",
      actorFacilityId: revokedBy,
      reason: reason ?? null,
    });
    return this.getAuthorization(authId);
  }

  /**
   * 访问判定。任何允许/拒绝都写审计；拒绝时抛 AuthorizationError。
   */
  authorizeAccess({ authId, facilityId, user, role, scope, referralId, resourceId, action, requestId }) {
    let authRow = null;
    try {
      authRow = this.db
        .prepare("SELECT * FROM patient_authorizations WHERE auth_id = ?")
        .get(authId);
    } catch {
      /* 下面按缺失处理 */
    }
    const ts = this.clock();
    let decision = "allow";
    let reason = null;

    if (!authRow) {
      decision = "deny";
      reason = "授权不存在";
    } else {
      const auth = hydrateAuth(authRow);
      if (auth.revoked_at) {
        decision = "deny";
        reason = "授权已撤回";
      } else if (Date.parse(auth.valid_from) > Date.parse(ts)) {
        decision = "deny";
        reason = "授权尚未生效";
      } else if (auth.valid_to && Date.parse(auth.valid_to) < Date.parse(ts)) {
        decision = "deny";
        reason = "授权已过期";
      } else if (!auth.scopes.includes(scope)) {
        decision = "deny";
        reason = `授权范围不含 ${scope}`;
      } else if (scope === SCOPES.GENETIC_RESULTS && !auth.genetic_facilities.includes(facilityId)) {
        decision = "deny";
        reason = "遗传资料仅限授权白名单机构访问";
      }
    }

    this.audit({
      ts,
      authId,
      referralId,
      actorFacilityId: facilityId,
      actorUser: user,
      actorRole: role,
      resourceType: scope ?? "authorization",
      resourceId: resourceId ?? authId,
      action: action ?? "read",
      decision,
      reason,
      requestId,
    });

    if (decision === "deny") {
      throw new AuthorizationError(reason, { authId, scope, facilityId });
    }
    return hydrateAuth(authRow);
  }

  /** 不抛错的判定版本（用于列表场景，逐项给出可见性）。 */
  canAccess(authId, facilityId, scope, ts = this.clock()) {
    const row = this.db
      .prepare("SELECT * FROM patient_authorizations WHERE auth_id = ?")
      .get(authId);
    if (!row) return { allowed: false, reason: "授权不存在" };
    const auth = hydrateAuth(row);
    if (auth.revoked_at) return { allowed: false, reason: "授权已撤回" };
    if (Date.parse(auth.valid_from) > Date.parse(ts)) return { allowed: false, reason: "授权尚未生效" };
    if (auth.valid_to && Date.parse(auth.valid_to) < Date.parse(ts)) {
      return { allowed: false, reason: "授权已过期" };
    }
    if (!auth.scopes.includes(scope)) return { allowed: false, reason: `授权范围不含 ${scope}` };
    if (scope === SCOPES.GENETIC_RESULTS && !auth.genetic_facilities.includes(facilityId)) {
      return { allowed: false, reason: "遗传资料仅限授权白名单机构访问" };
    }
    return { allowed: true, reason: null };
  }

  audit(entry) {
    const ts = entry.ts ?? this.clock();
    this.db
      .prepare(
        `INSERT INTO access_audits
           (audit_id, ts, actor_facility_id, actor_user, actor_role, referral_id, auth_id,
            resource_type, resource_id, action, decision, reason, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createId("aud"),
        ts,
        entry.actorFacilityId ?? null,
        entry.actorUser ?? null,
        entry.actorRole ?? null,
        entry.referralId ?? null,
        entry.authId ?? null,
        entry.resourceType,
        entry.resourceId ?? null,
        entry.action,
        entry.decision,
        entry.reason ?? null,
        entry.requestId ?? null,
      );
  }

  static contactHash(value) {
    return sha256(value);
  }
}

export class AuthorizationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "AuthorizationError";
    this.statusCode = 403;
    this.details = details;
  }
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new ValidationError("scopes 必须为非空数组");
  }
  const allowed = new Set(Object.values(SCOPES));
  const result = [...new Set(scopes.map(String))];
  if (result.some((s) => !allowed.has(s))) {
    throw new ValidationError(`非法授权范围：${result.filter((s) => !allowed.has(s)).join(", ")}`);
  }
  return result;
}

function hydrateAuth(row) {
  return {
    ...row,
    scopes: JSON.parse(row.scope_json),
    genetic_facilities: JSON.parse(row.genetic_facility_json),
  };
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`字段 ${field} 必填`);
  }
  return value;
}
