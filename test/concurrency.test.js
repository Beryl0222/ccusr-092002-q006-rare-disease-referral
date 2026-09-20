import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/database.js";
import { NetworkService } from "../src/domain/service.js";
import { buildNetwork, seedCityOneCapabilities, grantAndSubmit, ACTORS, fakeClock, T0, T2 } from "../test-support/fixture.js";

const workerPath = fileURLToPath(new URL("../test-support/concurrent-accept-worker.js", import.meta.url));

function runAccept(dbPath, referralId, facilityId, userId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath, "accept", dbPath, referralId, facilityId, userId]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(JSON.parse(out.trim())));
  });
}

function runSubmit(dbPath, facilityId, userId, body) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath, "submit", dbPath, facilityId, userId, JSON.stringify(body)]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(JSON.parse(out.trim())));
  });
}

function freshFileNetwork(clock) {
  const dir = mkdtempSync(path.join(tmpdir(), "rdrn-"));
  const dbPath = path.join(dir, "network.db");
  const { db, svc } = buildNetwork(dbPath, clock);
  return { dir, dbPath, db, svc, clock };
}

test("跨机构并发接诊：非持有方被拒，只有持有方接诊成功", async () => {
  const { dir, dbPath, db, svc } = freshFileNetwork();
  seedCityOneCapabilities(svc);
  const r = grantAndSubmit(svc);
  svc.routeReferral(r.referralId, { facilityId: "hosp-city-1" }, ACTORS.clinic);
  db.close();

  const [a, b] = await Promise.all([
    runAccept(dbPath, r.referralId, "hosp-city-1", "dr-wang"),
    runAccept(dbPath, r.referralId, "hosp-city-2", "dr-zhao"),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.code, "forbidden");

  rmSync(dir, { recursive: true, force: true });
});

test("同一机构双节点并发接诊：乐观锁保证只有一次成功（409 冲突）", async () => {
  const { dir, dbPath, db, svc } = freshFileNetwork();
  seedCityOneCapabilities(svc);
  const r = grantAndSubmit(svc);
  svc.routeReferral(r.referralId, { facilityId: "hosp-city-1" }, ACTORS.clinic);
  db.close();

  const [a, b] = await Promise.all([
    runAccept(dbPath, r.referralId, "hosp-city-1", "node-A"),
    runAccept(dbPath, r.referralId, "hosp-city-1", "node-B"),
  ]);
  const winners = [a, b].filter((x) => x.ok);
  const losers = [a, b].filter((x) => !x.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, "conflict");

  rmSync(dir, { recursive: true, force: true });
});

test("重复提交幂等：并发相同 Idempotency-Key 只产生一张转诊单", async () => {
  const { dir, dbPath, db, svc } = freshFileNetwork();
  seedCityOneCapabilities(svc);
  svc.grantConsent({ patientToken: "tok-idem", sex: "F", birthYear: 2012, scope: "referral-summary" }, ACTORS.clinic);
  db.close();

  const body = {
    idempotencyKey: "idem-key-99",
    patientToken: "tok-idem", sex: "F", birthYear: 2012,
    suspectedCategory: "遗传代谢类",
    documents: [
      { docType: "clinical-summary", content: {} },
      { docType: "laboratory-index", content: {} },
    ],
  };
  // 两个进程同时提交同一幂等键：一个新建，另一个必须重放到同一转诊单。
  const [a, b] = await Promise.all([
    runSubmit(dbPath, "clinic-104", "node-A", body),
    runSubmit(dbPath, "clinic-104", "node-B", body),
  ]);
  assert.ok(a.ok && b.ok, `两次提交都应成功：${JSON.stringify([a, b])}`);
  const created = [a, b].filter((x) => !x.replayed);
  const replayed = [a, b].filter((x) => x.replayed);
  assert.equal(created.length, 1);
  assert.equal(replayed.length, 1);
  assert.equal(created[0].referralId, replayed[0].referralId);

  // 再串行重放一次仍然幂等
  const c = await runSubmit(dbPath, "clinic-104", "node-C", body);
  assert.equal(c.replayed, true);
  assert.equal(c.referralId, created[0].referralId);

  rmSync(dir, { recursive: true, force: true });
});

test("服务重启：关闭并重开数据库后数据一致，恢复流程标记超时并补建缺失接诊时限", () => {
  const clock = fakeClock(T0);
  const { dir, dbPath, db, svc } = freshFileNetwork(clock);
  seedCityOneCapabilities(svc, T0);
  const r = grantAndSubmit(svc, { urgency: "routine" });
  // 派单后接诊时限为 72 小时
  svc.routeReferral(r.referralId, { facilityId: "hosp-city-1" }, ACTORS.clinic);
  db.close();

  // ---- 模拟进程重启：在 T2 重新打开同一文件库 ----
  clock.current = new Date(T2).getTime();
  const db2 = openDatabase(dbPath);
  const svc2 = new NetworkService(db2, () => clock.now());

  // 数据仍在，状态为派单后的 routed，版本号为 1
  const view = svc2.getReferralView(r.referralId, ACTORS.city);
  assert.equal(view.status, "routed");
  assert.equal(view.version, 1);
  const acceptTask = view.tasks.find((t) => t.type === "accept");
  assert.equal(acceptTask.status, "open");

  // 模拟崩溃导致任务行丢失（但事件/转诊单事实仍完整）
  db2.prepare("DELETE FROM tasks").run();

  // 重启恢复：补建缺失接诊任务；T2 已远超 72 小时时限，直接标记 overdue
  const rec = svc2.recover(T2);
  assert.ok(rec.repairs.some((x) => x.type === "recreate_missing_accept_task" && x.referralId === r.referralId));
  const after = svc2.getReferralView(r.referralId, ACTORS.city);
  const recreated = after.tasks.find((t) => t.type === "accept");
  assert.equal(recreated.status, "overdue");
  // 不可变事件链未被改动
  assert.ok(after.timeline.find((e) => e.type === "routed"));
  // 恢复日志成对存在（started + finished）
  const logs = db2.prepare("SELECT phase FROM recovery_log ORDER BY id").all();
  assert.deepEqual(logs.map((l) => l.phase), ["started", "finished"]);

  // as-of 超时报表能看到该任务超时
  const overdueReport = svc2.overdue(T2);
  assert.ok(overdueReport.items.some((i) => i.referralId === r.referralId && i.taskType === "accept"));

  db2.close();
  rmSync(dir, { recursive: true, force: true });
});

test("上次恢复被崩溃打断时，再次重启会发现并重新执行幂等恢复", () => {
  const clock = fakeClock(T0);
  const { dir, dbPath, db, svc } = freshFileNetwork(clock);
  seedCityOneCapabilities(svc, T0);
  const r = grantAndSubmit(svc);
  svc.routeReferral(r.referralId, { facilityId: "hosp-city-1" }, ACTORS.clinic);
  db.close();

  const db2 = openDatabase(dbPath);
  // 只写 started 未写 finished（模拟恢复中途崩溃）
  db2.prepare("INSERT INTO recovery_log (run_token, phase, at) VALUES ('run-broken','started',?)")
    .run("2026-09-05T00:00:00.000Z");
  const svc2 = new NetworkService(db2);
  const rec = svc2.recover(T2);
  assert.equal(rec.previousRunInterrupted, true);
  assert.ok(rec.previousInterruptedRuns.includes("run-broken"));
  db2.close();
  rmSync(dir, { recursive: true, force: true });
});
