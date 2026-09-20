import { createServer } from "node:http";
import { openDatabase } from "./database.js";
import { NetworkService } from "./domain/service.js";
import { AppError } from "./domain/errors.js";

// 机构调用：X-Facility-Id / X-User-Id；监管调用：X-Role: regulator / X-User-Id。
function actorFromHeaders(headers) {
  const role = headers["x-role"] === "regulator" ? "regulator" : "facility";
  return {
    role,
    facilityId: headers["x-facility-id"] ? String(headers["x-facility-id"]) : null,
    userId: headers["x-user-id"] ? String(headers["x-user-id"]) : null,
  };
}

// 极简声明式路由：[method, pattern(regex with :names), handler, options]
function compile(method, path, handler, options = {}) {
  const names = [];
  const pattern = path.replace(/:([a-zA-Z]+)/g, (_, n) => {
    names.push(n);
    return "([^/]+)";
  });
  return { method, regex: new RegExp(`^${pattern}$`), names, handler, options };
}

export function createApp(databasePath, { clock, recoverOnStart = false } = {}) {
  const db = openDatabase(databasePath);
  const service = new NetworkService(db, clock);
  // 服务重启时执行一次幂等恢复：标记到点未办任务、补建缺失时限、核对事件链一致性。
  if (recoverOnStart) {
    try {
      const result = service.recover();
      // eslint-disable-next-line no-console
      console.log("启动恢复完成", JSON.stringify(result));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("启动恢复失败（服务仍可启动，请检查 recovery_log）：", error);
    }
  }
  const server = createServer((request, response) => dispatch(request, response, service, db));
  server.on("close", () => {
    try { db.close(); } catch { /* 已关闭 */ }
  });
  return server;
}

export function dispatch(request, response, service, db) {
  void readJson(request).then((body) => {
    const url = new URL(request.url, "http://localhost");
    const actor = actorFromHeaders(request.headers);
    const ctx = { service, actor, query: url.searchParams, body, headers: request.headers, db };
    for (const route of ROUTES) {
      if (route.method !== request.method) continue;
      const m = url.pathname.match(route.regex);
      if (!m) continue;
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      if (route.options.regulatorOnly && actor.role !== "regulator") {
        return sendError(response, new AppError("该接口仅限监管人员", { status: 403, code: "regulator_only" }));
      }
      if (route.options.requireFacility && !actor.facilityId) {
        return sendError(response, new AppError("缺少 X-Facility-Id 机构身份头", { status: 401, code: "identity_required" }));
      }
      return Promise.resolve()
        .then(() => route.handler(ctx, params))
        .then((result) => sendJson(response, result?.status ?? 200, result?.body ?? null))
        .catch((error) => sendError(response, error));
    }
    sendError(response, new AppError(`未找到 ${request.method} ${url.pathname}`, { status: 404, code: "not_found" }));
  }).catch((error) => sendError(response, error));
}

function readJson(request) {
  if (request.method === "GET") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new AppError("请求体过大（上限 2MB）", { status: 413, code: "payload_too_large" }));
        request.destroy();
        return;
      }
      raw += chunk;
    });
    request.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError("请求体不是合法 JSON", { status: 400, code: "invalid_json" }));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  if (error instanceof AppError) {
    return sendJson(response, error.status, {
      error: error.code, message: error.message, details: error.details ?? undefined,
    });
  }
  // eslint-disable-next-line no-console
  console.error("未处理错误：", error);
  sendJson(response, 500, { error: "internal_error", message: "服务内部错误" });
}

const ok = (body, status = 200) => ({ body, status });

