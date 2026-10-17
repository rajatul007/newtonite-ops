import { describe, it, expect, beforeEach } from 'vitest';
import { setup } from './helpers';
import { Worker, enqueue, LEASE_MS, backoffMs } from '../src/jobs';
import { notifyHandler } from '../src/notifications';

let s: ReturnType<typeof setup>;
beforeEach(() => {
  s = setup();
});

const jobs = () => s.db.prepare('SELECT * FROM jobs ORDER BY id').all() as any[];
const notifications = () => s.db.prepare('SELECT * FROM notifications ORDER BY id').all() as any[];

describe('outbox + async notification processing', () => {
  it('enqueues the notification job atomically with the change, and computes recipients at event time', async () => {
    const item = await s.createItem('rahul');
    await s.api('priya').post(`/api/items/${item.id}/comments`, { body: 'Please prioritise' });
    const job = jobs().find((j) => j.type === 'notify')!;
    expect(JSON.parse(job.payload).recipients).toEqual([s.users.rahul.id]); // reporter, excluding the actor
  });

  it('new P1 items page the team leads', async () => {
    await s.createItem('rahul', { priority: 1 });
    const recipients = JSON.parse(jobs()[0].payload).recipients.sort();
    expect(recipients).toEqual([s.users.priya.id, s.users.lena.id].sort());
  });

  it('delivers notifications exactly once even if the job runs twice', async () => {
    const item = await s.createItem('rahul');
    await s.api('priya').post(`/api/items/${item.id}/comments`, { body: 'ping' });
    const handler = notifyHandler(s.db, s.clock, s.bus, 0);
    const payload = JSON.parse(jobs()[0].payload);
    handler(payload, jobs()[0]);
    handler(payload, jobs()[0]); // duplicate delivery
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].user_id).toBe(s.users.rahul.id);
  });

  it('retries failures with exponential backoff and parks the job as dead after max attempts', async () => {
    enqueue(s.db, s.clock, 'flaky', {}, { maxAttempts: 3 });
    let calls = 0;
    const w = new Worker(s.db, s.clock, { flaky: () => { calls++; throw new Error('provider down'); } });

    await w.runOnce();
    expect(jobs()[0]).toMatchObject({ status: 'pending', attempts: 1, last_error: 'provider down' });
    await w.runOnce(); // not due yet
    expect(calls).toBe(1);

    s.clock.advance(backoffMs(1));
    await w.runOnce();
    expect(jobs()[0]).toMatchObject({ status: 'pending', attempts: 2 });
    s.clock.advance(backoffMs(2));
    await w.runOnce();
    expect(jobs()[0]).toMatchObject({ status: 'dead', attempts: 3 });
    s.clock.advance(60 * 60_000);
    await w.runOnce();
    expect(calls).toBe(3); // dead jobs are kept for inspection, never re-run automatically
  });

  it('recovers a job whose worker crashed mid-run (lease expiry), and the crashed worker cannot overwrite the outcome', async () => {
    enqueue(s.db, s.clock, 'work', { n: 1 });
    const crashed = new Worker(s.db, s.clock, {});
    const leased = crashed.claimNext()!; // worker takes the job... and dies
    expect(leased.status).toBe('running');

    const healthy = new Worker(s.db, s.clock, { work: () => {} });
    expect(await healthy.runOnce()).toBe(0); // lease still valid: nobody else may take it
    s.clock.advance(LEASE_MS + 1);
    expect(await healthy.runOnce()).toBe(1);
    expect(jobs()[0]).toMatchObject({ status: 'done', attempts: 2 });

    crashed.fail(leased, new Error('zombie wakes up')); // late write from the old lease holder
    expect(jobs()[0].status).toBe('done');
  });

  it('dedupe keys stop the same logical job being enqueued twice', () => {
    enqueue(s.db, s.clock, 'cleanup', {}, { dedupeKey: 'cleanup:2026-10-01T09' });
    enqueue(s.db, s.clock, 'cleanup', {}, { dedupeKey: 'cleanup:2026-10-01T09' });
    expect(jobs()).toHaveLength(1);
  });

  it('pushes a live notification to the recipient once processed', async () => {
    const seen: any[] = [];
    s.bus.onEvent((e) => seen.push(e));
    const item = await s.createItem('rahul');
    await s.api('priya').post(`/api/items/${item.id}/assign`, { expectedVersion: item.version, assigneeId: s.users.meera.id });
    await new Worker(s.db, s.clock, { notify: notifyHandler(s.db, s.clock, s.bus, 0) }).runOnce();
    const pushed = seen.filter((e) => e.type === 'notification').map((e) => e.userId).sort();
    expect(pushed).toEqual([s.users.rahul.id, s.users.meera.id].sort());
    expect(seen.some((e) => e.type === 'item.changed' && e.eventType === 'assigned')).toBe(true);
  });
});
