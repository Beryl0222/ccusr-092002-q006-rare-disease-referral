import { createHash } from "node:crypto";

// 去标识指纹：真实系统中应使用带服务器密钥的 HMAC，避免指纹被反推。
// 这里保持确定性哈希，便于跨机构以同一规则比对可能重复的患者/检查。
export function fingerprint(...parts) {
  return createHash("sha256").update(parts.map((p) => String(p ?? "")).join("|")).digest("hex");
}

export function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

// 球面距离（公里），用于候选机构距离解释。
export function haversineKm(a, b) {
  if (
    a?.lat == null || a?.lon == null ||
    b?.lat == null || b?.lon == null
  ) {
    return null;
  }
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
