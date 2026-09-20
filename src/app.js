import { createServer } from "node:http";
import { openDatabase } from "./database.js";
import { readJsonBody, sendJson } from "./util.js";
import { RegistryService } from "./services/registry.js";
import { AuthorizationService } from "./services/authorization.js";
import { ReferralService } from "./services/referral.js";
import { RegulatoryService } from "./services/regulatory.js";

export function createApp(databasePath = process.env.DATABASE_PATH ?? "referral-network.db") {
  const db = openDatabase(databasePath);
  const registry = new RegistryService(db);
  const authz = new AuthorizationService(db);
  const referrals = new ReferralService(db, { registry, authz });
  const regulatory = new RegulatoryService(db, { registry });
  const services = { db, registry, authz, referrals, regulatory };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const ctx = {
      services,
      actor: {
        facility_id: request.headers["x-facility-id"] || null,
        user: request.headers["x-user"] || null,
        role: request.headers["x-role"] || null,
      },
      query: url.searchParams,
    };
    try {
      const route = matchRoute(request.method, url.pathname);
      if (!route) {
        sendJson(response, 404, { error: "未找到对应资源" });
        return;
      }
      if (route.regulatorOnly && ctx.actor.role !== "regulator") {
        sendJson(response, 403, { error: "该资源仅限监管角色（x-role: regulator）" });
        return;
      }
      const body = ["POST", "PUT", "PATCH"].includes(request.method)
        ? await readJsonBody(request)
        : {};
      const result = await route.handler(ctx, body, route.params);
      sendJson(response, result.status ?? 200, result.body);
    } catch (error) {
      const status = error.statusCode ?? 500;
      if (status >= 500) console.error(error);
      sendJson(response, status, {
        error: error.message ?? "内部错误",
        details: error.details ?? undefined,
      });
    }
  });

  const originalClose = server.close.bind(server);
  server.close = (callback) =>
    originalClose(() => {
      try {
        db.close();
      } catch {
        /* 已关闭则忽略 */
      }
      callback?.();
    });
  server.services = services;
  return server;
}

