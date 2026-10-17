import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { DB, Clock } from './db';
import { iso } from './db';
import { unauthenticated } from './errors';

export type Role = 'viewer' | 'member' | 'lead';

export interface CurrentUser {
  id: number;
  name: string;
  email: string;
  isAdmin: boolean;
  /** team_id -> role. Loaded per request so membership changes take effect immediately. */
  roles: Map<number, Role>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: CurrentUser;
    }
  }
}

export const SESSION_COOKIE = 'ops_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function createSession(db: DB, clock: Clock, userId: number): string {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(clock.now().getTime() + SESSION_TTL_MS);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    userId,
    iso(expires),
  );
  return token;
}

export function destroySession(db: DB, token: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function loadUser(db: DB, userId: number): CurrentUser | undefined {
  const row = db.prepare('SELECT id, name, email, is_admin FROM users WHERE id = ?').get(userId) as
    | { id: number; name: string; email: string; is_admin: number }
    | undefined;
  if (!row) return undefined;
  const memberships = db.prepare('SELECT team_id, role FROM memberships WHERE user_id = ?').all(userId) as {
    team_id: number;
    role: Role;
  }[];
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    isAdmin: !!row.is_admin,
    roles: new Map(memberships.map((m) => [m.team_id, m.role])),
  };
}

export function userFromToken(db: DB, clock: Clock, token: string | undefined): CurrentUser | undefined {
  if (!token) return undefined;
  const session = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(sha256(token)) as { user_id: number; expires_at: string } | undefined;
  if (!session || session.expires_at < iso(clock.now())) return undefined;
  return loadUser(db, session.user_id);
}

export function authMiddleware(db: DB, clock: Clock) {
  return (req: Request, _res: Response, next: NextFunction) => {
    // Cookie for the browser (works with EventSource); Bearer token for scripts/tests.
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.[SESSION_COOKIE];
    const user = userFromToken(db, clock, token);
    if (!user) return next(unauthenticated());
    req.user = user;
    next();
  };
}
