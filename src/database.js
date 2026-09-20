import { DatabaseSync } from "node:sqlite";

const IMMUTABLE_TABLES = [
  // 只追加的业务事实：状态重建与监管口径的唯一事实来源
  "referral_events",
  "access_audits",
  "submission_attempts",
  "candidate_snapshots",
  "candidate_selections",
  "follow_up_attempts",
  "regulatory_snapshots",
  // 版本链只能追加新版本：旧版本的 valid_from 与数值永不被改写
  "population_versions",
  "facility_versions",
  "qualification_versions",
  "capability_versions",
  "schedule_versions",
];

function immutableTriggers() {
  return IMMUTABLE_TABLES.map(
    (table) => `
CREATE TRIGGER IF NOT EXISTS trg_${table}_no_update BEFORE UPDATE ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table} 为只追加表，禁止更新');
END;
CREATE TRIGGER IF NOT EXISTS trg_${table}_no_delete BEFORE DELETE ON ${table}
BEGIN
  SELECT RAISE(ABORT, '${table} 为只追加表，禁止删除');
END;`,
  ).join("\n");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facilities (
  facility_id   TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL
);

-- 机构属性（名称、等级、辖区、坐标）同样以版本链维护
CREATE TABLE IF NOT EXISTS facility_versions (
  facility_id TEXT NOT NULL REFERENCES facilities(facility_id),
  valid_from  TEXT NOT NULL,
  name        TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('provincial','city','county','primary')),
  region_code TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  PRIMARY KEY (facility_id, valid_from)
);

-- 辖区人口版本：调整人口只追加新版本，历史覆盖判断按当时有效版本
CREATE TABLE IF NOT EXISTS population_versions (
  region_code  TEXT NOT NULL,
  valid_from   TEXT NOT NULL,
  region_name  TEXT NOT NULL,
  region_level TEXT NOT NULL CHECK (region_level IN ('province','city')),
  population   INTEGER NOT NULL CHECK (population >= 0),
  PRIMARY KEY (region_code, valid_from)
);

-- 罕见病门诊资质（挂牌）版本链，status='revoked' 表示撤销
CREATE TABLE IF NOT EXISTS qualification_versions (
  facility_id TEXT NOT NULL REFERENCES facilities(facility_id),
  valid_from  TEXT NOT NULL,
  qual_type   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active','revoked')),
  issued_by   TEXT,
  PRIMARY KEY (facility_id, qual_type, valid_from)
);

-- 可接诊病种能力版本链
CREATE TABLE IF NOT EXISTS capability_versions (
  facility_id      TEXT NOT NULL REFERENCES facilities(facility_id),
  disease_code     TEXT NOT NULL,
  valid_from       TEXT NOT NULL,
  disease_name     TEXT NOT NULL,
  disease_category TEXT NOT NULL,
  specialty        TEXT NOT NULL,
  cap_level        TEXT NOT NULL CHECK (cap_level IN ('designated','specialty','general')),
  status           TEXT NOT NULL CHECK (status IN ('active','withdrawn')),
  PRIMARY KEY (facility_id, disease_code, valid_from)
);

-- 专科坐诊号源版本链（候诊时间据此计算）
CREATE TABLE IF NOT EXISTS schedule_versions (
  facility_id    TEXT NOT NULL REFERENCES facilities(facility_id),
  specialty      TEXT NOT NULL,
  valid_from     TEXT NOT NULL,
  weekly_slots   INTEGER NOT NULL CHECK (weekly_slots >= 0),
  base_lead_days INTEGER NOT NULL CHECK (base_lead_days >= 0),
  status         TEXT NOT NULL CHECK (status IN ('active','suspended')),
  PRIMARY KEY (facility_id, specialty, valid_from)
);

