// A small Cloudflare D1-compatible wrapper over Node's built-in node:sqlite, so the original route code
// (drizzle-orm/d1 plus a few raw env.DB.prepare(...).bind(...).run() calls) runs unchanged on our server.
// Only the parts of the D1 API that drizzle-orm/d1 0.45 and src/app/api/** call are implemented:
//   prepare(sql).bind(...params).{all,run,raw,first}()  and  batch([...statements])
// node:sqlite is synchronous and this server is a single process, so every statement is atomic and
// serialized; batch() wraps its statements in one transaction like D1 does.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type Param = null | number | bigint | string | Uint8Array;
type Row = Record<string, unknown>;
type Meta = { changes: number; last_row_id: number; duration: number };
type D1Result = { results: Row[]; success: true; meta: Meta };

function toParam(v: unknown): Param {
  if (v === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as Param;
}

export class D1PreparedStatement {
  constructor(private db: DatabaseSync, private sql: string, private params: Param[] = []) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new D1PreparedStatement(this.db, this.sql, values.map(toParam));
  }

  private stmt(): StatementSync {
    return this.db.prepare(this.sql);
  }

  async all(): Promise<D1Result> {
    return this.allSync();
  }

  allSync(): D1Result {
    const results = this.stmt().all(...this.params) as Row[];
    return { results, success: true, meta: this.meta() };
  }

  async run(): Promise<D1Result> {
    const r = this.stmt().run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), duration: 0 } };
  }

  async raw(): Promise<unknown[][]> {
    return (this.stmt().all(...this.params) as Row[]).map((row) => Object.values(row));
  }

  async first(column?: string): Promise<unknown> {
    const row = this.stmt().get(...this.params) as Row | undefined;
    if (!row) return null;
    return column ? row[column] : row;
  }

  private meta(): Meta {
    const c = this.db.prepare('SELECT changes() AS changes, last_insert_rowid() AS id').get() as Row;
    return { changes: Number(c.changes), last_row_id: Number(c.id), duration: 0 };
  }
}

export class D1Database {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  }

  prepare(sql: string): D1PreparedStatement {
    return new D1PreparedStatement(this.db, sql);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = statements.map((s) => s.allSync());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async exec(sql: string) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }

  close() {
    this.db.close();
  }
}
