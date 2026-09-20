// 被并发测试拉起的工作进程。
// 用法：
//   accept  <dbPath> <referralId> <facilityId> <userId>
//   submit  <dbPath> <facilityId> <userId> <jsonBody>
import { openDatabase } from "../src/database.js";
import { NetworkService } from "../src/domain/service.js";

const [mode, dbPath, arg1, arg2, arg3] = process.argv.slice(2);
const db = openDatabase(dbPath);
const svc = new NetworkService(db);
function finish(payload) {
  console.log(JSON.stringify(payload));
  db.close();
}
try {
  if (mode === "accept") {
    const result = svc.acceptReferral(arg1, { role: "facility", facilityId: arg2, userId: arg3 });
    finish({ ok: true, ...result });
  } else if (mode === "submit") {
    const body = JSON.parse(arg3);
    const result = svc.submitReferral(body, { role: "facility", facilityId: arg1, userId: arg2 });
    finish({ ok: true, ...result });
  } else {
    finish({ ok: false, code: "bad_mode" });
  }
} catch (error) {
  finish({ ok: false, code: error.code, message: error.message, details: error.details ?? null });
}
