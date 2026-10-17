import type { DB, Clock } from './db';
import { iso } from './db';
import type { Bus } from './bus';
import type { JobHandler } from './jobs';

interface EventInfo {
  id: number;
  work_item_id: number;
  type: string;
  data: string;
  actor_name: string | null;
  team_key: string;
  title: string;
}

export function describeEvent(e: EventInfo): string {
  const who = e.actor_name ?? 'System';
  const key = `${e.team_key}-${e.work_item_id}`;
  const d = JSON.parse(e.data);
  switch (e.type) {
    case 'created':
      return `${who} opened ${key} (P${d.priority}): ${e.title}`;
    case 'claimed':
      return `${who} took ownership of ${key}`;
    case 'released':
      return `${who} released ${key}; it has no owner now`;
    case 'assigned':
      return d.to ? `${who} assigned ${key} to ${d.to.name}` : `${who} unassigned ${key}`;
    case 'comment':
      return `${who} commented on ${key}: ${String(d.body).slice(0, 80)}`;
    case 'updated':
      return `${who} updated ${Object.keys(d.changes ?? {}).join(', ')} on ${key}${d.approvalInvalidated ? ' (approval voided)' : ''}`;
    case 'status_changed':
      if (d.action === 'submit_for_approval') return `${who} requested approval for ${key}`;
      if (d.action === 'approve') return `${who} approved ${key}; work can start`;
      if (d.action === 'reject') return `${who} rejected the request on ${key}: ${String(d.note ?? '').slice(0, 80)}`;
      return `${who} moved ${key} from ${d.from.replace(/_/g, ' ')} to ${d.to.replace(/_/g, ' ')}`;
    default:
      return `${who} changed ${key}`;
  }
}

/**
 * Notification fan-out job. Idempotent: UNIQUE(user_id, event_id) + INSERT OR IGNORE means running
 * it twice (crash after insert, lease expiry, duplicate delivery) cannot create duplicate notifications,
 * and a retry after a partial failure only fills in the missing rows.
 */
export function notifyHandler(db: DB, clock: Clock, bus?: Bus, failureRate = Number(process.env.NOTIFY_FAILURE_RATE ?? 0)): JobHandler {
  return (payload: { eventId: number; recipients: number[] }) => {
    // Optional fault injection to demonstrate retries/backoff in the demo.
    if (failureRate > 0 && Math.random() < failureRate) throw new Error('Simulated notification provider outage');

    const e = db
      .prepare(
        `SELECT e.id, e.work_item_id, e.type, e.data, u.name AS actor_name, t.key AS team_key, w.title
         FROM item_events e
         JOIN work_items w ON w.id = e.work_item_id
         JOIN teams t ON t.id = w.team_id
         LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.id = ?`,
      )
      .get(payload.eventId) as EventInfo | undefined;
    if (!e) return; // event can't disappear (append-only), but be defensive: nothing to do.

    const message = describeEvent(e);
    const insert = db.prepare(
      `INSERT INTO notifications (user_id, work_item_id, event_id, message, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, event_id) DO NOTHING RETURNING id`,
    );
    const created: { userId: number; id: number }[] = [];
    db.transaction(() => {
      for (const userId of payload.recipients) {
        const row = insert.get(userId, e.work_item_id, e.id, message, iso(clock.now())) as { id: number } | undefined;
        if (row) created.push({ userId, id: row.id });
      }
    })();
    for (const c of created) {
      bus?.publish({ type: 'notification', userId: c.userId, notificationId: c.id, message, itemId: e.work_item_id });
    }
  };
}

/** Housekeeping: expire idempotency keys and sessions, trim finished jobs. Safe to run any number of times. */
export function cleanupHandler(db: DB, clock: Clock): JobHandler {
  return () => {
    const now = clock.now().getTime();
    db.prepare(`DELETE FROM idempotency_keys WHERE created_at < ?`).run(iso(new Date(now - 24 * 3600_000)));
    db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(iso(new Date(now)));
    db.prepare(`DELETE FROM jobs WHERE status = 'done' AND updated_at < ?`).run(iso(new Date(now - 7 * 24 * 3600_000)));
  };
}