-- 患者授权：摘要与基因检测分级；基因可进一步限定可读机构；撤回只置位不删除
CREATE TABLE IF NOT EXISTS patient_authorizations (
  auth_id               TEXT PRIMARY KEY,
  patient_token         TEXT NOT NULL,
  scope_json            TEXT NOT NULL DEFAULT '[]',
  genetic_facility_json TEXT NOT NULL DEFAULT '[]',
  granted_by_facility_id TEXT NOT NULL,
  valid_from            TEXT NOT NULL,
  valid_to              TEXT,
  revoked_at            TEXT,
  revoke_reason         TEXT,
  revoked_by            TEXT,
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_token ON patient_authorizations(patient_token);

CREATE TABLE IF NOT EXISTS referrals (
  referral_id                TEXT PRIMARY KEY,
  idempotency_key            TEXT UNIQUE,
  source_facility_id         TEXT NOT NULL,
  patient_token              TEXT NOT NULL,
  auth_id                    TEXT NOT NULL,
  birth_year                 INTEGER,
  gender                     TEXT,
  residence_region_code      TEXT,
  contact_hash               TEXT,
  phenotype_codes_json       TEXT NOT NULL DEFAULT '[]',
  first_visit_date           TEXT,
  suspected_category         TEXT NOT NULL,
  suspected_disease_code     TEXT,
  urgency                    TEXT NOT NULL CHECK (urgency IN ('routine','priority','urgent')),
  origin_lat                 REAL,
  origin_lng                 REAL,
  status                     TEXT NOT NULL,
  current_holder_facility_id TEXT,
  assignee_facility_id       TEXT,
  open_phase                 TEXT,
  sla_due_at                 TEXT,
  version                    INTEGER NOT NULL DEFAULT 1,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_referrals_patient ON referrals(patient_token);

CREATE TABLE IF NOT EXISTS referral_documents (
  document_id   TEXT PRIMARY KEY,
  referral_id   TEXT NOT NULL REFERENCES referrals(referral_id),
  doc_type      TEXT NOT NULL,
  is_genetic    INTEGER NOT NULL DEFAULT 0,
  content_ref   TEXT NOT NULL,
  checksum      TEXT,
  supplied_by   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_referral ON referral_documents(referral_id);

CREATE TABLE IF NOT EXISTS referral_checks (
  check_id    TEXT PRIMARY KEY,
  referral_id TEXT NOT NULL REFERENCES referrals(referral_id),
  check_code  TEXT NOT NULL,
  check_name  TEXT NOT NULL,
  check_date  TEXT NOT NULL,
  facility_id TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checks_code ON referral_checks(check_code, check_date);

-- 幂等与重复提交留痕：成功、被拒都记录
CREATE TABLE IF NOT EXISTS submission_attempts (
  attempt_id         TEXT PRIMARY KEY,
  idempotency_key    TEXT,
  referral_id        TEXT,
  source_facility_id TEXT NOT NULL,
  payload_hash       TEXT NOT NULL,
  result             TEXT NOT NULL CHECK (result IN ('accepted','rejected','duplicate')),
  reasons_json       TEXT NOT NULL DEFAULT '[]',
  occurred_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_hash ON submission_attempts(source_facility_id, payload_hash);

-- 授权读取审计：允许与拒绝都记录，授权撤回后审计本身保留
CREATE TABLE IF NOT EXISTS access_audits (
  audit_id         TEXT PRIMARY KEY,
  ts               TEXT NOT NULL,
  actor_facility_id TEXT,
  actor_user       TEXT,
  actor_role       TEXT,
  referral_id      TEXT,
  auth_id          TEXT,
  resource_type    TEXT NOT NULL,
  resource_id      TEXT,
  action           TEXT NOT NULL,
  decision         TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  reason           TEXT,
  request_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_audits_referral ON access_audits(referral_id, ts);
CREATE INDEX IF NOT EXISTS idx_audits_ts ON access_audits(ts);

-- 转诊事件流（append-only）：open_phase/sla_due_at/assignee 非空表示该事件开启一个待办
CREATE TABLE IF NOT EXISTS referral_events (
  event_id              TEXT PRIMARY KEY,
  referral_id           TEXT NOT NULL,
  seq                   INTEGER NOT NULL,
  event_type            TEXT NOT NULL,
  actor_facility_id     TEXT,
  actor_user            TEXT,
  from_status           TEXT,
  to_status             TEXT,
  open_phase            TEXT,
  sla_due_at            TEXT,
  assignee_facility_id  TEXT,
  payload_json          TEXT NOT NULL DEFAULT '{}',
  recorded_at           TEXT NOT NULL,
  UNIQUE(referral_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_recorded ON referral_events(referral_id, recorded_at);

-- 接诊邀请（可变投影，CAS 申领）
CREATE TABLE IF NOT EXISTS referral_assignments (
  assignment_id   TEXT PRIMARY KEY,
  referral_id     TEXT NOT NULL REFERENCES referrals(referral_id),
  facility_id     TEXT NOT NULL,
  requested_by    TEXT NOT NULL,
  requested_at    TEXT NOT NULL,
  deadline_at     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('requested','accepted','declined','expired','superseded')),
  responded_at    TEXT,
  version         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_assignments_referral ON referral_assignments(referral_id, status);

CREATE TABLE IF NOT EXISTS mdt_consultations (
  mdt_id               TEXT PRIMARY KEY,
  referral_id          TEXT NOT NULL REFERENCES referrals(referral_id),
  convening_facility_id TEXT NOT NULL,
  requested_at         TEXT NOT NULL,
  schedule_due_at      TEXT NOT NULL,
  scheduled_at         TEXT,
  feedback             TEXT,
  feedback_recorded_at TEXT,
  completed_at         TEXT,
  status               TEXT NOT NULL CHECK (status IN ('requested','scheduled','completed','cancelled')),
  version              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS transfers (
  transfer_id   TEXT PRIMARY KEY,
  referral_id   TEXT NOT NULL REFERENCES referrals(referral_id),
  from_facility_id TEXT NOT NULL,
  to_facility_id   TEXT NOT NULL,
  reason        TEXT,
  requested_at  TEXT NOT NULL,
  deadline_at   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('requested','accepted','declined','expired')),
  responded_at  TEXT,
  version       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_transfers_referral ON transfers(referral_id, status);

CREATE TABLE IF NOT EXISTS follow_ups (
  follow_up_id  TEXT PRIMARY KEY,
  referral_id   TEXT NOT NULL REFERENCES referrals(referral_id),
  due_at        TEXT NOT NULL,
  opened_at     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('scheduled','reached','failed','lost')),
  failed_count  INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  reached_at    TEXT,
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS follow_up_attempts (
  attempt_id   TEXT PRIMARY KEY,
  follow_up_id TEXT NOT NULL REFERENCES follow_ups(follow_up_id),
  referral_id  TEXT NOT NULL,
  result       TEXT NOT NULL CHECK (result IN ('reached','failed')),
  note         TEXT,
  actor_facility_id TEXT,
  actor_user   TEXT,
  attempted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suspected_duplicate_patients (
  duplicate_id      TEXT PRIMARY KEY,
  referral_id       TEXT NOT NULL,
  other_referral_id TEXT NOT NULL,
  score             INTEGER NOT NULL,
  reasons_json      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'suspected' CHECK (status IN ('suspected','confirmed','dismissed')),
  resolved_by       TEXT,
  resolved_at       TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suspected_duplicate_checks (
  dup_check_id      TEXT PRIMARY KEY,
  referral_id       TEXT NOT NULL,
  other_referral_id TEXT NOT NULL,
  check_code        TEXT NOT NULL,
  check_date        TEXT NOT NULL,
  other_date        TEXT NOT NULL,
  days_apart        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'suspected' CHECK (status IN ('suspected','confirmed','dismissed')),
  created_at        TEXT NOT NULL
);

-- 人工身份判定：对两个患者伪名给出 same/different，future 匹配按身份级别抑制/合并提示
CREATE TABLE IF NOT EXISTS patient_identity_decisions (
  decision_id       TEXT PRIMARY KEY,
  patient_token_a   TEXT NOT NULL,
  patient_token_b   TEXT NOT NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('same','different')),
  decided_by        TEXT,
  decided_at        TEXT NOT NULL,
  UNIQUE(patient_token_a, patient_token_b)
);

-- 候选机构快照：每次生成不可变，选择另记只追加表
CREATE TABLE IF NOT EXISTS candidate_snapshots (
  snapshot_id    TEXT PRIMARY KEY,
  referral_id    TEXT NOT NULL REFERENCES referrals(referral_id),
  generated_at   TEXT NOT NULL,
  urgency        TEXT NOT NULL,
  origin_lat     REAL,
  origin_lng     REAL,
  results_json   TEXT NOT NULL,
  excluded_json  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_snapshots_referral ON candidate_snapshots(referral_id, generated_at);

CREATE TABLE IF NOT EXISTS candidate_selections (
  selection_id TEXT PRIMARY KEY,
  snapshot_id  TEXT NOT NULL REFERENCES candidate_snapshots(snapshot_id),
  referral_id  TEXT NOT NULL,
  facility_id  TEXT NOT NULL,
  selected_by  TEXT NOT NULL,
  selected_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regulatory_snapshots (
  report_id    TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  as_of        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  region_scope TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_regulatory_asof ON regulatory_snapshots(as_of, kind);

${immutableTriggers()}
`;

export function migrateDatabase(db) {
  db.exec(SCHEMA);
}

export function openDatabase(path = process.env.DATABASE_PATH ?? "referral-network.db") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  migrateDatabase(db);
  return db;
}

export function openExistingDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrateDatabase(db);
  return db;
}
