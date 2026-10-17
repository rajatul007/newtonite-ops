import { describe, it, expect, beforeEach } from 'vitest';
import { setup } from './helpers';
import { decide, allowedActions, TRANSITION_ACTIONS, STATUSES, type Action, type PolicyItem } from '../src/policy';
import { loadUser } from '../src/auth';

let s: ReturnType<typeof setup>;
beforeEach(() => {
  s = setup();
});

describe('resource-level authorization (enforced by the API, not the UI)', () => {
  it('hides other teams’ items entirely: 404 on read and write, absent from lists and search', async () => {
    const item = await s.createItem('rahul', { title: 'Secret payments investigation' });
    expect((await s.api('neha').get(`/api/items/${item.id}`)).status).toBe(404);
    expect((await s.api('neha').post(`/api/items/${item.id}/claim`)).status).toBe(404);
    expect((await s.api('neha').post(`/api/items/${item.id}/comments`, { body: 'hi' })).status).toBe(404);
    const list = await s.api('neha').get('/api/items?q=secret');
    expect(list.body.items).toHaveLength(0);
    expect((await s.api('neha').get(`/api/items/${item.id}/events`)).status).toBe(404);
  });

  it('viewers can read but not change anything', async () => {
    const item = await s.createItem('rahul');
    expect((await s.api('vera').get(`/api/items/${item.id}`)).status).toBe(200);
    expect((await s.api('vera').post(`/api/items/${item.id}/claim`)).status).toBe(403);
    expect((await s.api('vera').post(`/api/items/${item.id}/comments`, { body: 'x' })).status).toBe(403);
    expect((await s.api('vera').patch(`/api/items/${item.id}`, { expectedVersion: item.version, priority: 1 })).status).toBe(403);
    const create = await s.api('vera').post('/api/items', { teamId: s.teams.PAY, title: 'Nope nope', kind: 'task', priority: 3 });
    expect(create.status).toBe(403);
  });

  it('cannot create items in a team you do not belong to', async () => {
    const res = await s.api('rahul').post('/api/items', { teamId: s.teams.ENG, title: 'Sneaky item', kind: 'task', priority: 3 });
    expect(res.status).toBe(404);
  });

  it('only leads can assign work to other people, and never to viewers', async () => {
    const item = await s.createItem('rahul');
    const byMember = await s.api('rahul').post(`/api/items/${item.id}/assign`, { expectedVersion: item.version, assigneeId: s.users.meera.id });
    expect(byMember.status).toBe(403);
    const toViewer = await s.api('priya').post(`/api/items/${item.id}/assign`, { expectedVersion: item.version, assigneeId: s.users.vera.id });
    expect(toViewer.status).toBe(400);
    const toOtherTeam = await s.api('priya').post(`/api/items/${item.id}/assign`, { expectedVersion: item.version, assigneeId: s.users.neha.id });
    expect(toOtherTeam.status).toBe(400);
    const ok = await s.api('priya').post(`/api/items/${item.id}/assign`, { expectedVersion: item.version, assigneeId: s.users.meera.id });
    expect(ok.status).toBe(200);
  });

  it('enforces four-eyes approval: requester and owner cannot approve', async () => {
    // priya is a lead who files the request herself
    const item = await s.createItem('priya', { requiresApproval: true });
    const sub = await s.api('priya').post(`/api/items/${item.id}/transitions`, { action: 'submit_for_approval', expectedVersion: item.version });
    const self = await s.api('priya').post(`/api/items/${item.id}/transitions`, { action: 'approve', expectedVersion: sub.body.version });
    expect(self.status).toBe(403);
    const member = await s.api('rahul').post(`/api/items/${item.id}/transitions`, { action: 'approve', expectedVersion: sub.body.version });
    expect(member.status).toBe(403);
    const otherLead = await s.api('lena').post(`/api/items/${item.id}/transitions`, { action: 'approve', expectedVersion: sub.body.version });
    expect(otherLead.status).toBe(200);
    expect(otherLead.body.approvedBy.id).toBe(s.users.lena.id);
  });

  it('members cannot silently remove an approval requirement; leads can', async () => {
    const item = await s.createItem('rahul', { requiresApproval: true });
    const member = await s.api('rahul').patch(`/api/items/${item.id}`, { expectedVersion: item.version, requiresApproval: false });
    expect(member.status).toBe(403);
    const lead = await s.api('priya').patch(`/api/items/${item.id}`, { expectedVersion: item.version, requiresApproval: false });
    expect(lead.status).toBe(200);
  });

  it('allowedActions shown to the UI always agrees with what the server enforces', () => {
    const users = Object.values(s.users).map((u) => loadUser(s.db, u.id)!);
    const actions: Action[] = ['view', 'comment', 'edit', 'claim', 'release', 'assign', 'waive_approval', ...TRANSITION_ACTIONS];
    const ids = [null, s.users.rahul.id, s.users.priya.id];
    let checked = 0;
    for (const user of users)
      for (const status of STATUSES)
        for (const assignee_id of ids)
          for (const reporter_id of [s.users.rahul.id, s.users.priya.id])
            for (const requires_approval of [0, 1])
              for (const approved_by of [null, s.users.lena.id]) {
                const item: PolicyItem = { team_id: s.teams.PAY, status, assignee_id, reporter_id, requires_approval, approved_by };
                const shown = allowedActions(user, item);
                for (const a of shown) expect(decide(user, item, a).ok).toBe(true);
                for (const a of actions) {
                  if (decide(user, item, a).ok && !shown.includes(a)) {
                    // Only these are intentionally hidden even though harmless/allowed.
                    expect(['view', 'claim', 'waive_approval']).toContain(a);
                  }
                }
                checked++;
              }
    expect(checked).toBeGreaterThan(1000);
  });
});
