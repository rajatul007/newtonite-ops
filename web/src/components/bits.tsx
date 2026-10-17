import type { Item, Status } from '../api';
import { statusLabel, isOverdue, timeAgo, fullDate } from '../util';
import { useEffect, useRef, type ReactNode } from 'react';

export const Priority = ({ p }: { p: number }) => (
  <span className={`prio prio-${p}`} title={`Priority ${p}${p === 1 ? ' (critical)' : ''}`}>P{p}</span>
);

export const StatusPill = ({ s }: { s: Status }) => <span className={`pill pill-${s}`}>{statusLabel[s]}</span>;

export const Avatar = ({ name, size = 22 }: { name: string; size?: number }) => {
  const initials = name.split(' ').map((p) => p[0]).slice(0, 2).join('');
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ width: size, height: size, background: `hsl(${h} 45% 42%)`, fontSize: size * 0.42 }} title={name}>
      {initials}
    </span>
  );
};

export const Owner = ({ item }: { item: Item }) =>
  item.assignee ? (
    <span className="owner"><Avatar name={item.assignee.name} />{item.assignee.name}</span>
  ) : (
    <span className="owner unowned">Unowned</span>
  );

export const Due = ({ item }: { item: Item }) => {
  if (!item.dueAt) return <span className="due muted">—</span>;
  const late = isOverdue(item.dueAt, item.status);
  return <span className={late ? 'due late' : 'due'} title={fullDate(item.dueAt)}>{late ? 'Overdue ' : 'Due '}{timeAgo(item.dueAt)}</span>;
};

export const Time = ({ iso }: { iso: string }) => <time dateTime={iso} title={fullDate(iso)}>{timeAgo(iso)}</time>;

export function Modal({ title, children, onClose, width = 520 }: { title: string; children: ReactNode; onClose: () => void; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: width }} ref={ref}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export const Spinner = () => <span className="spinner" aria-label="Loading" />;