// 简单模式路由：:param 段匹配
function matchRoute(method, pathname) {
  const segments = pathname.split("/").filter(Boolean);
  for (const route of ROUTES) {
    if (route.method !== method || route.segments.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i += 1) {
      const pattern = route.segments[i];
      if (pattern.startsWith(":")) params[pattern.slice(1)] = decodeURIComponent(segments[i]);
      else if (pattern !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { ...route, params };
  }
  return null;
}

const asOf = (ctx) => ctx.query.get("as_of") ?? undefined;

const ROUTES = [
  // 健康检查
  {
    method: "GET",
    segments: ["health"],
    handler: (ctx) => {
      ctx.services.db.prepare("SELECT 1").get();
      return {
        status: 200,
        body: { status: "ok", service: "罕见病协同转诊网络" },
      };
    },
  },

  // ---------- 机构目录 ----------
  {
    method: "POST",
    segments: ["v1", "facilities"],
    handler: (ctx, body) => ({ status: 201, body: ctx.services.registry.registerFacility(body) }),
  },
  {
    method: "POST",
    segments: ["v1", "facilities", ":id", "versions"],
    handler: (ctx, body, { id }) => ({ status: 201, body: ctx.services.registry.addFacilityVersion(id, body) }),
  },
  {
    method: "GET",
    segments: ["v1", "facilities"],
    handler: (ctx) => ({ status: 200, body: { facilities: ctx.services.registry.listFacilities(asOf(ctx)) } }),
  },
  {
    method: "GET",
    segments: ["v1", "facilities", ":id"],
    handler: (ctx, _body, { id }) => {
      const facility = ctx.services.registry.getFacility(id, asOf(ctx));
      if (!facility) return { status: 404, body: { error: "机构不存在或该时点无有效版本" } };
      return { status: 200, body: facility };
    },
  },
  {
    method: "PUT",
    segments: ["v1", "facilities", ":id", "qualifications"],
    handler: (ctx, body, { id }) =>
      ({ status: 200, body: ctx.services.registry.putQualification({ ...body, facility_id: id }) }),
  },
  {
    method: "PUT",
    segments: ["v1", "facilities", ":id", "capabilities"],
    handler: (ctx, body, { id }) =>
      ({ status: 200, body: ctx.services.registry.putCapability({ ...body, facility_id: id }) }),
  },
  {
    method: "PUT",
    segments: ["v1", "facilities", ":id", "schedules"],
    handler: (ctx, body, { id }) =>
      ({ status: 200, body: ctx.services.registry.putSchedule({ ...body, facility_id: id }) }),
  },

  // ---------- 人口版本 ----------
  {
    method: "PUT",
    segments: ["v1", "populations"],
    handler: (ctx, body) => ({ status: 200, body: ctx.services.registry.putPopulationVersion(body) }),
  },
  {
    method: "GET",
    segments: ["v1", "populations"],
    handler: (ctx) => ({ status: 200, body: { populations: ctx.services.registry.listPopulations(asOf(ctx)) } }),
  },

  // ---------- 授权 ----------
  {
    method: "POST",
    segments: ["v1", "authorizations"],
    handler: (ctx, body) => ({ status: 201, body: ctx.services.authz.grant(body) }),
  },
  {
    method: "POST",
    segments: ["v1", "authorizations", ":id", "revoke"],
    handler: (ctx, body, { id }) => ({
      status: 200,
      body: ctx.services.authz.revoke(id, { reason: body.reason, revokedBy: ctx.actor.facility_id }),
    }),
  },
  {
    method: "GET",
    segments: ["v1", "patients", ":token", "authorizations"],
    handler: (ctx, _body, { token }) => ({
      status: 200,
      body: { authorizations: ctx.services.authz.listByPatient(token) },
    }),
  },

  // ---------- 转诊流转 ----------
  {
    method: "POST",
    segments: ["v1", "referrals"],
    handler: (ctx, body) => {
      const result = ctx.services.referrals.submit(withActor(body, ctx));
      return { status: result.duplicate ? 200 : 201, body: result };
    },
  },
  {
    method: "GET",
    segments: ["v1", "referrals", ":id"],
    handler: (ctx, _body, { id }) => ({ status: 200, body: ctx.services.referrals.getReferral(id) }),
  },
  {
    method: "POST",
    segments: ["v1", "referrals", ":id", "candidates"],
    handler: (ctx, _body, { id }) => ({ status: 200, body: ctx.services.referrals.generateCandidates(id) }),
  },
  {
    method: "POST",
    segments: ["v1", "referrals", ":id", "candidate-selections"],
    handler: (ctx, body, { id }) => ({ status: 201, body: ctx.services.referrals.selectCandidate(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "assignments", ":id", "decline"],
    handler: (ctx, body, { id }) => ({ status: 200, body: ctx.services.referrals.declineAssignment(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "referrals", ":id", "accept"],
    handler: (ctx, body, { id }) => ({ status: 200, body: ctx.services.referrals.accept(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "referrals", ":id", "return"],
    handler: (ctx, body, { id }) => ({ status: 200, body: ctx.services.referrals.returnReferral(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "referrals", ":id", "complete"],
    handler: (ctx, body, { id }) => ({ status: 200, body: ctx.services.referrals.complete(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "referrals", ":id", "supplement-requests"],
    handler: (ctx, body, { id }) => ({ status: 200, body: ctx.services.referrals.requestSupplement(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "referrals", ":id", "supplements"],
    handler: (ctx, body, { id }) => ({ status: 200, body: ctx.services.referrals.submitSupplement(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "referrals", ":id", "documents"],
    handler: (ctx, body, { id }) => ({ status: 200, body: ctx.services.referrals.addDocument(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "referrals", ":id", "mdt"],
    handler: (ctx, body, { id }) => ({ status: 201, body: ctx.services.referrals.requestMdt(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "mdts", ":id", "schedule"],
    handler: (ctx, body, { id }) => ({ status: 200, body: ctx.services.referrals.scheduleMdt(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "mdts", ":id", "feedback"],
    handler: (ctx, body, { id }) => ({ status: 200, body: ctx.services.referrals.recordMdtFeedback(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "referrals", ":id", "transfers"],
    handler: (ctx, body, { id }) => ({ status: 201, body: ctx.services.referrals.requestTransfer(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "transfers", ":id", "decline"],
    handler: (ctx, body, { id }) => ({ status: 200, body: ctx.services.referrals.declineTransfer(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "referrals", ":id", "follow-ups"],
    handler: (ctx, body, { id }) => ({ status: 201, body: ctx.services.referrals.scheduleFollowUp(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "follow-ups", ":id", "attempts"],
    handler: (ctx, body, { id }) => ({ status: 200, body: ctx.services.referrals.recordFollowUpAttempt(id, withActor(body, ctx)) }),
  },
  {
    method: "GET",
    segments: ["v1", "referrals", ":id", "duplicates"],
    handler: (ctx, _body, { id }) => ({ status: 200, body: ctx.services.referrals.listDuplicates(id) }),
  },
  {
    method: "POST",
    segments: ["v1", "duplicates", "patients", ":id", "resolve"],
    handler: (ctx, body, { id }) => ({ status: 200, body: ctx.services.referrals.resolvePatientDuplicate(id, withActor(body, ctx)) }),
  },
  {
    method: "POST",
    segments: ["v1", "duplicates", "checks", ":id", "resolve"],
    handler: (ctx, body, { id }) => ({ status: 200, body: ctx.services.referrals.resolveCheckDuplicate(id, withActor(body, ctx)) }),
  },
  {
    method: "GET",
    segments: ["v1", "documents", ":id"],
    handler: (ctx, _body, { id }) => ({ status: 200, body: ctx.services.referrals.readDocument(id, ctx.actor) }),
  },
  {
    method: "GET",
    segments: ["v1", "referrals", ":id", "audit"],
    handler: (ctx, _body, { id }) => ({ status: 200, body: { audits: ctx.services.referrals.listAudit(id) } }),
  },

  // ---------- 监管端 ----------
  {
    method: "GET",
    segments: ["v1", "regulatory", "coverage"],
    regulatorOnly: true,
    handler: (ctx) => ({ status: 200, body: ctx.services.regulatory.coverageReport({ asOf: asOf(ctx) }) }),
  },
  {
    method: "GET",
    segments: ["v1", "regulatory", "backlog"],
    regulatorOnly: true,
    handler: (ctx) => ({
      status: 200,
      body: ctx.services.regulatory.backlogReport({ asOf: asOf(ctx), regionScope: ctx.query.get("region") }),
    }),
  },
  {
    method: "GET",
    segments: ["v1", "regulatory", "consistency"],
    regulatorOnly: true,
    handler: (ctx) => ({ status: 200, body: ctx.services.regulatory.consistencyCheck({ asOf: asOf(ctx) }) }),
  },
  {
    method: "GET",
    segments: ["v1", "regulatory", "snapshots", ":id"],
    regulatorOnly: true,
    handler: (ctx, _body, { id }) => {
      const snapshot = ctx.services.regulatory.getSnapshot(id);
      if (!snapshot) return { status: 404, body: { error: "快照不存在" } };
      return { status: 200, body: snapshot };
    },
  },
  {
    method: "POST",
    segments: ["v1", "system", "sweep"],
    regulatorOnly: true,
    handler: (ctx, body) => ({
      status: 200,
      body: { swept: ctx.services.referrals.sweepTimeouts(body.as_of) },
    }),
  },
];

function withActor(body, ctx) {
  return {
    ...body,
    facility_id: body.facility_id ?? ctx.actor.facility_id,
    user: body.user ?? ctx.actor.user,
  };
}
