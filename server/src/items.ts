/**
 * Work-item commands and queries.
 *
 * Every command runs inside a single SQLite write transaction opened by the route layer
 * (see http.ts `command`). Within it we:
 *   1. load the item and enforce visibility (404 if the caller cannot see it),
 *   2. check the caller's expected version (409 VERSION_CONFLICT on stale writes),
 *   3. evaluate the workflow/authorization policy,
 *   4. apply the change with a compare-and-swap UPDATE (`WHERE version = ?` or a semantic guard),
 *   5. append an immutable event and enqueue follow-up jobs (outbox) in the same transaction.
 * Live-update broadcasts are queued in ctx.afterCommit so nobody hears about a change that rolled back.
 */
import type { Ctx } from './context';
import { iso } from './db';
import { HttpError, badRequest, conflict, forbidden, notFound } from './errors';
import {
  ACTIVE_STATUSES,
  TRANSITIONS,
  allowedActions,
  canView,
  decide,
  hasRole,
  type Action,
  type Status,
  type TransitionAction,
} from './policy';
import { enqueue } from './jobs';

export interface ItemRow {
  id: number;
  team_id: number;
  title: string;
  description?: string;
  kind: string;
  priority: number;
  status: Status;
  assignee_id: number | null;
  reporter_id: number;
  requires_approval: number;
  approved_by: number | null;
  approved_at: string | null;
  due_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  resolved_at: string | null;
  team_key: string;
  team_name: string;
  assignee_name: string | null;
  reporter_name: string;
  approver_name: string | null;
}

const ITEM_FROM = `
  FROM work_items w
  JOIN teams t ON t.id = w.team_id
  JOIN users r ON r.id = w.reporter_id
  LEFT JOIN users a ON a.id = w.assignee_id
  LEFT JOIN users ap ON ap.id = w.approved_by`;
const NAMES = `t.key AS team_key, t.name AS team_name, a.name AS assignee_name, r.name AS reporter_name, ap.name AS approver_name`;
const LIST_COLUMNS = `w.id, w.team_id, w.title, w.kind, w.priority, w.status, w.assignee_id, w.reporter_id,
  w.requires_approval, w.approved_by, w.approved_at, w.due_at, w.version, w.created_at, w.updated_at,
  w.last_activity_at, w.resolved_at, ${NAMES}`;

export function toDto(row: ItemRow, ctx?: Ctx) {
  return {
    id: row.id,
    key: `${row.team_key}-${row.id}`,
    team: { id: row.team_id, key: row.team_key, name: row.team_name },
    title: row.title,
    ...(row.description !== undefined ? { description: row.description } : {}),
    kind: row.kind,
    priority: row.priority,
    status: row.status,
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name } : null,
    reporter: { id: row.reporter_id, name: row.reporter_name },
    requiresApproval: !!row.requires_approval,
    approvedBy: row.approved_by ? { id: row.approved_by, name: row.approver_name } : null,
    approvedAt: row.approved_at,
    dueAt: row.due_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    resolvedAt: row.resolved_at,
    ...(ctx ? { allowedActions: allowedActions(ctx.user, row) } : {}),
  };
}
export type ItemDto = ReturnType<typeof toDto>;

function loadRow(ctx: Ctx, id: number): ItemRow | undefined {
  return ctx.db.prepare(`SELECT w.*, ${NAMES} ${ITEM_FROM} WHERE w.id = ?`).get(id) as ItemRow | undefined;
}

/** Load an item the caller is allowed to see; 404 otherwise (never 403, to avoid leaking existence). */
function loadVisible(ctx: Ctx, id: number): ItemRow {
  const row = loadRow(ctx, id);
  if (!row || !canView(ctx.user, row.team_id)) throw notFound('Work item');
  return row;
}

export function getItem(ctx: Ctx, id: number) {
  return toDto(loadVisible(ctx, id), ctx);
}

function enforce(ctx: Ctx, row: ItemRow, action: Action) {
  const d = decide(ctx.user, row, action);
  if (d.ok) return;
  if (d.kind === 'FORBIDDEN') throw forbidden(d.reason);
  throw conflict('INVALID_TRANSITION', d.reason, { current: toDto(row, ctx) });
}

function checkVersion(ctx: Ctx, row: ItemRow, expectedVersion: number) {
  if (row.version !== expectedVersion) {
    throw conflict(
      'VERSION_CONFLICT',
      'This item was changed by someone else since you loaded it',
      { current: toDto(row, ctx), expectedVersion },
    );
  }
}

