import express, { type Request } from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Deps } from './context';
import { SESSION_COOKIE, authMiddleware, createSession, destroySession, verifyPassword } from './auth';
import { command, errorHandler, parse, query } from './http';
import { HttpError, notFound } from './errors';
import { KINDS, STATUSES, TRANSITION_ACTIONS, canView } from './policy';
import * as items from './items';
import { iso } from './db';

const id = z.coerce.number().int().positive();
const version = z.number().int().positive();
const dueAt = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString()).nullable();

const createSchema = z.object({
  teamId: z.number().int().positive(),
  title: z.string().trim().min(3).max(200),
  description: z.string().max(20_000).default(''),
  kind: z.enum(KINDS),
  priority: z.number().int().min(1).max(4),
  requiresApproval: z.boolean().default(false),
  dueAt: dueAt.default(null),
  assigneeId: z.number().int().positive().nullable().default(null),
});

const updateSchema = z
  .object({
    expectedVersion: version,
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().max(20_000).optional(),
    kind: z.enum(KINDS).optional(),
    priority: z.number().int().min(1).max(4).optional(),
    dueAt: dueAt.optional(),
    requiresApproval: z.boolean().optional(),
  })
  .strict();

const csv = <T extends z.ZodType<any, any>>(item: T) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').filter(Boolean) : undefined))
    .pipe(z.array(item).optional());

const listSchema = z.object({
  teamId: id.optional(),
  status: csv(z.enum(STATUSES)),
  priority: csv(z.coerce.number().int().min(1).max(4)),
  kind: csv(z.enum(KINDS)),
  assignee: z.union([z.literal('me'), z.literal('none'), id]).optional(),
  reporter: z.literal('me').optional(),
  q: z.string().max(200).optional(),
  overdue: z.stringbool().optional(),
  stale: z.stringbool().optional(),
  needsMyApproval: z.stringbool().optional(),
  sort: z.enum(['activity', 'priority', 'created']).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const itemId = (req: Request) => parse(id, req.params.id);

export function createApp(deps: Deps) {
  const { db, clock, bus } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- auth (public)
  app.post('/api/auth/login', (req, res) => {
    const { email, password } = parse(z.object({ email: z.string(), password: z.string() }), req.body);
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email) as
      | { id: number; password_hash: string }
      | undefined;
    // Same error for unknown user and wrong password.
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    const token = createSession(db, clock, user.id);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict', // also our CSRF defence: the cookie is never sent on cross-site requests
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 3600_000,
    });
    res.json({ token });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) destroySession(db, token);
    res.clearCookie(SESSION_COOKIE).json({ ok: true });
  });

  // Everything below requires a session.
  app.use('/api', authMiddleware(db, clock));

  app.get('/api/me', (req, res) => {
    const u = req.user!;
    const teams = db
      .prepare(
        u.isAdmin
          ? `SELECT t.id, t.name, t.key, COALESCE(m.role, 'lead') AS role FROM teams t LEFT JOIN memberships m ON m.team_id = t.id AND m.user_id = ? ORDER BY t.name`
          : `SELECT t.id, t.name, t.key, m.role FROM teams t JOIN memberships m ON m.team_id = t.id AND m.user_id = ? ORDER BY t.name`,
      )
      .all(u.id);
    res.json({ id: u.id, name: u.name, email: u.email, isAdmin: u.isAdmin, teams });
  });

  app.get('/api/teams/:id/members', (req, res) => {
    const teamId = itemId(req);
    if (!canView(req.user!, teamId)) throw notFound('Team');
    res.json(
      db
        .prepare(`SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY u.name`)
        .all(teamId),
    );
  });

  // ---------------------------------------------------------------- work items
  app.get('/api/dashboard', query(deps, (ctx, req) => items.dashboard(ctx, req.query.teamId ? parse(id, req.query.teamId) : undefined)));

  app.get('/api/items', query(deps, (ctx, req) => items.listItems(ctx, parse(listSchema, req.query) as items.ListFilters)));

  app.post(
    '/api/items',
    command(deps, (ctx, req) => ({ status: 201, body: items.createItem(ctx, parse(createSchema, req.body)) })),
  );

  app.get('/api/items/:id', query(deps, (ctx, req) => items.getItem(ctx, itemId(req))));

  app.patch(
    '/api/items/:id',
    command(deps, (ctx, req) => {
      const { expectedVersion, ...patch } = parse(updateSchema, req.body);
      return { body: items.updateItem(ctx, itemId(req), expectedVersion, patch) };
    }),
  );

  app.post(
    '/api/items/:id/claim',
    command(deps, (ctx, req) => ({ body: items.claimItem(ctx, itemId(req)).item })),
  );

  app.post(
    '/api/items/:id/release',
    command(deps, (ctx, req) => {
      const { expectedAssigneeId } = parse(z.object({ expectedAssigneeId: z.number().int().positive() }), req.body);
      return { body: items.releaseItem(ctx, itemId(req), expectedAssigneeId) };
    }),
  );

  app.post(
    '/api/items/:id/assign',
    command(deps, (ctx, req) => {
      const b = parse(z.object({ expectedVersion: version, assigneeId: z.number().int().positive().nullable() }), req.body);
      return { body: items.assignItem(ctx, itemId(req), b.expectedVersion, b.assigneeId) };
    }),
  );

  app.post(
    '/api/items/:id/transitions',
    command(deps, (ctx, req) => {
      const b = parse(
        z.object({ expectedVersion: version, action: z.enum(TRANSITION_ACTIONS as [string, ...string[]]), note: z.string().max(5000).optional() }),
        req.body,
      );
      return { body: items.transitionItem(ctx, itemId(req), b.expectedVersion, b.action as any, b.note) };
    }),
  );

  app.get(
    '/api/items/:id/events',
    query(deps, (ctx, req) => items.listEvents(ctx, itemId(req), req.query.after ? parse(z.coerce.number().int().min(0), req.query.after) : 0)),
  );

  app.post(
    '/api/items/:id/comments',
    command(deps, (ctx, req) => {
      const { body } = parse(z.object({ body: z.string().trim().min(1).max(10_000) }), req.body);
      return { status: 201, body: items.addComment(ctx, itemId(req), body) };
    }),
  );

  // ---------------------------------------------------------------- notifications
  app.get('/api/notifications', (req, res) => {
    const me = req.user!.id;
    const list = db
      .prepare(`SELECT id, work_item_id AS itemId, message, read_at AS readAt, created_at AS createdAt FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30`)
      .all(me);
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL`).get(me) as { n: number };
    res.json({ unread: n, notifications: list });
  });

  app.post('/api/notifications/read', (req, res) => {
    const { upToId } = parse(z.object({ upToId: z.number().int().positive() }), req.body);
    // Naturally idempotent: marking read twice is the same as once.
    db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND id <= ? AND read_at IS NULL`).run(iso(clock.now()), req.user!.id, upToId);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- live updates (SSE)
  app.get('/api/stream', (req, res) => {
    const u = req.user!;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`event: ready\ndata: {}\n\n`);
    const unsubscribe = bus.subscribe({ userId: u.id, isAdmin: u.isAdmin, teamIds: new Set(u.roles.keys()), res });
    const heartbeat = setInterval(() => res.write(`: ping\n\n`), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.use('/api', (_req, _res, next) => next(notFound('Endpoint')));

  // ---------------------------------------------------------------- static frontend (production build)
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(webDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
