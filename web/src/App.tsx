import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { useLiveUpdates, useConnectionState } from './live';
import { useDebounced, useUrlState } from './util';
import { VIEWS, viewById } from './views';
import { Login } from './components/Login';
import { Dashboard } from './components/Dashboard';
import { ItemList } from './components/ItemList';
import { ItemDetail } from './components/ItemDetail';
import { CreateItem } from './components/CreateItem';
import { Notifications } from './components/Notifications';
import { Avatar, Spinner } from './components/bits';

export function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: 60_000 });
  useLiveUpdates(me.data?.id);

  if (me.isPending) return <div className="boot"><Spinner /></div>;
  if (me.isError) {
    if ((me.error as ApiError).status === 401) return <Login />;
    return <div className="boot error">Can’t reach the server. <button className="link" onClick={() => me.refetch()}>Retry</button></div>;
  }
  return <Shell />;
}

function Shell() {
  const qc = useQueryClient();
  const me = qc.getQueryData<Awaited<ReturnType<typeof api.me>>>(['me'])!;
  const [params, setParam] = useUrlState();
  const [creating, setCreating] = useState(false);
  const conn = useConnectionState();

  const viewId = params.get('view') ?? 'attention';
  const view = viewById(viewId);
  const teamId = params.get('team') ? Number(params.get('team')) : undefined;
  const selected = params.get('item') ? Number(params.get('item')) : null;

  // Search box is local state, debounced into the URL so we don't query on every keystroke.
  const [search, setSearch] = useState(params.get('q') ?? '');
  const debounced = useDebounced(search, 250);
  useEffect(() => {
    if ((params.get('q') ?? '') === debounced) return;
    setParam({ q: debounced || null, ...(debounced && viewId === 'attention' ? { view: 'all' } : {}) }, false);
  }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea, select');
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'c' && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setCreating(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const goView = (id: string) => setParam({ view: id, status: null, priority: null, kind: null, sort: null });
  const open = (id: number) => setParam({ item: String(id) });

  const logout = async () => {
    await api.logout();
    qc.clear();
    location.href = '/';
  };

  return (
    <div className={`app ${selected ? 'with-drawer' : ''}`}>
      <header className="topbar">
        <div className="brand"><span className="logo">N</span> Ops</div>
        <div className="search">
          <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search titles & descriptions, or jump to PAY-123   ( / )" aria-label="Search" />
          {search && <button className="icon" onClick={() => setSearch('')} aria-label="Clear search">✕</button>}
        </div>
        <button className="btn primary" onClick={() => setCreating(true)} title="Shortcut: c">+ New item</button>
        <span className={`conn conn-${conn}`} title={conn === 'live' ? 'Live updates connected' : 'Reconnecting… data may be out of date'} />
        <Notifications open={open} />
        <div className="me">
          <Avatar name={me.name} size={26} />
          <div className="me-text"><b>{me.name}</b><span className="muted small">{me.isAdmin ? 'Admin' : me.teams.map((t) => `${t.key}:${t.role}`).join(' · ')}</span></div>
          <button className="link small" onClick={logout}>Sign out</button>
        </div>
      </header>

      <nav className="sidebar">
        <div className="nav-group">
          <button className={`nav ${viewId === 'attention' ? 'on' : ''}`} onClick={() => goView('attention')}>Needs attention</button>
          {VIEWS.map((v) => (
            <button key={v.id} className={`nav ${viewId === v.id ? 'on' : ''}`} onClick={() => goView(v.id)}>{v.label}</button>
          ))}
        </div>
        <div className="nav-group">
          <div className="nav-title">Teams</div>
          <button className={`nav ${!teamId ? 'on' : ''}`} onClick={() => setParam({ team: null })}>All my teams</button>
          {me.teams.map((t) => (
            <button key={t.id} className={`nav ${teamId === t.id ? 'on' : ''}`} onClick={() => setParam({ team: String(t.id) })}>
              <span className="team-key">{t.key}</span> {t.name} {t.role === 'viewer' && <span className="muted small">(view)</span>}
            </button>
          ))}
        </div>
        <div className="hint muted small">Shortcuts: <kbd>/</kbd> search · <kbd>c</kbd> new item</div>
      </nav>

      <main className="main">
        {viewId === 'attention' || !view ? (
          <Dashboard teamId={teamId} open={open} goView={goView} canApprove={me.isAdmin || me.teams.some((t) => t.role === 'lead')} />
        ) : (
          <ItemList
            key={view.id}
            base={view.base}
            title={params.get('q') ? `Search: “${params.get('q')}” in ${view.label.toLowerCase()}` : view.label}
            params={params}
            setParam={setParam}
            defaultSort={view.sort}
            selectedId={selected}
          />
        )}
      </main>

      {selected && <ItemDetail id={selected} me={me} onClose={() => setParam({ item: null })} />}
      {creating && (
        <CreateItem me={me} defaultTeam={teamId} onClose={() => setCreating(false)} onCreated={(it) => { setCreating(false); open(it.id); }} />
      )}
    </div>
  );
}