const WRITABLE_COLUMNS = new Set([
  'title', 'description', 'kind', 'priority', 'status', 'assignee_id', 'requires_approval',
  'approved_by', 'approved_at', 'due_at', 'resolved_at',
]);

/**
 * Compare-and-swap update. `guard` is an extra SQL predicate (e.g. "version = @expected" or
 * "assignee_id IS NULL"). Returns false if another writer got there first.
 */
function casUpdate(ctx: Ctx, id: number, sets: Record<string, unknown>, guard: string, guardParams: Record<string, unknown>) {
  const cols = Object.keys(sets);
  for (const c of cols) if (!WRITABLE_COLUMNS.has(c)) throw new Error(`Refusing to write column ${c}`);
  const now = iso(ctx.clock.now());
  const assignments = cols.map((c) => `${c} = @set_${c}`).join(', ');
  const params: Record<string, unknown> = { __id: id, __now: now, ...guardParams };
  for (const c of cols) params[`set_${c}`] = sets[c];
  const res = ctx.db
    .prepare(
      `UPDATE work_items SET ${assignments}${cols.length ? ',' : ''} version = version + 1, updated_at = @__now, last_activity_at = @__now
       WHERE id = @__id AND (${guard})`,
    )
    .run(params);
  return res.changes === 1;
}

function teamLeads(ctx: Ctx, teamId: number): number[] {
  return (
    ctx.db.prepare(`SELECT user_id FROM memberships WHERE team_id = ? AND role = 'lead'`).all(teamId) as { user_id: number }[]
  ).map((r) => r.user_id);
}

/**
 * Append an immutable history event, enqueue its notification job (outbox) and schedule the
 * live-update broadcast for after commit. Recipients are computed now, from the state at event time,
 * so a delayed or retried job notifies exactly the same people.
 */
