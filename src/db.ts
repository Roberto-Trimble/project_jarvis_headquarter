import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from "sql.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// SQLite through sql.js (WASM), so the service installs without a native build toolchain.
// The file is written back after each change. Fine for one service process; not for several.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS control (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, stage TEXT NOT NULL,
  branch TEXT, pr_url TEXT, budget_cap INTEGER NOT NULL,
  blocked_reason TEXT, next_action TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, story_id TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL,
  waiting_on TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, story_id TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL,
  summary TEXT NOT NULL, links TEXT NOT NULL, status TEXT NOT NULL,
  decided_by TEXT, note TEXT, created TEXT NOT NULL, decided TEXT);
CREATE TABLE IF NOT EXISTS ci_waits (
  run_id TEXT PRIMARY KEY, story_id TEXT NOT NULL, pr_number INTEGER NOT NULL,
  head_sha TEXT, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shortcuts (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, author TEXT NOT NULL, story_id TEXT NOT NULL,
  project TEXT NOT NULL, repo TEXT NOT NULL, commit_sha TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, evidence TEXT NOT NULL,
  status TEXT NOT NULL, verified_by TEXT, verify_evidence TEXT, uses INTEGER NOT NULL DEFAULT 0,
  expires TEXT NOT NULL, created TEXT NOT NULL, retired_reason TEXT);
CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, story_id TEXT, data TEXT NOT NULL);
`;

type Param = string | number | null | undefined;
const bindable = (params: Param[]): SqlValue[] => params.map((p) => (p === undefined ? null : p));

export class Statement {
  constructor(private db: DB, private sql: string) {}
  run(...params: Param[]): { changes: number } {
    this.db.raw.run(this.sql, bindable(params));
    const changes = this.db.raw.getRowsModified();
    if (changes) this.db.persist();
    return { changes };
  }
  get(...params: Param[]): unknown {
    return this.all(...params)[0];
  }
  all(...params: Param[]): unknown[] {
    const stmt = this.db.raw.prepare(this.sql);
    try {
      stmt.bind(bindable(params));
      const rows: unknown[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }
}

export class DB {
  constructor(readonly raw: SqlJsDatabase, private path: string) {}
  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }
  exec(sql: string): void {
    this.raw.exec(sql);
    this.persist();
  }
  persist(): void {
    if (this.path === ":memory:") return;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, this.raw.export());
    renameSync(tmp, this.path);
  }
}

export async function openDb(path: string): Promise<DB> {
  const SQL = await initSqlJs();
  let raw: SqlJsDatabase;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
    raw = existsSync(path) ? new SQL.Database(readFileSync(path)) : new SQL.Database();
  } else {
    raw = new SQL.Database();
  }
  const db = new DB(raw, path);
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();

/** Only the service writes the audit log. Actor comes from the caller's token, never from arguments. */
export function audit(db: DB, actor: string, action: string, storyId: string | null, data: unknown = {}): void {
  db.prepare("INSERT INTO audit (at, actor, action, story_id, data) VALUES (?, ?, ?, ?, ?)")
    .run(now(), actor, action, storyId, JSON.stringify(data));
}

/** Returns true the first time a key is seen; used to drop duplicate webhooks and trigger events. */
export function firstSeen(db: DB, key: string): boolean {
  return db.prepare("INSERT OR IGNORE INTO events (key, created) VALUES (?, ?)").run(key, now()).changes === 1;
}
