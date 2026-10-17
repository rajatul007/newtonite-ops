import { describe, it, expect, beforeEach } from 'vitest';
import { setup } from './helpers';

let s: ReturnType<typeof setup>;
beforeEach(() => {
  s = setup();
});

const body = () => ({ teamId: s.teams.PAY, title: 'Investigate duplicate charge', kind: 'payment', priority: 2 });
const count = (sql: string) => (s.db.prepare(sql).get() as { n: number }).n;

describe('idempotent commands', () => {
  it('a retried create with the same key returns the original item instead of a duplicate', async () => {
    const key = { 'Idempotency-Key': 'create-abc-123' };
    const first = await s.api('rahul').post('/api/items', body(), key);
    const retry = await s.api('rahul').post('/api/items', body(), key);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
    expect(count('SELECT COUNT(*) n FROM work_items')).toBe(1);
    expect(count(`SELECT COUNT(*) n FROM item_events WHERE type = 'created'`)).toBe(1);
  });

  it('a burst of identical double-submits creates exactly one item', async () => {
    const key = { 'Idempotency-Key': 'double-click-0001' };
    const results = await Promise.all(Array.from({ length: 5 }, () => s.api('rahul').post('/api/items', body(), key)));
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(count('SELECT COUNT(*) n FROM work_items')).toBe(1);
  });

  it('rejects reuse of a key for a different request', async () => {
    const key = { 'Idempotency-Key': 'create-abc-123' };
    await s.api('rahul').post('/api/items', body(), key);
    const res = await s.api('rahul').post('/api/items', { ...body(), title: 'Something else entirely' }, key);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('scopes keys per user', async () => {
    const key = { 'Idempotency-Key': 'shared-key-0001' };
    const a = await s.api('rahul').post('/api/items', body(), key);
    const b = await s.api('meera').post('/api/items', body(), key);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it('does not remember failures, so a retry after fixing the cause succeeds', async () => {
    const item = await s.createItem('rahul');
    const key = { 'Idempotency-Key': 'comment-retry-01' };
    // Simulate a transient server-side failure by temporarily breaking the table, then retry.
    s.db.exec('ALTER TABLE item_events RENAME TO item_events_tmp');
    const failed = await s.api('rahul').post(`/api/items/${item.id}/comments`, { body: 'hello' }, key);
    expect(failed.status).toBe(500);
    s.db.exec('ALTER TABLE item_events_tmp RENAME TO item_events');
    const ok = await s.api('rahul').post(`/api/items/${item.id}/comments`, { body: 'hello' }, key);
    expect(ok.status).toBe(201);
    expect(ok.headers['idempotent-replayed']).toBeUndefined();
    expect(count(`SELECT COUNT(*) n FROM item_events WHERE type = 'comment'`)).toBe(1);
  });

  it('a failed command leaves no partial effects (atomicity)', async () => {
    const item = await s.createItem('rahul');
    const before = count('SELECT COUNT(*) n FROM item_events') + count('SELECT COUNT(*) n FROM jobs');
    const res = await s.api('rahul').post(`/api/items/${item.id}/transitions`, { action: 'resolve', expectedVersion: item.version, note: 'done' });
    expect(res.status).toBe(409); // cannot resolve an open item
    expect(count('SELECT COUNT(*) n FROM item_events') + count('SELECT COUNT(*) n FROM jobs')).toBe(before);
  });
});
