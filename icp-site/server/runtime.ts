// Process-wide runtime state shared by the server entry and the shims that stand in for the
// Cloudflare / Next.js modules the original code imports (see build-server.mjs).
import { AsyncLocalStorage } from 'node:async_hooks';
import { D1Database } from './d1';
import m0000 from '../src/drizzle/0000_soft_smasher.sql';
import m0001 from '../src/drizzle/0001_cold_shen.sql';
import m0002 from '../src/drizzle/0002_contact_name.sql';
import m0003 from '../src/drizzle/0003_secret_giant_man.sql';
import m0004 from '../src/drizzle/0004_local_admin.sql';

export const DB_PATH = process.env.ICP_DB_PATH || '/var/lib/hio-icp-site/site.db';

// Order matters; never edit or remove an applied migration, add a new file instead.
const MIGRATIONS: [string, string][] = [
  ['0000_soft_smasher', m0000],
  ['0001_cold_shen', m0001],
  ['0002_contact_name', m0002],
  ['0003_secret_giant_man', m0003],
  ['0004_local_admin', m0004],
];

let database: D1Database | null = null;

export function getD1(): D1Database {
  if (!database) {
    database = new D1Database(DB_PATH);
    migrate(database);
  }
  return database;
}

export function closeD1() {
  database?.close();
  database = null;
}

function migrate(d1: D1Database) {
  const { db } = d1;
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY NOT NULL, applied_at text NOT NULL)');
  const done = new Set((db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) db.exec(stmt);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
      db.exec('COMMIT');
      console.log(`migration applied: ${name}`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${name} failed: ${(e as Error).message}`);
    }
  }
}

// Per-request context: what next/headers' headers() / cookies() read.
export const requestContext = new AsyncLocalStorage<{ headers: Headers }>();
