/**
 * Durable job queue backed by the `jobs` table (a transactional outbox).
 *
 * Guarantees:
 *  - A job is enqueued in the SAME transaction as the change that caused it, so a committed change
 *    always has its follow-up work recorded, and a rolled-back change never does.
 *  - Delivery is at-least-once: a worker leases a job for LEASE_MS; if it crashes, the lease expires
 *    and another worker re-runs it. Handlers therefore MUST be idempotent.
 *  - Failures are retried with exponential backoff; after max_attempts the job is marked `dead`
 *    and kept for inspection instead of being silently dropped.
 *  - dedupe_key (UNIQUE) prevents the same logical job from being enqueued twice.
 */
import { randomUUID } from 'node:crypto';
import type { DB, Clock } from './db';
import { iso } from './db';

export const LEASE_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface JobRow {
  id: number;
  type: string;
  payload: string;
  status: 'pending' | 'running' | 'done' | 'dead';
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_by: string | null;
  locked_until: string | null;
  last_error: string | null;
  dedupe_key: string | null;
}

export type JobHandler = (payload: any, job: JobRow) => void | Promise<void>;

export function enqueue(
  db: DB,
  clock: Clock,
  type: string,
  payload: unknown,
  opts: { dedupeKey?: string; delayMs?: number; maxAttempts?: number } = {},
) {
  const now = clock.now();
  db.prepare(
    `INSERT INTO jobs (type, payload, run_after, dedupe_key, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  ).run(
    type,
    JSON.stringify(payload),
    iso(new Date(now.getTime() + (opts.delayMs ?? 0))),
    opts.dedupeKey ?? null,
    opts.maxAttempts ?? 5,
    iso(now),
    iso(now),
  );
}

export const backoffMs = (attempts: number) => Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempts - 1));

export class Worker {
  readonly id = `worker-${randomUUID().slice(0, 8)}`;
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private db: DB,
    private clock: Clock,
    private handlers: Record<string, JobHandler>,
    private log: (msg: string) => void = () => {},
  ) {}

  /** Atomically lease the next runnable job (pending & due, or running with an expired lease). */
  claimNext(): JobRow | undefined {
    const now = iso(this.clock.now());
    const leaseUntil = iso(new Date(this.clock.now().getTime() + LEASE_MS));
    return this.db
      .prepare(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = ?, locked_until = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE (status = 'pending' AND run_after <= ?) OR (status = 'running' AND locked_until < ?)
           ORDER BY run_after, id LIMIT 1
         )
         RETURNING *`,
      )
      .get(this.id, leaseUntil, now, now, now) as JobRow | undefined;
  }

  complete(job: JobRow) {
    // Guard on locked_by: if our lease expired and someone else took the job, don't clobber their state.
    this.db
      .prepare(`UPDATE jobs SET status = 'done', locked_by = NULL, locked_until = NULL, updated_at = ? WHERE id = ? AND locked_by = ?`)
      .run(iso(this.clock.now()), job.id, this.id);
  }

  fail(job: JobRow, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const now = this.clock.now();
    const dead = job.attempts >= job.max_attempts;
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, run_after = ?, last_error = ?, locked_by = NULL, locked_until = NULL, updated_at = ?
         WHERE id = ? AND locked_by = ?`,
      )
      .run(dead ? 'dead' : 'pending', iso(new Date(now.getTime() + backoffMs(job.attempts))), message.slice(0, 1000), iso(now), job.id, this.id);
    this.log(`job ${job.id} (${job.type}) failed attempt ${job.attempts}/${job.max_attempts}${dead ? ' -> dead' : ''}: ${message}`);
  }

  /** Process up to `max` jobs. Returns how many were attempted. */
  async runOnce(max = 50): Promise<number> {
    let n = 0;
    while (n < max) {
      const job = this.claimNext();
      if (!job) break;
      n++;
      const handler = this.handlers[job.type];
      try {
        if (!handler) throw new Error(`No handler for job type ${job.type}`);
        await handler(JSON.parse(job.payload), job);
        this.complete(job);
      } catch (err) {
        this.fail(job, err);
      }
    }
    return n;
  }

  start(intervalMs = 500) {
    this.timer = setInterval(async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        await this.runOnce();
      } catch (e) {
        this.log(`worker loop error: ${(e as Error).message}`);
      } finally {
        this.busy = false;
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
