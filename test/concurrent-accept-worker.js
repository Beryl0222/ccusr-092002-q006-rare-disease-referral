import { workerData, parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { RegistryService } from "../src/services/registry.js";
import { AuthorizationService } from "../src/services/authorization.js";
import { ReferralService } from "../src/services/referral.js";

const { dbPath, referralId, facilityId, user, now } = workerData;
const clock = () => now;

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 10000");

const registry = new RegistryService(db, clock);
const authz = new AuthorizationService(db, clock);
const referrals = new ReferralService(db, { registry, authz, clock });

parentPort.on("message", (message) => {
  if (message !== "go") return;
  let result;
  try {
    const accepted = referrals.accept(referralId, { facility_id: facilityId, user });
    result = { ok: true, facility_id: facilityId, holder: accepted.current_holder_facility_id };
  } catch (error) {
    result = { ok: false, facility_id: facilityId, error: error.message };
  }
  // 先关闭并释放数据库连接，再回报结果，保证主线程收到结果时锁已释放
  db.close();
  parentPort.postMessage(result);
});

parentPort.postMessage("ready");
