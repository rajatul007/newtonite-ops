import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { statusLabel } from '../util';
import { Owner, Priority, Spinner, StatusPill, Due } from './bits';

export function Dashboard({ teamId, open, goView, canApprove }: { teamId?: number; open: (id: number) => void; goView: (view: string) => void; canApprove: boolean }) {
  const q = useQuery({ queryKey: ['dashboard', teamId ?? null], queryFn: () => api.dashboard(teamId), refetchInterval: 60_000 });
  if (q.isPending) return <div className="empty"><Spinner /></div>;
  if (q.isError) return <div className="empty error">Couldn’t load the overview. <button className="link" onClick={() => q.refetch()}>Retry</button></div>;
  const d = q.data;
  const active = ['open', 'in_progress', 'blocked', 'pending_approval'] as const;

  return (
    <section className="dash">
      <header className="list-head">
        <h1>Needs attention</h1>
        <div className="statline">
          {active.map((s) => (
            <span key={s} className="stat"><b>{(d.statusCounts[s] ?? 0).toLocaleString()}</b> {statusLabel[s].toLowerCase()}</span>
          ))}
        </div>
      </header>
      <div className="cards">
        {d.sections.filter((sec) => canApprove || sec.id !== 'approvals').map((sec) => (
          <article key={sec.id} className={`card ${sec.count ? '' : 'quiet'} card-${sec.id}`}>
            <header>
              <div>
                <h3>{sec.title}</h3>
                <div className="muted small">{sec.hint}</div>
              </div>
              <button className="count" onClick={() => goView(sec.id)} title="Open full list">{sec.count.toLocaleString()}</button>
            </header>
            {sec.items.length === 0 ? (
              <div className="muted small pad">All clear.</div>
            ) : (
              <ul>
                {sec.items.map((it) => (
                  <li key={it.id}>
                    <button className="mini" onClick={() => open(it.id)}>
                      <Priority p={it.priority} />
                      <span className="key">{it.key}</span>
                      <span className="title">{it.title}</span>
                      <StatusPill s={it.status} />
                    </button>
                    <div className="mini-meta"><Owner item={it} /> <Due item={it} /></div>
                  </li>
                ))}
              </ul>
            )}
            {sec.count > sec.items.length && <button className="link more" onClick={() => goView(sec.id)}>View all {sec.count.toLocaleString()} →</button>}
          </article>
        ))}
      </div>
    </section>
  );
}
