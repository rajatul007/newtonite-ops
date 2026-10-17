import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodType } from 'zod';
import type { Deps, Ctx } from './context';
import { makeCtx } from './context';
import { HttpError, badRequest, unprocessable } from './errors';
import { iso } from './db';

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw badRequest(
      r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      r.error.issues,
    );
  }
  return r.data;
}

/**
 * Wraps a state-changing handler:
 *  - runs it in ONE immediate (write-locked) transaction,
 *  - honours the `Idempotency-Key` header: the key and the response are stored in the same
 *    transaction as the effect, so "effect happened" and "key recorded" can never disagree.
 *    A retry with the same key and body replays the original response without re-executing;
 *    the same key with a different body is rejected (422).
 *  - only successful responses are stored. A failed command changed nothing (its transaction rolled
 *    back), so re-executing it on retry is safe and lets the client recover after fixing the cause.
 *  - runs ctx.afterCommit hooks (live broadcasts) only once the transaction has committed.
 */
export function command(deps: Deps, handler: (ctx: Ctx, req: Request) => { status?: number; body: unknown }) {
  return (req: Request, res: Response) => {
    const user = req.user!;
    const key = req.header('Idempotency-Key');
    if (key !== undefined && (key.length < 8 || key.length > 128)) throw badRequest('Idempotency-Key must be 8-128 characters');
    const requestHash = createHash('sha256')
      .update(`${req.method} ${req.originalUrl.split('?')[0]} ${stableStringify(req.body ?? {})}`)
      .digest('hex');

    const ctx = makeCtx(deps, user);
    let replay: { status_code: number; response_body: string } | undefined;

    const result = deps.db
      .transaction(() => {
        if (key) {
          const existing = deps.db
            .prepare(`SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE user_id = ? AND key = ?`)
            .get(user.id, key) as { request_hash: string; status_code: number; response_body: string } | undefined;
          if (existing) {
            if (existing.request_hash !== requestHash) {
              throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
            }
            replay = existing;
            return undefined;
          }
        }
        const out = handler(ctx, req);
        const status = out.status ?? 200;
        if (key) {
          deps.db
            .prepare(
              `INSERT INTO idempotency_keys (user_id, key, request_hash, status_code, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(user.id, key, requestHash, status, JSON.stringify(out.body), iso(deps.clock.now()));
        }
        return { status, body: out.body };
      })
      .immediate();

    if (replay) {
      res.set('Idempotent-Replayed', 'true').status(replay.status_code).json(JSON.parse(replay.response_body));
      return;
    }
    for (const fn of ctx.afterCommit) {
      try { fn(); } catch { /* broadcasts are best-effort */ }
    }
    res.status(result!.status).json(result!.body);
  };
}

export function query(deps: Deps, handler: (ctx: Ctx, req: Request) => unknown) {
  return (req: Request, res: Response) => {
    res.json(handler(makeCtx(deps, req.user!), req));
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    return;
  }
  if ((err as any)?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' } });
    return;
  }
  if ((err as any)?.code === 'SQLITE_BUSY') {
    res.set('Retry-After', '1').status(503).json({ error: { code: 'BUSY', message: 'The system is busy, please retry' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. It is safe to retry.' } });
}
