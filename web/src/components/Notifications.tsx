import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Time } from './bits';

export function Notifications({ open }: { open: (itemId: number) => void }) {
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['notifications'], queryFn: api.notifications });

  useEffect(() => {
    if (!show) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setShow(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [show]);

  const toggle = async () => {
    const next = !show;
    setShow(next);
    const top = q.data?.notifications[0];
    if (next && top && q.data!.unread > 0) {
      await api.markRead(top.id); // idempotent server-side
      qc.invalidateQueries({ queryKey: ['notifications'] });
    }
  };

  const unread = q.data?.unread ?? 0;
  return (
    <div className="notif" ref={ref}>
      <button className="icon bell" onClick={toggle} aria-label={`Notifications (${unread} unread)`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10 21a2 2 0 0 0 4 0" /></svg>
        {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {show && (
        <div className="notif-panel">
          <div className="notif-head">Notifications</div>
          {!q.data?.notifications.length && <div className="muted small pad">Nothing yet. You’ll hear about work you report, own, or need to approve.</div>}
          {q.data?.notifications.map((n) => (
            <button key={n.id} className={`notif-item ${n.readAt ? '' : 'unread'}`} onClick={() => { setShow(false); open(n.itemId); }}>
              <div>{n.message}</div>
              <div className="muted small"><Time iso={n.createdAt} /></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