function recordEvent(ctx: Ctx, after: ItemRow, type: string, data: Record<string, unknown>, extraRecipients: number[] = []) {
  const now = iso(ctx.clock.now());
  const { lastInsertRowid } = ctx.db
    .prepare(`INSERT INTO item_events (work_item_id, actor_id, type, data, item_version, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(after.id, ctx.user.id, type, JSON.stringify(data), after.version, now);
  const eventId = Number(lastInsertRowid);

  const recipients = new Set<number>([after.reporter_id, ...extraRecipients]);
  if (after.assignee_id) recipients.add(after.assignee_id);
  recipients.delete(ctx.user.id);
  if (recipients.size) {
    enqueue(ctx.db, ctx.clock, 'notify', { eventId, recipients: [...recipients] }, { dedupeKey: `notify:${eventId}` });
  }

  const actorName = ctx.user.name;
  ctx.afterCommit.push(() =>
    ctx.bus.publish({
      type: 'item.changed',
      itemId: after.id,
      teamId: after.team_id,
      version: after.version,
      actorId: ctx.user.id,
      actorName,
      eventType: type,
    }),
  );
  return eventId;
}

function requireAssignable(ctx: Ctx, teamId: number, userId: number) {
  const m = ctx.db.prepare(`SELECT role FROM memberships WHERE team_id = ? AND user_id = ?`).get(teamId, userId) as
    | { role: string }
    | undefined;
  if (!m || m.role === 'viewer') throw badRequest('Work can only be assigned to members or leads of the item’s team');
}

// ---------------------------------------------------------------- commands

export interface CreateInput {
  teamId: number;
  title: string;
  description: string;
  kind: string;
  priority: number;
  requiresApproval: boolean;
  dueAt: string | null;
  assigneeId: number | null;
}

export function createItem(ctx: Ctx, input: CreateInput) {
  if (!canView(ctx.user, input.teamId)) throw notFound('Team');
  if (!hasRole(ctx.user, input.teamId, 'member')) throw forbidden('Viewers cannot create work items');
  if (input.assigneeId !== null) {
    if (input.assigneeId !== ctx.user.id && !hasRole(ctx.user, input.teamId, 'lead')) {
      throw forbidden('Only a team lead can assign work to someone else');
    }
    requireAssignable(ctx, input.teamId, input.assigneeId);
  }
  const now = iso(ctx.clock.now());
  const { lastInsertRowid } = ctx.db
    .prepare(
      `INSERT INTO work_items (team_id, title, description, kind, priority, status, assignee_id, reporter_id,
         requires_approval, due_at, version, created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(input.teamId, input.title, input.description, input.kind, input.priority, input.assigneeId, ctx.user.id,
      input.requiresApproval ? 1 : 0, input.dueAt, now, now, now);
  const row = loadRow(ctx, Number(lastInsertRowid))!;
  // A new P1 pages the team leads.
  const extra = input.priority === 1 ? teamLeads(ctx, input.teamId) : [];
  recordEvent(ctx, row, 'created', { title: row.title, priority: row.priority, kind: row.kind, assignee: row.assignee_name }, extra);
  return toDto(row, ctx);
}

export interface UpdateInput {
  title?: string;
  description?: string;
  kind?: string;
  priority?: number;
  dueAt?: string | null;
  requiresApproval?: boolean;
}
const FIELD_COLUMNS: Record<keyof UpdateInput, string> = {
  title: 'title',
  description: 'description',
  kind: 'kind',
  priority: 'priority',
  dueAt: 'due_at',
  requiresApproval: 'requires_approval',
};

export function updateItem(ctx: Ctx, id: number, expectedVersion: number, patch: UpdateInput) {
  const row = loadVisible(ctx, id);
  checkVersion(ctx, row, expectedVersion);
  enforce(ctx, row, 'edit');

  const sets: Record<string, unknown> = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, column] of Object.entries(FIELD_COLUMNS) as [keyof UpdateInput, string][]) {
    if (patch[field] === undefined) continue;
    let next: unknown = patch[field];
    if (field === 'requiresApproval') next = next ? 1 : 0;
    const prev = (row as any)[column];
    if (prev === next) continue;
    sets[column] = next;
    changes[field] = { from: field === 'requiresApproval' ? !!prev : prev, to: field === 'requiresApproval' ? !!next : next };
  }
  if (!Object.keys(sets).length) return toDto(row, ctx); // no-op: don't bump the version

  if (sets.requires_approval === 0 && row.requires_approval) enforce(ctx, row, 'waive_approval');

  // An approval covers the request as it was approved. Changing its substance before work starts
  // voids the approval, so nobody can get "fix the typo" approved and then swap in "refund $50k".
  let approvalInvalidated = false;
  if (row.approved_by && row.status === 'open' && ('title' in sets || 'description' in sets)) {
    sets.approved_by = null;
    sets.approved_at = null;
    approvalInvalidated = true;
  }

  if (!casUpdate(ctx, id, sets, 'version = @expected', { expected: expectedVersion })) {
    checkVersion(ctx, loadRow(ctx, id)!, expectedVersion); // another process won the race
  }
  const after = loadRow(ctx, id)!;
  recordEvent(ctx, after, 'updated', { changes, ...(approvalInvalidated ? { approvalInvalidated: true } : {}) });
  return toDto(after, ctx);
}

/**
 * Claim is intent-based, not version-based: "make me the owner if nobody owns it".
 * It must not fail just because someone added a comment or fixed a typo, but it MUST fail if
 * someone else claimed it first — hence the semantic guard `assignee_id IS NULL`.
 * Claiming an item you already own succeeds as a no-op, so retries are safe.
 */
export function claimItem(ctx: Ctx, id: number) {
  const row = loadVisible(ctx, id);
  if (row.assignee_id === ctx.user.id) return { item: toDto(row, ctx), changed: false };
  if (row.assignee_id !== null) {
    throw conflict('ALREADY_CLAIMED', `${row.assignee_name} already owns this item`, { current: toDto(row, ctx) });
  }
  enforce(ctx, row, 'claim');
  const ok = casUpdate(ctx, id, { assignee_id: ctx.user.id }, `assignee_id IS NULL AND status NOT IN ('resolved','closed','cancelled')`, {});
  if (!ok) {
    const now = loadRow(ctx, id)!;
    throw conflict('ALREADY_CLAIMED', `${now.assignee_name ?? 'Someone'} already owns this item`, { current: toDto(now, ctx) });
  }
  const after = loadRow(ctx, id)!;
  recordEvent(ctx, after, 'claimed', { to: { id: ctx.user.id, name: ctx.user.name } });
  return { item: toDto(after, ctx), changed: true };
}

