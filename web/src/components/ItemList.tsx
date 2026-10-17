import { useEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery, keepPreviousData } from '@tanstack/react-query';
import { api, KINDS, STATUSES, ACTIVE, type Item, type ListParams } from '../api';
import { useRecentChange } from '../live';
import { statusLabel } from '../util';
import { Due, Owner, Priority, Spinner, StatusPill, Time } from './bits';

interface Props {
  base: ListParams;
  title: string;
  params: URLSearchParams;
  setParam: (changes: Record<string, string | null>, push?: boolean) => void;
  defaultSort: string;
  selectedId: number | null;
}

const split = (s: string | null) => (s ? s.split(',').filter(Boolean) : undefined);

export function ItemList({ base, title, params, setParam, defaultSort, selectedId }: Props) {
  // URL filters refine the view's base filters; an explicit status choice replaces the view's.
  const status = split(params.get('status'));
  const priority = split(params.get('priority'))?.map(Number);
  const filters: ListParams = {
    ...base,
    teamId: params.get('team') ? Number(params.get('team')) : undefined,
    q: params.get('q') ?? undefined,
    ...(status ? { status } : {}),
    ...(priority ? { priority } : {}),
    ...(params.get('kind') ? { kind: [params.get('kind')!] } : {}),
    sort: params.get('sort') ?? defaultSort,
  };
  const key = useMemo(() => JSON.stringify(filters), [JSON.stringify(filters)]);

  const q = useInfiniteQuery({
    queryKey: ['items', key],
    queryFn: ({ pageParam }) => api.list(filters, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData, // keep showing old results while new filters load
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  // Load the next page when the sentinel scrolls into view (only ever fetches what is displayed).
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && q.hasNextPage && !q.isFetchingNextPage) q.fetchNextPage();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [q.hasNextPage, q.isFetchingNextPage, q.fetchNextPage]);

  const effectiveStatus = filters.status ?? [];
  const toggle = (name: 'status' | 'priority', value: string, current: string[]) => {
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    setParam({ [name]: next.length ? next.join(',') : null }, false);
  };

  return (
    <section className="list">
      <header className="list-head">
        <h1>{title}</h1>
        <div className="filters">
          <div className="chips" role="group" aria-label="Status">
            <button className={`chip ${!status ? 'on' : ''}`} onClick={() => setParam({ status: null }, false)} title="Use the view's default">Default</button>
            <button className={`chip ${status && ACTIVE.every((s) => status.includes(s)) && status.length === ACTIVE.length ? 'on' : ''}`} onClick={() => setParam({ status: ACTIVE.join(',') }, false)}>Active</button>
            {STATUSES.map((s) => (
              <button key={s} className={`chip ${status?.includes(s) ? 'on' : ''}`} onClick={() => toggle('status', s, status ?? [])}>{statusLabel[s]}</button>
            ))}
          </div>
          <div className="chips" role="group" aria-label="Priority">
            {[1, 2, 3, 4].map((p) => (
              <button key={p} className={`chip prio-chip ${priority?.includes(p) ? 'on' : ''}`} onClick={() => toggle('priority', String(p), (priority ?? []).map(String))}>P{p}</button>
            ))}
            <select value={params.get('kind') ?? ''} onChange={(e) => setParam({ kind: e.target.value || null }, false)} aria-label="Kind">
              <option value="">Any kind</option>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <select value={filters.sort} onChange={(e) => setParam({ sort: e.target.value }, false)} aria-label="Sort">
              <option value="activity">Recent activity</option>
              <option value="priority">Priority</option>
              <option value="created">Newest</option>
            </select>
          </div>
        </div>
        {effectiveStatus.length > 0 && !status && <div className="muted small">Showing: {effectiveStatus.map((s) => statusLabel[s as keyof typeof statusLabel]).join(', ')}</div>}
      </header>

      {q.isError && <div className="empty error">Couldn’t load work items. <button className="link" onClick={() => q.refetch()}>Retry</button></div>}
      {q.isPending && <div className="empty"><Spinner /></div>}
      {q.isSuccess && items.length === 0 && <div className="empty">Nothing here. {filters.q ? 'Try a different search.' : 'Nice.'}</div>}

      {items.length > 0 && (
        <div className={`rows ${q.isPlaceholderData ? 'dim' : ''}`} role="list">
          {items.map((it) => (
            <Row key={it.id} item={it} selected={it.id === selectedId} onOpen={() => setParam({ item: String(it.id) })} />
          ))}
        </div>
      )}
      <div ref={sentinel} className="sentinel">
        {q.isFetchingNextPage ? <Spinner /> : q.hasNextPage ? <button className="link" onClick={() => q.fetchNextPage()}>Load more</button> : items.length > 0 ? <span className="muted small">End of list · {items.length} items</span> : null}
      </div>
    </section>
  );
}

function Row({ item, selected, onOpen }: { item: Item; selected: boolean; onOpen: () => void }) {
  const recent = useRecentChange(item.id);
  return (
    <button role="listitem" className={`row ${selected ? 'selected' : ''} ${recent ? 'flash' : ''}`} onClick={onOpen}>
      <Priority p={item.priority} />
      <span className="key">{item.key}</span>
      <span className="title">
        {item.title}
        {recent && <span className="recent">updated by {recent.by}</span>}
      </span>
      <StatusPill s={item.status} />
      <Owner item={item} />
      <Due item={item} />
      <span className="muted small when"><Time iso={item.lastActivityAt} /></span>
    </button>
  );
}
