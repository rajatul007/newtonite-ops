/**
 * Seeds demo teams/users and a configurable volume of work items with history.
 *   npm run seed                 -> 5,000 items
 *   ITEMS=30000 npm run seed     -> scale test (tens of thousands of items, ~4x events)
 * All demo users have password "password".
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { openDb, iso } from './db';
import { hashPassword } from './auth';

const file = process.env.DB_FILE ?? 'data/ops.db';
mkdirSync('data', { recursive: true });
for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) rmSync(f);
const db = openDb(file);

const ITEMS = Number(process.env.ITEMS ?? 5000);
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];

const teams = [
  { name: 'Payments', key: 'PAY' },
  { name: 'Customer Support', key: 'CS' },
  { name: 'Platform Engineering', key: 'ENG' },
  { name: 'Compliance', key: 'CMP' },
  { name: 'Operations', key: 'OPS' },
];

// [name, email, isAdmin, {teamKey: role}]
const users: [string, string, boolean, Record<string, 'viewer' | 'member' | 'lead'>][] = [
  ['Asha Admin', 'admin@newtonite.test', true, {}],
  ['Priya Lead', 'priya@newtonite.test', false, { PAY: 'lead', OPS: 'member' }],
  ['Rahul Member', 'rahul@newtonite.test', false, { PAY: 'member', ENG: 'member' }],
  ['Meera Member', 'meera@newtonite.test', false, { PAY: 'member', CS: 'member' }],
  ['Vikram Lead', 'vikram@newtonite.test', false, { ENG: 'lead', OPS: 'lead' }],
  ['Neha Member', 'neha@newtonite.test', false, { ENG: 'member', OPS: 'member' }],
  ['Kabir Lead', 'kabir@newtonite.test', false, { CS: 'lead', CMP: 'member' }],
  ['Sara Member', 'sara@newtonite.test', false, { CS: 'member' }],
  ['Dev Lead', 'dev@newtonite.test', false, { CMP: 'lead', PAY: 'viewer' }],
  ['Vera Viewer', 'vera@newtonite.test', false, { PAY: 'viewer', ENG: 'viewer', CS: 'viewer' }],
];

const titles: Record<string, string[]> = {
  PAY: ['Refund stuck in pending for merchant', 'Chargeback dispute needs evidence', 'Duplicate charge reported', 'Settlement mismatch with bank file', 'Payout delayed for vendor', 'Card authorisation failures spike'],
  CS: ['Customer cannot log in after reset', 'VIP account escalation', 'Invoice address change request', 'Complaint about delayed delivery', 'Bulk export of order history', 'Customer requests data deletion'],
  ENG: ['API latency above SLO', 'Database disk usage at 85%', 'Flaky deploy pipeline', 'Certificate expiring soon', 'Memory leak in worker service', 'Rotate leaked API key'],
  CMP: ['Quarterly access review', 'KYC document re-verification', 'Regulator information request', 'Vendor risk assessment', 'Data retention policy exception', 'Sanctions screening hit review'],
  OPS: ['Office network outage', 'Laptop procurement approval', 'Vendor contract renewal', 'On-call rota for holidays', 'Warehouse access badge request', 'Expense policy exception'],
};
const kindsByTeam: Record<string, string[]> = {
  PAY: ['payment', 'customer', 'incident'],
  CS: ['customer', 'task'],
  ENG: ['engineering', 'incident'],
  CMP: ['compliance', 'task'],
  OPS: ['task', 'incident'],
};
const words = ['urgent', 'merchant', 'eu', 'india', 'retry', 'timeout', 'ledger', 'webhook', 'escalated', 'audit', 'customer', 'region', 'invoice', 'batch'];

db.transaction(() => {
  const now = new Date().toISOString();
  const hash = hashPassword('password');
  const teamId: Record<string, number> = {};
  for (const t of teams) teamId[t.key] = Number(db.prepare('INSERT INTO teams (name, key) VALUES (?, ?)').run(t.name, t.key).lastInsertRowid);

  const members: Record<string, { id: number; role: string }[]> = Object.fromEntries(teams.map((t) => [t.key, []]));
  for (const [name, email, admin, roles] of users) {
    const uid = Number(db.prepare('INSERT INTO users (email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)').run(email, name, hash, admin ? 1 : 0, now).lastInsertRowid);
    for (const [key, role] of Object.entries(roles)) {
      db.prepare('INSERT INTO memberships (user_id, team_id, role) VALUES (?, ?, ?)').run(uid, teamId[key], role);
      members[key].push({ id: uid, role });
    }
  }

  const insItem = db.prepare(`INSERT INTO work_items (team_id, title, description, kind, priority, status, assignee_id, reporter_id,
    requires_approval, approved_by, approved_at, due_at, version, created_at, updated_at, last_activity_at, resolved_at)
    VALUES (@team_id, @title, @description, @kind, @priority, @status, @assignee_id, @reporter_id, @requires_approval, @approved_by,
    @approved_at, @due_at, @version, @created_at, @updated_at, @last_activity_at, @resolved_at)`);
  const insEvent = db.prepare(`INSERT INTO item_events (work_item_id, actor_id, type, data, item_version, created_at) VALUES (?, ?, ?, ?, ?, ?)`);

  const nowMs = Date.now();
  const statuses = ['open', 'open', 'in_progress', 'in_progress', 'blocked', 'pending_approval', 'resolved', 'closed', 'closed', 'closed', 'cancelled'];
  for (let i = 0; i < ITEMS; i++) {
    const team = pick(teams).key;
    const workers = members[team].filter((m) => m.role !== 'viewer');
    const leads = members[team].filter((m) => m.role === 'lead');
    const reporter = pick(workers);
    const created = nowMs - Math.floor(rand() * 120 * 24 * 3600_000);
    // Recent items are mostly active; old ones mostly finished.
    const ageDays = (nowMs - created) / 86400_000;
    let status = ageDays < 10 ? pick(statuses.slice(0, 7)) : pick(statuses);
    const requiresApproval = status === 'pending_approval' || rand() < 0.1;
    const priority = rand() < 0.07 ? 1 : rand() < 0.25 ? 2 : rand() < 0.6 ? 3 : 4;
    const needsOwner = ['in_progress', 'blocked', 'resolved', 'closed'].includes(status);
    const assignee = needsOwner || rand() < 0.5 ? pick(workers) : null;
    const approver = requiresApproval && status !== 'pending_approval' && status !== 'open' ? leads.find((l) => l.id !== reporter.id && l.id !== assignee?.id) : undefined;
    if (requiresApproval && !approver && ['in_progress', 'blocked', 'resolved', 'closed'].includes(status)) status = 'pending_approval';
    const lastActivity = Math.min(nowMs, created + Math.floor(rand() * Math.max(1, Math.min(ageDays, 20)) * 86400_000));
    const due = rand() < 0.4 ? iso(new Date(created + Math.floor((1 + rand() * 14) * 86400_000))) : null;
    const title = `${pick(titles[team])} — ${pick(words)} ${pick(words)} #${1000 + i}`;
    const events: [number | null, string, object][] = [[reporter.id, 'created', { title, priority }]];
    if (assignee) events.push([assignee.id, 'claimed', { to: { id: assignee.id } }]);
    if (status !== 'open') events.push([assignee?.id ?? reporter.id, 'status_changed', { action: 'start', from: 'open', to: status }]);
    if (rand() < 0.5) events.push([pick(workers).id, 'comment', { body: `Looked into this — ${pick(words)} ${pick(words)} seems related.` }]);

    const itemId = Number(
      insItem.run({
        team_id: teamId[team],
        title,
        description: `Reported by ${reporter.id}. Context: ${pick(words)}, ${pick(words)}, ${pick(words)}.`,
        kind: pick(kindsByTeam[team]),
        priority,
        status,
        assignee_id: needsOwner && !assignee ? workers[0].id : assignee?.id ?? null,
        reporter_id: reporter.id,
        requires_approval: requiresApproval ? 1 : 0,
        approved_by: approver?.id ?? null,
        approved_at: approver ? iso(new Date(created + 3600_000)) : null,
        due_at: due,
        version: events.length,
        created_at: iso(new Date(created)),
        updated_at: iso(new Date(lastActivity)),
        last_activity_at: iso(new Date(lastActivity)),
        resolved_at: ['resolved', 'closed'].includes(status) ? iso(new Date(lastActivity)) : null,
      }).lastInsertRowid,
    );
    events.forEach(([actor, type, data], idx) => {
      const t = created + ((lastActivity - created) * idx) / Math.max(1, events.length - 1);
      insEvent.run(itemId, actor, type, JSON.stringify(data), idx + 1, iso(new Date(t)));
    });
  }
})();

db.exec('ANALYZE');
const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
console.log(`Seeded ${n('SELECT COUNT(*) n FROM work_items')} items, ${n('SELECT COUNT(*) n FROM item_events')} events into ${file}`);
console.log('Log in as any of:', users.map((u) => u[1]).join(', '), '(password: "password")');
