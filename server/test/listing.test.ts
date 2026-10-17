import { describe, it, expect, beforeEach } from 'vitest';
import { setup } from './helpers';

let s: ReturnType<typeof setup>;
beforeEach(() => {
  s = setup();
});

async function collect(url: string, who: 'rahul' | 'asha' = 'rahul', between?: () => Promise<void>) {
  const out: any[] = [];
  let cursor: string | null = null;
  do {
    const res: any = await s.api(who).get(`${url}${url.includes('?') ? '&' : '?'}limit=7${cursor ? `&cursor=${cursor}` : ''}`);
    expect(res.status).toBe(200);
    out.push(...res.body.items);
    cursor = res.body.nextCursor;
    if (between) await between();
  } while (cursor);
  return out;
}

describe('listing, filtering and search', () => {
  beforeEach(async () => {
    for (let i = 0; i < 40; i++) {
      await s.createItem('rahul', { title: `Payment issue number ${i}`, priority: (i % 4) + 1 });
      s.clock.advance(1000);
    }
  });

  it('cursor pagination visits every item exactly once in priority order', async () => {
    const all = await collect('/api/items?sort=priority');
    expect(all).toHaveLength(40);
    expect(new Set(all.map((i) => i.id)).size).toBe(40);
    const prios = all.map((i) => i.priority);
    expect(prios).toEqual([...prios].sort((a, b) => a - b));
  });

  it('is stable when new items arrive while a user is paging', async () => {
    let n = 0;
    const seen = await collect('/api/items?sort=created', 'rahul', async () => {
      await s.createItem('meera', { title: `Late arrival ${n++}` });
    });
    const original = seen.filter((i) => i.title.startsWith('Payment issue'));
    expect(original).toHaveLength(40); // no skips
    expect(new Set(seen.map((i) => i.id)).size).toBe(seen.length); // no duplicates
  });

  it('combines filters with full-text search, and treats search input as plain text', async () => {
    const res = await s.api('rahul').get('/api/items?q=number%2012&priority=1');
    expect(res.body.items.map((i: any) => i.title)).toEqual(['Payment issue number 12']);
    for (const nasty of ['"', 'title:x OR', '*', 'NEAR(a b)', "'; DROP TABLE work_items; --"]) {
      const r = await s.api('rahul').get(`/api/items?q=${encodeURIComponent(nasty)}`);
      expect(r.status).toBe(200);
    }
  });

  it('finds an item directly by its key', async () => {
    const res = await s.api('rahul').get('/api/items?q=PAY-5');
    expect(res.body.items.map((i: any) => i.id)).toEqual([5]);
  });

  it('rejects tampered cursors cleanly', async () => {
    const res = await s.api('rahul').get('/api/items?cursor=garbage');
    expect(res.status).toBe(400);
  });

  it('dashboard surfaces stale urgent work and pending approvals for the right lead', async () => {
    const urgent = await s.createItem('rahul', { priority: 1, title: 'Card auth failures' });
    s.clock.advance(25 * 3600_000);
    s.db.exec(`UPDATE sessions SET expires_at = '2100-01-01T00:00:00.000Z'`); // keep test sessions alive across the time jump
    const dash = (await s.api('priya').get('/api/dashboard')).body;
    const stale = dash.sections.find((x: any) => x.id === 'stale');
    expect(stale.items.map((i: any) => i.id)).toContain(urgent.id);

    const req = await s.createItem('rahul', { requiresApproval: true });
    await s.api('rahul').post(`/api/items/${req.id}/transitions`, { action: 'submit_for_approval', expectedVersion: req.version });
    const forPriya = (await s.api('priya').get('/api/dashboard')).body.sections.find((x: any) => x.id === 'approvals');
    const forRahul = (await s.api('rahul').get('/api/dashboard')).body.sections.find((x: any) => x.id === 'approvals');
    expect(forPriya.count).toBe(1);
    expect(forRahul.count).toBe(0);
  });
});