/** Give up ownership. Guarded on the current owner, so a stale "release" can't unassign a new owner. */
export function releaseItem(ctx: Ctx, id: number, expectedAssigneeId: number) {
  const row = loadVisible(ctx, id);
  enforce(ctx, row, 'release');
  if (row.assignee_id !== expectedAssigneeId) {
    throw conflict('VERSION_CONFLICT', 'Ownership changed since you loaded this item', { current: toDto(row, ctx) });
  }
  const sets: Record<string, unknown> = { assignee_id: null };
  if (row.status === 'in_progress' || row.status === 'blocked') sets.status = 'open';
  if (!casUpdate(ctx, id, sets, 'assignee_id = @owner', { owner: expectedAssigneeId })) {
    throw conflict('VERSION_CONFLICT', 'Ownership changed since you loaded this item', { current: toDto(loadRow(ctx, id)!, ctx) });
  }
  const after = loadRow(ctx, id)!;
  recordEvent(ctx, after, 'released', { from: { id: row.assignee_id, name: row.assignee_name }, statusFrom: row.status, statusTo: after.status }, [row.assignee_id!]);
  return toDto(after, ctx);
}

export function assignItem(ctx: Ctx, id: number, expectedVersion: number, assigneeId: number | null) {
  const row = loadVisible(ctx, id);
  checkVersion(ctx, row, expectedVersion);
  enforce(ctx, row, 'assign');
  if (assigneeId === row.assignee_id) return toDto(row, ctx);
  if (assigneeId !== null) requireAssignable(ctx, row.team_id, assigneeId);
  const sets: Record<string, unknown> = { assignee_id: assigneeId };
  if (assigneeId === null && (row.status === 'in_progress' || row.status === 'blocked')) sets.status = 'open';
  if (!casUpdate(ctx, id, sets, 'version = @expected', { expected: expectedVersion })) {
    checkVersion(ctx, loadRow(ctx, id)!, expectedVersion);
  }
  const after = loadRow(ctx, id)!;
  recordEvent(
    ctx,
    after,
    'assigned',
    {
      from: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name } : null,
      to: after.assignee_id ? { id: after.assignee_id, name: after.assignee_name } : null,
    },
    row.assignee_id ? [row.assignee_id] : [],
  );
  return toDto(after, ctx);
}

export function transitionItem(ctx: Ctx, id: number, expectedVersion: number, action: TransitionAction, note: string | undefined) {
  const row = loadVisible(ctx, id);
  checkVersion(ctx, row, expectedVersion);
  enforce(ctx, row, action);
  const t = TRANSITIONS[action];
  if (t.noteRequired && !note?.trim()) throw badRequest(`A note is required to ${action.replace(/_/g, ' ')}`);

  const now = iso(ctx.clock.now());
  const sets: Record<string, unknown> = { status: t.to };
  if (action === 'approve') Object.assign(sets, { approved_by: ctx.user.id, approved_at: now });
  if (action === 'reject') Object.assign(sets, { approved_by: null, approved_at: null });
  if (action === 'resolve') sets.resolved_at = now;
  if (action === 'reopen') Object.assign(sets, { resolved_at: null, approved_by: null, approved_at: null });

  if (!casUpdate(ctx, id, sets, 'version = @expected', { expected: expectedVersion })) {
    checkVersion(ctx, loadRow(ctx, id)!, expectedVersion);
  }
  const after = loadRow(ctx, id)!;
  const extra = action === 'submit_for_approval' ? teamLeads(ctx, row.team_id) : [];
  recordEvent(ctx, after, 'status_changed', { action, from: row.status, to: after.status, note: note?.trim() || undefined }, extra);
  return toDto(after, ctx);
}

/**
 * Comments are append-only and never conflict with each other, so they don't require or bump the
 * item version (otherwise every comment would turn someone's in-progress edit into a conflict).
 */
export function addComment(ctx: Ctx, id: number, body: string) {
  const row = loadVisible(ctx, id);
  enforce(ctx, row, 'comment');
  ctx.db.prepare(`UPDATE work_items SET last_activity_at = ? WHERE id = ?`).run(iso(ctx.clock.now()), id);
  const eventId = recordEvent(ctx, row, 'comment', { body });
  return getEvent(ctx, eventId);
}

// ---------------------------------------------------------------- queries

