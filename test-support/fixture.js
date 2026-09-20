import { openDatabase } from "../src/database.js";
import { NetworkService } from "../src/domain/service.js";

// 可控制时钟。
export function fakeClock(startIso) {
  return { current: new Date(startIso).getTime(), now() { return new Date(this.current); }, advanceMs(ms) { this.current += ms; }, iso() { return new Date(this.current).toISOString(); } };
}

export const ACTORS = {
  regulator: { role: "regulator", facilityId: null, userId: "reg-zhang" },
  clinic: { role: "facility", facilityId: "clinic-104", userId: "dr-li" },
  city: { role: "facility", facilityId: "hosp-city-1", userId: "dr-wang" },
  city2: { role: "facility", facilityId: "hosp-city-2", userId: "dr-zhao" },
  provincial: { role: "facility", facilityId: "hosp-prov-1", userId: "dr-sun" },
};

// 建立一个覆盖 330100（目标地市）的最小网络：地市医院具备资质/病种/排班。
export function buildNetwork(path = ":memory:", clock) {
  const db = openDatabase(path);
  const svc = new NetworkService(db, clock ? () => clock.now() : undefined);
  svc.registerFacility({ id: "clinic-104", name: "某社区卫生服务中心", level: "primary", regionCode: "330100", lat: 30.25, lon: 120.15 });
  svc.registerFacility({ id: "hosp-city-1", name: "市第一医院", level: "city", regionCode: "330100", lat: 30.27, lon: 120.17 });
  svc.registerFacility({ id: "hosp-city-2", name: "市第二医院", level: "city", regionCode: "330100", lat: 30.4, lon: 120.4 });
  svc.registerFacility({ id: "hosp-prov-1", name: "省级医院", level: "provincial", regionCode: "330000", lat: 30.3, lon: 120.2 });
  return { db, svc };
}

export const T0 = "2026-09-01T00:00:00.000Z";
export const T1 = "2026-09-10T00:00:00.000Z";
export const T2 = "2026-10-15T00:00:00.000Z";

export function seedCityOneCapabilities(svc, effectiveAt = T0, actor = ACTORS.regulator) {
  svc.addPopulationVersion({ regionCode: "330100", population: 12_000_000, isTargetCity: true, effectiveAt }, actor);
  svc.addQualificationVersion({ facilityId: "hosp-city-1", qualificationType: "rare-clinic", status: "granted", effectiveAt }, actor);
  svc.addCapabilityVersion({ facilityId: "hosp-city-1", diseaseCode: "D-IME-1", diseaseName: "苯丙酮尿症", canAccept: true, geneticsEnabled: true, effectiveAt }, actor);
  svc.addScheduleVersion({ facilityId: "hosp-city-1", specialty: "遗传代谢类", weekday: 1, slotStart: "09:00", slotEnd: "11:00", seatsPerWeek: 5, effectiveAt }, actor);
}

export function grantAndSubmit(svc, { token = "tok-1", urgency = "urgent", genetic = true, permitted = ["hosp-city-1"], idempotencyKey } = {}) {
  svc.grantConsent({ patientToken: token, sex: "F", birthYear: 2012, scope: "referral-summary" }, ACTORS.clinic);
  if (genetic) {
    svc.grantConsent({ patientToken: token, scope: "genetic", permittedFacilityIds: permitted }, ACTORS.clinic);
  }
  const documents = [
    { docType: "clinical-summary", content: { note: "发育迟缓" } },
    { docType: "laboratory-index", content: { phe: 240 } },
  ];
  if (genetic) documents.push({ docType: "genetics-report", isGenetic: true, content: { gene: "PAH", variant: "c.782G>A" } });
  return svc.submitReferral({
    idempotencyKey,
    patientToken: token, sex: "F", birthYear: 2012,
    suspectedCategory: "遗传代谢类", suspectedDiseaseCode: "D-IME-1", urgency,
    containsGeneticMaterial: genetic,
    documents,
  }, ACTORS.clinic);
}
