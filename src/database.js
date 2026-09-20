import { DatabaseSync } from "node:sqlite";
import { SCHEMA } from "./schema.js";

export function openDatabase(path = process.env.DATABASE_PATH ?? "referral-network.db") {
  const db = new DatabaseSync(path);
  // 外键与 WAL：跨机构并发写入时提高吞吐，busy_timeout 让锁冲突等待而非立即失败。
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

// 在单个事务内执行；BEGIN IMMEDIATE 在事务开始即取写锁，
// 保证跨机构并发接诊的比较-更新原子性，进程崩溃时整笔回滚。
export function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
