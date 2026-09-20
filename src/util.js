import crypto from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function isoHoursLater(fromIso, hours) {
  return new Date(Date.parse(fromIso) + hours * 3_600_000).toISOString();
}

export function isoDaysLater(fromIso, days) {
  return isoHoursLater(fromIso, days * 24);
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/** 大圆距离（公里）。 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v == null || Number.isNaN(v))) {
    return null;
  }
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 在 IMMEDIATE 事务中执行 fn，SQLITE_BUSY 时重试一次（跨进程并发接诊）。 */
export function transaction(db, fn, mode = "IMMEDIATE") {
  const run = () => {
    db.exec(`BEGIN ${mode}`);
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 连接已回滚或失效时忽略 */
      }
      throw error;
    }
  };
  try {
    return run();
  } catch (error) {
    if (String(error?.message ?? error).includes("SQLITE_BUSY")) {
      return run();
    }
    throw error;
  }
}

export function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export async function readJsonBody(request, { limitBytes = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error("请求体超过大小限制"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        reject(Object.assign(new Error("JSON 格式不合法"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

export function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
