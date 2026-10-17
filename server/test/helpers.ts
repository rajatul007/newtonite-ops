import request from 'supertest';
import { openDb, type Clock, type DB } from '../src/db';
import { Bus } from '../src/bus';
import { createApp } from '../src/app';
import { createSession, hashPassword } from '../src/auth';

export class TestClock implements Clock {
  constructor(public t = new Date('2026-10-01T09:00:00.000Z').getTime()) {}
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
}

/**
 * Fixture:
 *   PAY team: priya (lead), lena (lead), rahul (member), meera (member), vera (viewer)
 *   ENG team: vikram (lead), neha (member)
 *   admin: asha
 */
export function setup() {
  const db: DB = openDb(':memory:');
  const clock = new TestClock();
  const bus = new Bus();
  const app = createApp({ db, clock, bus });
  const hash = hashPassword('pw');
  const now = clock.now().toISOString();
  const team = (name: string, key: string) => Number(db.prepare('INSERT INTO teams (name, key) VALUES (?, ?)').run(name, key).lastInsertRowid);
  const PAY = team('Payments', 'PAY');
  const ENG = team('Engineering', 'ENG');
  const user = (name: string, roles: [number, string][], admin = false) => {
    const id = Number(
      db.prepare('INSERT INTO users (email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)').run(`${name}@t.test`, name, hash, admin ? 1 : 0, now).lastInsertRowid,
    );
    for (const [t, r] of roles) db.prepare('INSERT INTO memberships (user_id, team_id, role) VALUES (?, ?, ?)').run(id, t, r);
    return { id, token: createSession(db, clock, id) };
  };
  const users = {
    priya: user('priya', [[PAY, 'lead']]),
    lena: user('lena', [[PAY, 'lead']]),
    rahul: user('rahul', [[PAY, 'member']]),
    meera: user('meera', [[PAY, 'member']]),
    vera: user('vera', [[PAY, 'viewer']]),
    vikram: user('vikram', [[ENG, 'lead']]),
    neha: user('neha', [[ENG, 'member']]),
    asha: user('asha', [], true),
  };
  type U = keyof typeof users;

  const api = (who: U) => {
    const auth = { Authorization: `Bearer ${users[who].token}` };
    return {
      get: (url: string) => request(app).get(url).set(auth),
      post: (url: string, body: object = {}, headers: Record<string, string> = {}) => request(app).post(url).set({ ...auth, ...headers }).send(body),
      patch: (url: string, body: object, headers: Record<string, string> = {}) => request(app).patch(url).set({ ...auth, ...headers }).send(body),
    };
  };

  const createItem = async (who: U, overrides: object = {}) => {
    const res = await api(who).post('/api/items', {
      teamId: PAY,
      title: 'Refund stuck for merchant',
      description: 'Merchant 42 reports a refund stuck in pending',
      kind: 'payment',
      priority: 2,
      ...overrides,
    });
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };

  return { db, clock, bus, app, users, api, createItem, teams: { PAY, ENG } };
}
