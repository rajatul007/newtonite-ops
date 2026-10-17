import { describe, it, expect, beforeEach } from 'vitest';
import { setup } from './helpers';

let s: ReturnType<typeof setup>;
beforeEach(() => {
  s = setup();
});

const events = (itemId: number, type?: string) =>
  s.db.prepare(`SELECT * FROM item_events WHERE work_item_id = ? ${type ? 'AND type = ?' : ''} ORDER BY id`).all(...(type ? [itemId, type] : [itemId])) as any[];

describe('claiming work', () => {
  it('lets exactly one of two simultaneous claimers win', async () => {
    const item = await s.createItem('priya');
    const [a, b] = await Promise.all([
      s.api('rahul').post(`/api/items/${item.id}/claim`),
      s.api('meera').post(`/api/items/${item.id}/claim`),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('ALREADY_CLAIMED');
    expect(loser.body.error.details.current.assignee).not.toBeNull(); // loser learns who owns it now

    const winner = a.status === 200 ? 'rahul' : 'meera';
    const row = s.db.prepare('SELECT assignee_id FROM work_items WHERE id = ?').get(item.id) as any;
    expect(row.assignee_id).toBe(s.users[winner].id);
    expect(events(item.id, 'claimed')).toHaveLength(1);
  });

  it('treats a repeated claim by the owner as a harmless no-op', async () => {
    const item = await s.createItem('priya');
    const first = await s.api('rahul').post(`/api/items/${item.id}/claim`);
    const again = await s.api('rahul').post(`/api/items/${item.id}/claim`);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(first.body.version);
    expect(events(item.id, 'claimed')).toHaveLength(1);
  });

  it('does not fail a claim just because someone commented meanwhile', async () => {
    const item = await s.createItem('priya');
    await s.api('meera').post(`/api/items/${item.id}/comments`, { body: 'Looking at logs' });
    const res = await s.api('rahul').post(`/api/items/${item.id}/claim`);
    expect(res.status).toBe(200);
  });

  it('a stale "release" cannot unassign someone who took over in the meantime', async () => {
    const item = await s.createItem('priya');
    await s.api('rahul').post(`/api/items/${item.id}/claim`);
    const loaded = (await s.api('priya').get(`/api/items/${item.id}`)).body;
    // Lead reassigns to meera
    expect((await s.api('priya').post(`/api/items/${item.id}/assign`, { expectedVersion: loaded.version, assigneeId: s.users.meera.id })).status).toBe(200);
    // Lead's other tab still thinks rahul owns it and clicks "release"
    const stale = await s.api('priya').post(`/api/items/${item.id}/release`, { expectedAssigneeId: s.users.rahul.id });
    expect(stale.status).toBe(409);
    expect((await s.api('priya').get(`/api/items/${item.id}`)).body.assignee.id).toBe(s.users.meera.id);
  });
});

describe('optimistic concurrency on edits', () => {
  it('rejects a write based on a stale version and keeps the newer data', async () => {
    const item = await s.createItem('rahul');
    const v = item.version;
    const a = await s.api('rahul').patch(`/api/items/${item.id}`, { expectedVersion: v, priority: 1 });
    expect(a.status).toBe(200);
    const b = await s.api('meera').patch(`/api/items/${item.id}`, { expectedVersion: v, priority: 4 });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('VERSION_CONFLICT');
    expect(b.body.error.details.current.priority).toBe(1); // client gets what it needs to reconcile
    expect((await s.api('rahul').get(`/api/items/${item.id}`)).body.priority).toBe(1);
  });

  it('bumps the version exactly once per effective change and not for no-ops', async () => {
    const item = await s.createItem('rahul');
    const same = await s.api('rahul').patch(`/api/items/${item.id}`, { expectedVersion: item.version, priority: item.priority });
    expect(same.body.version).toBe(item.version);
    const changed = await s.api('rahul').patch(`/api/items/${item.id}`, { expectedVersion: item.version, priority: 1 });
    expect(changed.body.version).toBe(item.version + 1);
  });

  it('comments do not invalidate somebody else’s pending edit', async () => {
    const item = await s.createItem('rahul');
    await s.api('meera').post(`/api/items/${item.id}/comments`, { body: 'fyi' });
    const res = await s.api('rahul').patch(`/api/items/${item.id}`, { expectedVersion: item.version, title: 'Refund stuck for merchant 42' });
    expect(res.status).toBe(200);
  });

  it('an approver cannot approve a request that changed while they were reviewing it', async () => {
    const item = await s.createItem('rahul', { requiresApproval: true });
    const submitted = await s.api('rahul').post(`/api/items/${item.id}/transitions`, { action: 'submit_for_approval', expectedVersion: item.version });
    const reviewedVersion = submitted.body.version;
    // Requester changes the scope while the lead is reading
    await s.api('rahul').patch(`/api/items/${item.id}`, { expectedVersion: reviewedVersion, description: 'Actually refund all 300 merchants' });
    const approve = await s.api('priya').post(`/api/items/${item.id}/transitions`, { action: 'approve', expectedVersion: reviewedVersion });
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe('VERSION_CONFLICT');
    expect((await s.api('priya').get(`/api/items/${item.id}`)).body.approvedBy).toBeNull();
  });
});
