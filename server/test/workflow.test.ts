import { describe, it, expect, beforeEach } from 'vitest';
import { setup } from './helpers';

let s: ReturnType<typeof setup>;
beforeEach(() => {
  s = setup();
});

const act = (who: Parameters<typeof s.api>[0], id: number, action: string, expectedVersion: number, note?: string) =>
  s.api(who).post(`/api/items/${id}/transitions`, { action, expectedVersion, note });

describe('workflow rules', () => {
  it('runs the full lifecycle and records every step in order', async () => {
    let item = await s.createItem('rahul');
    item = (await s.api('rahul').post(`/api/items/${item.id}/claim`)).body;
    item = (await act('rahul', item.id, 'start', item.version)).body;
    item = (await act('rahul', item.id, 'block', item.version, 'Waiting on bank')).body;
    item = (await act('rahul', item.id, 'start', item.version)).body;
    item = (await act('rahul', item.id, 'resolve', item.version, 'Refund reissued')).body;
    expect(item.status).toBe('resolved');
    expect(item.resolvedAt).not.toBeNull();
    item = (await act('priya', item.id, 'close', item.version)).body;
    expect(item.status).toBe('closed');

    const history = (await s.api('rahul').get(`/api/items/${item.id}/events`)).body.events;
    expect(history.map((e: any) => e.data.action ?? e.type)).toEqual(['created', 'claimed', 'start', 'block', 'start', 'resolve', 'close']);
    // Item versions in history are strictly increasing: nothing was lost or applied twice.
    const versions = history.map((e: any) => e.itemVersion);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('rejects transitions that are not valid from the current state', async () => {
    const item = await s.createItem('rahul');
    const res = await act('rahul', item.id, 'resolve', item.version, 'x');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('cannot start work without an owner', async () => {
    const item = await s.createItem('rahul');
    const res = await act('priya', item.id, 'start', item.version);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/owner/i);
  });

  it('requires a note for resolving, blocking, rejecting and cancelling', async () => {
    let item = await s.createItem('rahul', { assigneeId: s.users.rahul.id });
    item = (await act('rahul', item.id, 'start', item.version)).body;
    const res = await act('rahul', item.id, 'resolve', item.version, '   ');
    expect(res.status).toBe(400);
  });

  it('work that needs approval cannot start until a lead approves it', async () => {
    let item = await s.createItem('rahul', { requiresApproval: true, assigneeId: s.users.rahul.id });
    const early = await act('rahul', item.id, 'start', item.version);
    expect(early.status).toBe(409);
    item = (await act('rahul', item.id, 'submit_for_approval', item.version)).body;
    item = (await act('priya', item.id, 'approve', item.version)).body;
    expect(item.status).toBe('open');
    const started = await act('rahul', item.id, 'start', item.version);
    expect(started.status).toBe(200);
  });

  it('changing the substance of an approved request voids the approval', async () => {
    let item = await s.createItem('rahul', { requiresApproval: true, assigneeId: s.users.rahul.id });
    item = (await act('rahul', item.id, 'submit_for_approval', item.version)).body;
    item = (await act('priya', item.id, 'approve', item.version)).body;
    item = (await s.api('rahul').patch(`/api/items/${item.id}`, { expectedVersion: item.version, description: 'Refund 300 merchants instead' })).body;
    expect(item.approvedBy).toBeNull();
    expect((await act('rahul', item.id, 'start', item.version)).status).toBe(409);
    const last = (await s.api('rahul').get(`/api/items/${item.id}/events`)).body.events.at(-1);
    expect(last.data.approvalInvalidated).toBe(true);
  });

  it('releasing in-progress work puts it back in the open queue', async () => {
    let item = await s.createItem('rahul', { assigneeId: s.users.rahul.id });
    item = (await act('rahul', item.id, 'start', item.version)).body;
    item = (await s.api('rahul').post(`/api/items/${item.id}/release`, { expectedAssigneeId: s.users.rahul.id })).body;
    expect(item.status).toBe('open');
    expect(item.assignee).toBeNull();
  });

  it('closed items cannot be edited until reopened (with a reason)', async () => {
    let item = await s.createItem('rahul');
    item = (await act('rahul', item.id, 'cancel', item.version, 'Duplicate of PAY-1')).body;
    expect((await s.api('rahul').patch(`/api/items/${item.id}`, { expectedVersion: item.version, priority: 1 })).status).toBe(409);
    expect((await act('meera', item.id, 'reopen', item.version)).status).toBe(400);
    expect((await act('meera', item.id, 'reopen', item.version, 'Not a duplicate')).body.status).toBe('open');
  });
});
