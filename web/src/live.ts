import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from './toast';

/**
 * Live updates over Server-Sent Events.
 *
 * Events are hints, not data: they tell us *what* changed, and we refetch it from the API.
 * That keeps authorization in one place (the REST endpoints) and means a missed event only
 * costs freshness, never correctness. After any reconnect we refetch everything we have,
 * because events sent while we were disconnected are gone.
 */

// Tiny external store: which items changed recently and by whom (for row highlights / banners).
type Recent = Map<number, { by: string; at: number; version: number }>;
let recent: Recent = new Map();
const subs = new Set<() => void>();
function markRecent(itemId: number, by: string, version: number) {
  recent = new Map(recent).set(itemId, { by, at: Date.now(), version });
  subs.forEach((f) => f());
  setTimeout(() => {
    const r = recent.get(itemId);
    if (r && Date.now() - r.at >= 7900) {
      recent = new Map(recent);
      recent.delete(itemId);
      subs.forEach((f) => f());
    }
  }, 8000);
}
export function useRecentChange(itemId: number) {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => recent.get(itemId),
  );
}

let connectionState: 'connecting' | 'live' | 'offline' = 'connecting';
const connSubs = new Set<() => void>();
const setConn = (s: typeof connectionState) => {
  connectionState = s;
  connSubs.forEach((f) => f());
};
export const useConnectionState = () =>
  useSyncExternalStore((f) => (connSubs.add(f), () => connSubs.delete(f)), () => connectionState);

export function useLiveUpdates(meId: number | undefined) {
  const qc = useQueryClient();
  const toast = useToast();

  useEffect(() => {
    if (!meId) return;
    let listTimer: ReturnType<typeof setTimeout> | undefined;
    let hadConnection = false;
    const es = new EventSource('/api/stream');

    // Coalesce bursts (e.g. 30 updates in a second) into one list refresh.
    const refreshLists = () => {
      clearTimeout(listTimer);
      listTimer = setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['items'], refetchType: 'active' });
        qc.invalidateQueries({ queryKey: ['dashboard'], refetchType: 'active' });
      }, 800);
    };

    es.addEventListener('ready', () => {
      if (hadConnection) qc.invalidateQueries(); // resync after a gap
      hadConnection = true;
      setConn('live');
    });
    es.addEventListener('item.changed', (msg) => {
      const e = JSON.parse((msg as MessageEvent).data);
      if (e.actorId !== meId) {
        markRecent(e.itemId, e.actorName ?? 'Someone', e.version);
        qc.invalidateQueries({ queryKey: ['item', e.itemId] });
      }
      qc.invalidateQueries({ queryKey: ['events', e.itemId] });
      refreshLists();
    });
    es.addEventListener('notification', (msg) => {
      const e = JSON.parse((msg as MessageEvent).data);
      qc.invalidateQueries({ queryKey: ['notifications'] });
      toast(e.message, 'info');
    });
    es.onerror = () => setConn('offline'); // browser reconnects automatically

    // Fallback for when the push channel is unavailable (e.g. worker running in another process).
    const poll = setInterval(() => qc.invalidateQueries({ queryKey: ['notifications'] }), 30_000);
    return () => {
      es.close();
      clearInterval(poll);
      clearTimeout(listTimer);
    };
  }, [meId, qc, toast]);
}
