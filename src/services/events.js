import { createId } from "../util.js";

export const TERMINAL_STATUSES = new Set(["returned", "completed", "lost_contact"]);

/**
 * 追加转诊事件。必须在 IMMUTABLE 表上写入，且 seq 在转诊内连续。
 * openPhase/slaDueAt/assignee 表示该事件发生后新开启的待办（为 null 表示无待办）。
 */
export function appendEvent(db, fields) {
  const seqRow = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM referral_events WHERE referral_id = ?")
    .get(fields.referral_id);
  const event = {
    event_id: createId("evt"),
    referral_id: fields.referral_id,
    seq: seqRow.next_seq,
    event_type: fields.event_type,
    actor_facility_id: fields.actor_facility_id ?? null,
    actor_user: fields.actor_user ?? null,
    from_status: fields.from_status ?? null,
    to_status: fields.to_status ?? null,
    open_phase: fields.open_phase ?? null,
    sla_due_at: fields.sla_due_at ?? null,
    assignee_facility_id: fields.assignee_facility_id ?? null,
    payload_json: JSON.stringify(fields.payload ?? {}),
    recorded_at: fields.recorded_at,
  };
  db.prepare(
    `INSERT INTO referral_events
       (event_id, referral_id, seq, event_type, actor_facility_id, actor_user,
        from_status, to_status, open_phase, sla_due_at, assignee_facility_id,
        payload_json, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.event_id,
    event.referral_id,
    event.seq,
    event.event_type,
    event.actor_facility_id,
    event.actor_user,
    event.from_status,
    event.to_status,
    event.open_phase,
    event.sla_due_at,
    event.assignee_facility_id,
    event.payload_json,
    event.recorded_at,
  );
  return hydrate(event);
}

export function hydrate(row) {
  return { ...row, payload: JSON.parse(row.payload_json) };
}

export function listEvents(db, referralId) {
  return db
    .prepare("SELECT * FROM referral_events WHERE referral_id = ? ORDER BY seq")
    .all(referralId)
    .map(hydrate);
}

/**
 * 按 asOf 重放事件，重建转诊当时状态。
 * 监管口径（积压、超时、覆盖后的服务流转）全部以此为准，而不是读可变投影。
 */
export function replayState(db, referralId, asOf) {
  const rows = db
    .prepare(
      "SELECT * FROM referral_events WHERE referral_id = ? AND recorded_at <= ? ORDER BY seq",
    )
    .all(referralId, asOf);
  if (rows.length === 0) return null;
  let status = null;
  let holder = null;
  for (const row of rows) {
    const e = hydrate(row);
    if (e.to_status) status = e.to_status;
    if (e.event_type === "accepted") holder = e.actor_facility_id;
    if (e.event_type === "transfer_accepted") holder = e.actor_facility_id;
  }
  const last = hydrate(rows[rows.length - 1]);
  return {
    referral_id: referralId,
    status,
    current_holder_facility_id: holder,
    open_phase: last.open_phase,
    sla_due_at: last.sla_due_at,
    assignee_facility_id: last.assignee_facility_id,
    last_event: last,
    event_count: rows.length,
    is_terminal: TERMINAL_STATUSES.has(status),
  };
}

/** 当时处于超时未结状态的转诊：最近事件开有待办且时限已过。 */
export function overdueOpenStates(db, asOf) {
  const rows = db
    .prepare(
      `SELECT e.* FROM referral_events e
       JOIN (SELECT referral_id, MAX(seq) AS max_seq FROM referral_events
             WHERE recorded_at <= ? GROUP BY referral_id) m
         ON m.referral_id = e.referral_id AND m.max_seq = e.seq
       WHERE e.open_phase IS NOT NULL AND e.sla_due_at IS NOT NULL AND e.sla_due_at < ?
       ORDER BY e.sla_due_at`,
    )
    .all(asOf, asOf);
  return rows.map(hydrate);
}
