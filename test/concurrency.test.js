import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { createHarness, seedScenario, baseReferralInput, tempDbPath, FakeClock } from "./helpers.js";
import { SCOPES } from "../src/services/authorization.js";

const workerPath = fileURLToPath(new URL("./concurrent-accept-worker.js", import.meta.url));

function startWorker(dbPath, referralId, facilityId) {
  const worker = new Worker(workerPath, {
    workerData: { dbPath, referralId, facilityId, user: `dr-${facilityId}`, now: "2026-01-02T00:00:00.000Z" },
  });
  const outcome = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${facilityId} worker 超时`)), 15000);
    worker.on("message", (message) => {
      if (message === "ready") return;
      clearTimeout(timer);
      resolve(message);
    });
    worker.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const ready = new Promise((resolve) => {
    const onMessage = (message) => {
      if (message === "ready") {
        worker.off("message", onMessage);
        resolve();
      }
    };
    worker.on("message", onMessage);
  });
  return { worker, outcome, ready, go: () => worker.postMessage("go") };
}

test("跨连接并发接诊：两个机构同时接诊，仅一方成功（CAS）", async (t) => {
  const dbPath = tempDbPath();
  let referralId;
  // 用主连接播种：机构/能力/授权/一条 submitted 转诊（未指派）
  const h = createHarness({ dbPath });
  t.after(() => {
    try {
      h.close();
    } catch {
      /* ignore */
    }
    h.cleanup();
  });
  seedScenario(h);
  h.authz.grant({
    auth_id: "auth-c1", patient_token: "pseudo-c1",
    scopes: [SCOPES.REFERRAL_SUMMARY], granted_by_facility_id: "clinic-1",
  });
  const ref = h.referrals.submit(baseReferralInput({ auth_id: "auth-c1", patient_token: "pseudo-c1" }));
  referralId = ref.referral_id;
  h.close(); // 关闭主连接，交由两个 worker 独立连接竞争

  const w1 = startWorker(dbPath, referralId, "city-hosp-A1");
  const w2 = startWorker(dbPath, referralId, "prov-hosp-1");
  t.after(async () => {
    await Promise.allSettled([w1.worker.terminate(), w2.worker.terminate()]);
  });
  await Promise.all([w1.ready, w2.ready]);
  // 同时放行
  w1.go();
  w2.go();
  const outcomes = await Promise.all([w1.outcome, w2.outcome]);

  const winners = outcomes.filter((o) => o.ok);
  const losers = outcomes.filter((o) => !o.ok);
  assert.equal(winners.length, 1, `应有且仅有一个接诊成功者，实际：${JSON.stringify(outcomes)}`);
  assert.equal(losers.length, 1);
  assert.match(losers[0].error, /接诊|冲突/);
  // 输家不得成为持有人
  assert.notEqual(losers[0].facility_id, winners[0].holder);

  // 数据库层面核验：只有一个 accepted 事件，持有人唯一
  const h2 = createHarness({ dbPath, clock: new FakeClock("2026-01-03T00:00:00.000Z") });
  t.after(() => h2.close());
  const acceptedEvents = h2.db
    .prepare("SELECT event_type, actor_facility_id FROM referral_events WHERE referral_id = ? ORDER BY seq")
    .all(referralId)
    .filter((e) => e.event_type === "accepted");
  assert.equal(acceptedEvents.length, 1);
  assert.equal(acceptedEvents[0].actor_facility_id, winners[0].facility_id);
  const row = h2.db.prepare("SELECT current_holder_facility_id, status FROM referrals WHERE referral_id = ?").get(referralId);
  assert.equal(row.status, "accepted");
  assert.equal(row.current_holder_facility_id, winners[0].facility_id);
  assert.equal(h2.regulatory.consistencyCheck().consistent, true);
});
