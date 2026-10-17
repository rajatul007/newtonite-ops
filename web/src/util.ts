import { useCallback, useEffect, useState } from 'react';
import type { Status } from './api';

export const statusLabel: Record<Status, string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  pending_approval: 'Needs approval',
  resolved: 'Resolved',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export const actionLabel: Record<string, string> = {
  start: 'Start work',
  block: 'Mark blocked',
  submit_for_approval: 'Request approval',
  approve: 'Approve',
  reject: 'Reject',
  resolve: 'Resolve',
  close: 'Close',
  reopen: 'Reopen',
  cancel: 'Cancel item',
};

export function timeAgo(isoStr: string, now = Date.now()) {
  const s = Math.round((now - new Date(isoStr).getTime()) / 1000);
  const abs = Math.abs(s);
  const fmt = (n: number, u: string) => `${n}${u}`;
  const v = abs < 60 ? fmt(abs, 's') : abs < 3600 ? fmt(Math.floor(abs / 60), 'm') : abs < 86400 ? fmt(Math.floor(abs / 3600), 'h') : fmt(Math.floor(abs / 86400), 'd');
  return s >= 0 ? `${v} ago` : `in ${v}`;
}

export const fullDate = (isoStr: string) =>
  new Date(isoStr).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const isOverdue = (dueAt: string | null, status: Status) =>
  !!dueAt && new Date(dueAt).getTime() < Date.now() && ['open', 'in_progress', 'blocked', 'pending_approval'].includes(status);

/** URL is the source of truth for navigation state, so views are linkable and survive reloads. */
export function useUrlState() {
  const [params, setParams] = useState(() => new URLSearchParams(location.search));
  useEffect(() => {
    const onPop = () => setParams(new URLSearchParams(location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const update = useCallback((changes: Record<string, string | null | undefined>, push = true) => {
    const next = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === undefined || v === '') next.delete(k);
      else next.set(k, v);
    }
    const url = `${location.pathname}${next.toString() ? `?${next}` : ''}`;
    if (push) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    setParams(next);
  }, []);
  return [params, update] as const;
}

export function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
