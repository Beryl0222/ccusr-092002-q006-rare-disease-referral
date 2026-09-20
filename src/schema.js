// 全部表结构与不可变保护。版本表/事件表/审计表只允许 INSERT，
// UPDATE/DELETE 由触发器拒绝。某时刻 T 的有效版本 = effective_at <= T 的最新一行，
// 有效期区间由 LEAD(effective_at) 推导，因此人口或机构能力调整后历史事实不会被重写。
export const SCHEMA = `
PRAGMA foreign_keys = ON;

-- ============ 行政区划与人口版本 ============
CREATE TABLE IF NOT EXISTS region_population_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  region_code TEXT NOT NULL,
  population INTEGER NOT NULL CHECK (population >= 0),
  is_target_city INTEGER NOT NULL DEFAULT 0,   -- 三百万人口以上地市（按当时口径认定）
  effective_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 机构 ============
CREATE TABLE IF NOT EXISTS facilities (
  id TEXT PRIMARY KEY,                       -- 业务编号，如 clinic-104
  name TEXT NOT NULL,
  level TEXT NOT NULL,                       -- provincial | city | primary
  region_code TEXT NOT NULL,
  lat REAL,
  lon REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 门诊资质版本：新资质/年审结果插新行（granted/suspended/revoked/expired）。
CREATE TABLE IF NOT EXISTS qualification_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  qualification_type TEXT NOT NULL,          -- 罕见病门诊资质类别
  status TEXT NOT NULL,                      -- granted | suspended | revoked | expired
  effective_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 可接诊病种（机构能力）。版本化：能力调整只插版本，不改写历史。
CREATE TABLE IF NOT EXISTS disease_capability_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  disease_code TEXT NOT NULL,
  disease_name TEXT NOT NULL,
  can_accept INTEGER NOT NULL,               -- 1 具备能力 / 0 暂停接诊（停诊也保留轨迹）
  genetics_enabled INTEGER NOT NULL DEFAULT 0, -- 是否具备遗传/基因检测接诊条件
  effective_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 专科坐诊排班（周循环 + 时段）。版本化：同一 (专科,星期,时段) 的调整插新版本。
CREATE TABLE IF NOT EXISTS schedule_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  specialty TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  slot_start TEXT NOT NULL,                  -- "09:00"
  slot_end TEXT NOT NULL,
  seats_per_week INTEGER NOT NULL CHECK (seats_per_week > 0),
  effective_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 患者假名与重复识别 ============
-- 患者只以假名标识；跨院重复通过去标识指纹（哈希）比对，机构间不直接交换明文身份。
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_token TEXT NOT NULL UNIQUE,        -- 提交方给出的稳定假名
  fingerprint TEXT NOT NULL,                 -- 去标识身份指纹（HMAC/哈希）
  sex TEXT,
  birth_year INTEGER,
  first_seen_facility_id TEXT REFERENCES facilities(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patients_fp ON patients(fingerprint);

-- 检查指纹用于识别重复检查（同患者 + 检查类型 + 项目代码 + 检查日期近窗）。
CREATE TABLE IF NOT EXISTS exam_fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  exam_type TEXT NOT NULL,
  exam_code TEXT NOT NULL,
  exam_date TEXT,
  fingerprint TEXT NOT NULL,
  source_facility_id TEXT REFERENCES facilities(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exam_fp ON exam_fingerprints(fingerprint);

-- ============ 授权（含遗传/基因检测的更严格范围） ============
CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  scope TEXT NOT NULL,                       -- referral-summary | genetic
  granted_by_facility_id TEXT NOT NULL REFERENCES facilities(id),
  permitted_facility_ids TEXT NOT NULL DEFAULT '', -- 逗号分隔；空=随转诊定向授权
  purpose TEXT NOT NULL DEFAULT 'rare-disease-referral',
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',     -- active | withdrawn
  withdrawn_at TEXT,
  withdrawn_by TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_consents_patient ON consents(patient_id, scope, status);

-- ============ 转诊单（当前态） ============
CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  source_facility_id TEXT NOT NULL REFERENCES facilities(id),
  current_holder_facility_id TEXT REFERENCES facilities(id),
  suspected_disease_code TEXT,
  suspected_category TEXT,
  urgency TEXT NOT NULL DEFAULT 'routine',   -- routine | priority | urgent
  status TEXT NOT NULL,                      -- 见 docs/states.md
  material_complete INTEGER NOT NULL DEFAULT 0,
  contains_genetic_material INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 乐观锁：每次状态流转 +1，跨机构并发接诊只有一方成功
  version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_referrals_holder ON referrals(current_holder_facility_id);

-- 去标识化转诊摘要文档（不保存明文身份）。遗传材料的读取受 genetic 授权门控。
CREATE TABLE IF NOT EXISTS referral_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_id TEXT NOT NULL REFERENCES referrals(id),
  doc_type TEXT NOT NULL,                    -- clinical-summary | laboratory-index | genetics-report ...
  is_genetic INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  content TEXT,                              -- 去标识化正文/引用
  submitted_by_facility_id TEXT NOT NULL REFERENCES facilities(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_docs_referral ON referral_documents(referral_id);

-- ============ 候选机构快照（可解释、留痕，仅辅助医生） ============
CREATE TABLE IF NOT EXISTS candidate_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_id TEXT NOT NULL REFERENCES referrals(id),
  generated_at TEXT NOT NULL,
  as_of_population_version INTEGER,
  rationale_note TEXT NOT NULL DEFAULT '候选仅依据能力/距离/候诊/紧急度，不构成诊断'
);
CREATE TABLE IF NOT EXISTS candidate_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES candidate_snapshots(id),
  facility_id TEXT NOT NULL REFERENCES facilities(id),
  rank INTEGER NOT NULL,
  total_score REAL NOT NULL,
  capability_match INTEGER NOT NULL,
  distance_km REAL,
  estimated_wait_days REAL,
  urgency_bonus REAL,
  explanations TEXT NOT NULL                  -- JSON：逐条可解释原因
);
CREATE INDEX IF NOT EXISTS idx_candidate_items_snapshot ON candidate_items(snapshot_id);

-- ============ 不可变事件时间线 ============
-- 业务事实只增不改：提交、接诊、补料、退回、会诊、转接、随访失联……
CREATE TABLE IF NOT EXISTS referral_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_id TEXT NOT NULL REFERENCES referrals(id),
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor_facility_id TEXT,
  actor_user TEXT,
  responsible_facility_id TEXT,              -- 责任人（机构）
  responsible_user TEXT,
  due_at TEXT,                               -- 该动作时限
  executed_at TEXT NOT NULL,
  payload TEXT,                              -- JSON 附加信息
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_referral ON referral_events(referral_id, id);
CREATE INDEX IF NOT EXISTS idx_events_type ON referral_events(event_type);

-- ============ 待办/时限 ============
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_id TEXT NOT NULL REFERENCES referrals(id),
  event_id INTEGER REFERENCES referral_events(id),
  task_type TEXT NOT NULL,                   -- accept | supplement | return | mdt | transfer | followup
  responsible_facility_id TEXT NOT NULL,
  responsible_user TEXT,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',       -- open | done | overdue | cancelled
  result_event_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(status, due_at);

-- ============ 多学科会诊 ============
CREATE TABLE IF NOT EXISTS consultations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_id TEXT NOT NULL REFERENCES referrals(id),
  requested_by_facility_id TEXT NOT NULL,
  participants TEXT NOT NULL DEFAULT '[]',   -- JSON 机构/专科列表
  scheduled_at TEXT,
  feedback_at TEXT,                          -- 统一反馈时间
  feedback TEXT,
  status TEXT NOT NULL DEFAULT 'requested',  -- requested | scheduled | completed | cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 随访 ============
CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referral_id TEXT NOT NULL REFERENCES referrals(id),
  attempt_no INTEGER NOT NULL,
  scheduled_at TEXT NOT NULL,
  reached_at TEXT,
  result TEXT,                               -- reached | lost
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_followups_referral ON followups(referral_id);

-- ============ 访问审计（含拒绝与遗传资料读取） ============
CREATE TABLE IF NOT EXISTS access_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_facility_id TEXT,
  actor_user TEXT,
  action TEXT NOT NULL,                      -- read_referral | read_genetic | submit | workflow ...
  referral_id TEXT,
  patient_id INTEGER,
  scope TEXT,
  granted INTEGER NOT NULL,                  -- 1 允许 0 拒绝
  reason TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_referral ON access_audit(referral_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_patient ON access_audit(patient_id, id);

-- ============ 幂等（防重复提交/重复动作） ============
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_ref TEXT NOT NULL,                -- 已处理结果引用（如 referral id）
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ 服务重启恢复运行记录（追加式） ============
-- 每次恢复写 started/finished 两行；只有 started 没有 finished 说明上次被崩溃打断，
-- 重启时应重跑（恢复动作幂等）。
CREATE TABLE IF NOT EXISTS recovery_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_token TEXT NOT NULL,
  phase TEXT NOT NULL,                      -- started | finished
  tasks_overdue_marked INTEGER NOT NULL DEFAULT 0,
  inconsistent_repaired INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recovery_token ON recovery_log(run_token);

-- ============ 不可变表保护：拒绝 UPDATE/DELETE ============
CREATE TRIGGER IF NOT EXISTS trg_immut_events_up BEFORE UPDATE ON referral_events
BEGIN SELECT raise(ABORT, 'referral_events 为不可变事件表'); END;
CREATE TRIGGER IF NOT EXISTS trg_immut_events_del BEFORE DELETE ON referral_events
BEGIN SELECT raise(ABORT, 'referral_events 为不可变事件表'); END;

CREATE TRIGGER IF NOT EXISTS trg_immut_audit_up BEFORE UPDATE ON access_audit
BEGIN SELECT raise(ABORT, 'access_audit 为不可变审计表'); END;
CREATE TRIGGER IF NOT EXISTS trg_immut_audit_del BEFORE DELETE ON access_audit
BEGIN SELECT raise(ABORT, 'access_audit 为不可变审计表'); END;

CREATE TRIGGER IF NOT EXISTS trg_immut_idem_up BEFORE UPDATE ON idempotency
BEGIN SELECT raise(ABORT, 'idempotency 为不可变表'); END;
CREATE TRIGGER IF NOT EXISTS trg_immut_idem_del BEFORE DELETE ON idempotency
BEGIN SELECT raise(ABORT, 'idempotency 为不可变表'); END;

CREATE TRIGGER IF NOT EXISTS trg_immut_recovery_up BEFORE UPDATE ON recovery_log
BEGIN SELECT raise(ABORT, 'recovery_log 为不可变表'); END;
CREATE TRIGGER IF NOT EXISTS trg_immut_recovery_del BEFORE DELETE ON recovery_log
BEGIN SELECT raise(ABORT, 'recovery_log 不可删除'); END;

CREATE TRIGGER IF NOT EXISTS trg_immut_popver_up BEFORE UPDATE ON region_population_versions
BEGIN SELECT raise(ABORT, '人口版本只允许插新版本'); END;
CREATE TRIGGER IF NOT EXISTS trg_immut_popver_del BEFORE DELETE ON region_population_versions
BEGIN SELECT raise(ABORT, '人口版本不可删除'); END;

CREATE TRIGGER IF NOT EXISTS trg_immut_qualver_up BEFORE UPDATE ON qualification_versions
BEGIN SELECT raise(ABORT, '资质版本只允许插新版本'); END;
CREATE TRIGGER IF NOT EXISTS trg_immut_qualver_del BEFORE DELETE ON qualification_versions
BEGIN SELECT raise(ABORT, '资质版本不可删除'); END;

CREATE TRIGGER IF NOT EXISTS trg_immut_capver_up BEFORE UPDATE ON disease_capability_versions
BEGIN SELECT raise(ABORT, '病种能力版本只允许插新版本'); END;
CREATE TRIGGER IF NOT EXISTS trg_immut_capver_del BEFORE DELETE ON disease_capability_versions
BEGIN SELECT raise(ABORT, '病种能力版本不可删除'); END;

CREATE TRIGGER IF NOT EXISTS trg_immut_schedver_up BEFORE UPDATE ON schedule_versions
BEGIN SELECT raise(ABORT, '排班版本只允许插新版本'); END;
CREATE TRIGGER IF NOT EXISTS trg_immut_schedver_del BEFORE DELETE ON schedule_versions
BEGIN SELECT raise(ABORT, '排班版本不可删除'); END;
`;