interface EventRow {
  id: number;
  work_item_id: number;
  actor_id: number | null;
  actor_name: string | null;
  type: string;
  data: string;
  item_version: number;
  created_at: string;
}
const eventDto = (e: EventRow) => ({
  id: e.id,
  itemId: e.work_item_id,
  actor: e.actor_id ? { id: e.actor_id, name: e.actor_name } : null,
  type: e.type,
  data: JSON.parse(e.data),
  itemVersion: e.item_version,
  createdAt: e.created_at,
});

function getEvent(ctx: Ctx, eventId: number) {
  const e = ctx.db
    .prepare(`SELECT e.*, u.name AS actor_name FROM item_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.id = ?`)
    .get(eventId) as EventRow;
  return eventDto(e);
}

export function listEvents(ctx: Ctx, itemId: number, after = 0, limit = 200) {
  loadVisible(ctx, itemId);
  const rows = ctx.db
    .prepare(
      `SELECT e.*, u.name AS actor_name FROM item_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.work_item_id = ? AND e.id > ? ORDER BY e.id LIMIT ?`,
    )
    .all(itemId, after, limit + 1) as EventRow[];
  const page = rows.slice(0, limit).map(eventDto);
  return { events: page, nextAfter: rows.length > limit ? page[page.length - 1].id : null };
}

export type SortKey = 'activity' | 'priority' | 'created';
const SORTS: Record<SortKey, [string, 'ASC' | 'DESC'][]> = {
  activity: [['w.last_activity_at', 'DESC'], ['w.id', 'DESC']],
  priority: [['w.priority', 'ASC'], ['w.last_activity_at', 'DESC'], ['w.id', 'DESC']],
  created: [['w.id', 'DESC']],
};

export interface ListFilters {
  teamId?: number;
  status?: Status[];
  priority?: number[];
  kind?: string[];
  assignee?: 'me' | 'none' | number;
  reporter?: 'me';
  q?: string;
  overdue?: boolean;
  stale?: boolean;
  needsMyApproval?: boolean;
  sort?: SortKey;
  cursor?: string;
  limit?: number;
}

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function buildWhere(ctx: Ctx, f: ListFilters) {
  const where: string[] = [];
  const params: unknown[] = [];
  const me = ctx.user.id;
  const now = ctx.clock.now();

  if (!ctx.user.isAdmin) {
    where.push('w.team_id IN (SELECT team_id FROM memberships WHERE user_id = ?)');
    params.push(me);
  }
  if (f.teamId) { where.push('w.team_id = ?'); params.push(f.teamId); }
  const inList = (col: string, vals: unknown[]) => {
    where.push(`${col} IN (${vals.map(() => '?').join(',')})`);
    params.push(...vals);
  };
  if (f.status?.length) inList('w.status', f.status);
  if (f.priority?.length) inList('w.priority', f.priority);
  if (f.kind?.length) inList('w.kind', f.kind);
  if (f.assignee === 'me') { where.push('w.assignee_id = ?'); params.push(me); }
  else if (f.assignee === 'none') where.push('w.assignee_id IS NULL');
  else if (typeof f.assignee === 'number') { where.push('w.assignee_id = ?'); params.push(f.assignee); }
  if (f.reporter === 'me') { where.push('w.reporter_id = ?'); params.push(me); }
  if (f.overdue) {
    where.push('w.due_at IS NOT NULL AND w.due_at < ?');
    params.push(iso(now));
    if (!f.status?.length) inList('w.status', ACTIVE_STATUSES);
  }
  if (f.stale) {
    where.push('w.priority <= 2 AND w.last_activity_at < ?');
    params.push(iso(new Date(now.getTime() - STALE_AFTER_MS)));
    if (!f.status?.length) inList('w.status', ACTIVE_STATUSES);
  }
  if (f.needsMyApproval) {
    where.push(`w.status = 'pending_approval' AND w.reporter_id != ? AND (w.assignee_id IS NULL OR w.assignee_id != ?)`);
    params.push(me, me);
    if (!ctx.user.isAdmin) {
      where.push(`w.team_id IN (SELECT team_id FROM memberships WHERE user_id = ? AND role = 'lead')`);
      params.push(me);
    }
  }
  const q = f.q?.trim();
  if (q) {
    const key = /^([A-Za-z]+)-(\d+)$/.exec(q);
    if (key) {
      where.push('w.id = ?');
      params.push(Number(key[2]));
    } else {
      // Each word becomes a quoted prefix term, so user input can never be interpreted as FTS syntax.
      const terms = q.split(/\s+/).filter(Boolean).slice(0, 8).map((t) => `"${t.replace(/"/g, '""')}"*`);
      where.push('w.id IN (SELECT rowid FROM work_items_fts WHERE work_items_fts MATCH ?)');
      params.push(terms.join(' '));
    }
  }
  return { where, params };
}

