import type { Response } from 'express';

/**
 * In-process fan-out of change events to connected browsers (Server-Sent Events).
 *
 * Delivery is best-effort: the database is the source of truth, and clients refetch on reconnect.
 * With several API instances this would be replaced by Redis pub/sub or Postgres LISTEN/NOTIFY;
 * the publish() interface would stay the same.
 */
export type BusEvent =
  | { type: 'item.changed'; itemId: number; teamId: number; version: number; actorId: number | null; actorName?: string; eventType: string }
  | { type: 'notification'; userId: number; notificationId: number; message: string; itemId: number };

interface Subscriber {
  userId: number;
  isAdmin: boolean;
  teamIds: Set<number>;
  res: Response;
}

export class Bus {
  private subs = new Set<Subscriber>();
  private listeners = new Set<(e: BusEvent) => void>();

  subscribe(sub: Subscriber) {
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  /** For tests and in-process consumers. */
  onEvent(fn: (e: BusEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(event: BusEvent) {
    for (const fn of this.listeners) fn(event);
    for (const s of this.subs) {
      const visible =
        event.type === 'item.changed' ? s.isAdmin || s.teamIds.has(event.teamId) : s.userId === event.userId;
      if (!visible) continue;
      try {
        s.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        this.subs.delete(s);
      }
    }
  }

  get size() {
    return this.subs.size;
  }
}