const ROUTES = [
  compile("GET", "/health", ({ db: database }) => {
    database.prepare("SELECT 1").get();
    return ok({ status: "ok", service: "罕见病协同转诊网络" });
  }),

  // -------- 主数据（监管维护，版本只追加） --------
  compile("POST", "/admin/facilities", ({ service, actor, body }) =>
    ok(service.registerFacility(body), 201), { regulatorOnly: true }),
  compile("POST", "/admin/population-versions", ({ service, actor, body }) =>
    ok(service.addPopulationVersion(body, actor), 201), { regulatorOnly: true }),
  compile("POST", "/admin/facilities/:id/qualifications", ({ service, actor, body }, { id }) =>
    ok({ id: service.addQualificationVersion({ ...body, facilityId: body.facilityId ?? id }, actor) }, 201), { regulatorOnly: true }),
  compile("POST", "/admin/facilities/:id/capabilities", ({ service, actor, body }, { id }) =>
    ok({ id: service.addCapabilityVersion({ ...body, facilityId: body.facilityId ?? id }, actor) }, 201), { regulatorOnly: true }),
  compile("POST", "/admin/facilities/:id/schedules", ({ service, actor, body }, { id }) =>
    ok({ id: service.addScheduleVersion({ ...body, facilityId: body.facilityId ?? id }, actor) }, 201), { regulatorOnly: true }),

  // -------- 授权 --------
  compile("POST", "/consents", ({ service, actor, body }) =>
    ok(service.grantConsent(body, actor), 201), { requireFacility: true }),
  compile("POST", "/consents/:id/withdraw", ({ service, actor, body }, { id }) =>
    ok(service.withdrawConsent({ consentId: Number(id), reason: body?.reason }, actor)), { requireFacility: true }),

  // -------- 转诊 --------
  compile("POST", "/referrals", ({ service, actor, body, headers }) => {
    const idempotencyKey = headers["idempotency-key"] ? String(headers["idempotency-key"]) : body?.idempotencyKey;
    return ok(service.submitReferral({ ...body, idempotencyKey }, actor), 201);
  }, { requireFacility: true }),
  compile("GET", "/referrals/:id", ({ service, actor }, { id }) =>
    ok(service.getReferralView(id, actor))),
  compile("GET", "/referrals/:id/timeline", ({ service, actor }, { id }) =>
    ok({ referralId: id, events: service.getTimeline(id) })),

  // 候选机构（医生主动请求；系统不自动派单/诊断）
  compile("POST", "/referrals/:id/candidates", ({ service, actor, query }, { id }) =>
    ok(service.generateCandidates(id, actor, query.get("asOf") ?? undefined))),
  compile("POST", "/referrals/:id/route", ({ service, actor, body }, { id }) =>
    ok(service.routeReferral(id, body, actor)), { requireFacility: true }),
  compile("POST", "/referrals/:id/accept", ({ service, actor }, { id }) =>
    ok(service.acceptReferral(id, actor)), { requireFacility: true }),
  compile("POST", "/referrals/:id/supplement-requests", ({ service, actor, body }, { id }) =>
    ok(service.requestSupplement(id, body, actor)), { requireFacility: true }),
  compile("POST", "/referrals/:id/supplements", ({ service, actor, body }, { id }) =>
    ok(service.submitSupplement(id, body, actor)), { requireFacility: true }),
  compile("POST", "/referrals/:id/return", ({ service, actor, body }, { id }) =>
    ok(service.returnReferral(id, body, actor)), { requireFacility: true }),
  compile("POST", "/referrals/:id/transfer", ({ service, actor, body }, { id }) =>
    ok(service.transferReferral(id, body, actor)), { requireFacility: true }),
  compile("POST", "/referrals/:id/followups", ({ service, actor, body }, { id }) =>
    ok(service.scheduleFollowup(id, body, actor)), { requireFacility: true }),
  compile("POST", "/referrals/:id/followup-results", ({ service, actor, body }, { id }) =>
    ok(service.recordFollowup(id, body, actor)), { requireFacility: true }),

  // -------- 多学科会诊 --------
  compile("POST", "/referrals/:id/consultations", ({ service, actor, body }, { id }) =>
    ok(service.requestConsultation(id, body, actor), 201), { requireFacility: true }),
  compile("POST", "/consultations/:id/schedule", ({ service, actor, body }, { id }) =>
    ok(service.scheduleConsultation(Number(id), body, actor)), { requireFacility: true }),
  compile("POST", "/consultations/:id/complete", ({ service, actor, body }, { id }) =>
    ok(service.completeConsultation(Number(id), body, actor)), { requireFacility: true }),

  // -------- 监管 as-of 口径 --------
  compile("GET", "/regulator/coverage", ({ service, query }) =>
    ok(service.coverageGap(query.get("asOf") ?? undefined)), { regulatorOnly: true }),
  compile("GET", "/regulator/backlog", ({ service, query }) =>
    ok(service.backlog(query.get("asOf") ?? undefined)), { regulatorOnly: true }),
  compile("GET", "/regulator/overdue", ({ service, query }) =>
    ok(service.overdue(query.get("asOf") ?? undefined)), { regulatorOnly: true }),
  compile("GET", "/regulator/audit", ({ service, query }) => ok(service.queryAudit({
    referralId: query.get("referralId") ?? undefined,
    patientId: query.get("patientId") ?? undefined,
    scope: query.get("scope") ?? undefined,
    action: query.get("action") ?? undefined,
    limit: Number(query.get("limit") ?? 200),
  })), { regulatorOnly: true }),

  // -------- 运维：服务重启后恢复 --------
  compile("POST", "/ops/recover", ({ service, query }) =>
    ok(service.recover(query.get("asOf") ?? undefined)), { regulatorOnly: true }),
];
