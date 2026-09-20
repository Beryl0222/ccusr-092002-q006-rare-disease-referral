import { DatabaseSync } from "node:sqlite";

export function openDatabase(path = process.env.DATABASE_PATH ?? "referral-network.db") {
  const sqlite3 = new DatabaseSync(path);
  sqlite3.exec("PRAGMA foreign_keys = ON");
  return sqlite3;
}
