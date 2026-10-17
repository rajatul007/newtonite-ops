import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type DB = Database.Database;

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

export function openDb(file: string = process.env.DB_FILE ?? 'data/ops.db'): DB {
  const db = new Database(file);
  // WAL lets readers proceed while a writer commits, and lets a separate worker process share the file.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // If another process holds the write lock, wait instead of failing immediately.
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(schemaPath, 'utf8'));
  return db;
}

/** Clock abstraction so tests can control time (job backoff, leases, staleness). */
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
export const iso = (d: Date) => d.toISOString();