const encodeCursor = (vals: unknown[]) => Buffer.from(JSON.stringify(vals)).toString('base64url');
function decodeCursor(c: string, n: number): unknown[] {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString());
    if (Array.isArray(v) && v.length === n) return v;
  } catch { /* fallthrough */ }
  throw badRequest('Invalid cursor');
}

/**
 * Keyset ("seek") pagination: stable under concurrent inserts and O(page) regardless of depth,
 * unlike OFFSET which gets slower and skips/duplicates rows as the list changes.
 */
export function listItems(ctx: Ctx, f: ListFilters) {
  const sort = SORTS[f.sort ?? 'activity'];
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
  const { where, params } = buildWhere(ctx, f);

  if (f.cursor) {
    const vals = decodeCursor(f.cursor, sort.length);
    const ors: string[] = [];
    for (let i = 0; i < sort.length; i++) {
      const eqs = sort.slice(0, i).map(([c]) => `${c} = ?`);
      const [col, dir] = sort[i];
      ors.push(`(${[...eqs, `${col} ${dir === 'DESC' ? '<' : '>'} ?`].join(' AND ')})`);
      params.push(...vals.slice(0, i + 1));
    }
    where.push(`(${ors.join(' OR ')})`);
  }

  const sql = `SELECT ${LIST_COLUMNS} ${ITEM_FROM}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${sort.map(([c, d]) => `${c} ${d}`).join(', ')}
    LIMIT ?`;
  const rows = ctx.db.prepare(sql).all(...params, limit + 1) as ItemRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor(sort.map(([c]) => (last as any)[c.replace('w.', '')]))
      : null;
  return { items: page.map((r) => toDto(r)), nextCursor };
}

export function countItems(ctx: Ctx, f: ListFilters): number {
  const { where, params } = buildWhere(ctx, f);
  return (
    ctx.db.prepare(`SELECT COUNT(*) AS n FROM work_items w ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...params) as {
      n: number;
    }
  ).n;
}

/** "What needs my attention?" — each section is a saved query the list view can open in full. */
export function dashboard(ctx: Ctx, teamId?: number) {
  const base = { teamId };
  const sections: { id: string; title: string; hint: string; filters: ListFilters }[] = [
    { id: 'mine', title: 'Assigned to me', hint: 'Active work you own', filters: { ...base, assignee: 'me', status: ACTIVE_STATUSES, sort: 'priority' } },
    { id: 'approvals', title: 'Awaiting my approval', hint: 'Requests where you are the approving lead', filters: { ...base, needsMyApproval: true, sort: 'priority' } },
    { id: 'unowned', title: 'Urgent & unowned', hint: 'P1/P2 work nobody has claimed', filters: { ...base, assignee: 'none', priority: [1, 2], status: ['open', 'blocked', 'pending_approval'], sort: 'priority' } },
    { id: 'overdue', title: 'Overdue', hint: 'Past due date and still active', filters: { ...base, overdue: true, sort: 'priority' } },
    { id: 'stale', title: 'Going stale', hint: 'P1/P2 with no activity for 24h', filters: { ...base, stale: true, sort: 'priority' } },
  ];
  const statusCounts = ctx.db
    .prepare(
      `SELECT w.status, COUNT(*) AS n FROM work_items w
       WHERE ${ctx.user.isAdmin ? '1=1' : 'w.team_id IN (SELECT team_id FROM memberships WHERE user_id = @me)'}
       ${teamId ? 'AND w.team_id = @team' : ''}
       GROUP BY w.status`,
    )
    .all({ me: ctx.user.id, ...(teamId ? { team: teamId } : {}) }) as { status: string; n: number }[];
  return {
    statusCounts: Object.fromEntries(statusCounts.map((r) => [r.status, r.n])),
    sections: sections.map((s) => ({
      id: s.id,
      title: s.title,
      hint: s.hint,
      filters: s.filters,
      count: countItems(ctx, s.filters),
      items: listItems(ctx, { ...s.filters, limit: 5 }).items,
    })),
  };
}

export { HttpError };
