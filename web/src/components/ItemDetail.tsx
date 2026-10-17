import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, KINDS, newKey, type Item, type ItemEvent, type Me, type TransitionAction } from '../api';
import { useClaim, useItemCommand, useTransition } from '../mutations';
import { useRecentChange } from '../live';
import { actionLabel, fullDate, statusLabel } from '../util';
import { Avatar, Due, Modal, Owner, Priority, Spinner, StatusPill, Time } from './bits';
import { useToast } from '../toast';

const NOTE_REQUIRED: TransitionAction[] = ['block', 'reject', 'resolve', 'reopen', 'cancel'];
const PRIMARY: TransitionAction[] = ['start', 'resolve', 'approve', 'submit_for_approval'];

export function ItemDetail({ id, me, onClose }: { id: number; me: Me; onClose: () => void }) {
  const q = useQuery({ queryKey: ['item', id], queryFn: () => api.item(id), retry: (n, e: ApiError) => e.retryable && n < 2 });
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [id]);

  return (
    <aside className="drawer" aria-label="Work item">
      {q.isPending && <div className="empty"><Spinner /></div>}
      {q.isError && (
        <div className="empty error">
          {(q.error as ApiError).status === 404 ? 'This item doesn’t exist or you don’t have access to it.' : 'Couldn’t load this item.'}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      )}
      {q.data && (
        <>
          <header className="drawer-head">
            <div className="crumbs">
              <span className="key">{q.data.key}</span> · {q.data.team.name} · <span className="muted">v{q.data.version}</span>
            </div>
            <button className="icon" onClick={onClose} aria-label="Close">✕</button>
          </header>
          <RemoteChangeBanner item={q.data} />
          {editing ? (
            <EditForm item={q.data} onDone={() => setEditing(false)} />
          ) : (
            <Summary item={q.data} onEdit={() => setEditing(true)} />
          )}
          <Actions item={q.data} me={me} />
          <Activity item={q.data} />
        </>
      )}
    </aside>
  );
}

function RemoteChangeBanner({ item }: { item: Item }) {
  const recent = useRecentChange(item.id);
  if (!recent) return null;
  return <div className="banner info">↻ {recent.by} just changed this item — you’re seeing the latest version.</div>;
}

function Summary({ item, onEdit }: { item: Item; onEdit: () => void }) {
  const canEdit = item.allowedActions?.includes('edit');
  return (
    <div className="summary">
      <div className="title-row">
        <h2>{item.title}</h2>
        {canEdit && <button className="btn small" onClick={onEdit}>Edit</button>}
      </div>
      <dl className="facts">
        <div><dt>Status</dt><dd><StatusPill s={item.status} /></dd></div>
        <div><dt>Priority</dt><dd><Priority p={item.priority} /></dd></div>
        <div><dt>Owner</dt><dd><Owner item={item} /></dd></div>
        <div><dt>Kind</dt><dd className="cap">{item.kind}</dd></div>
        <div><dt>Due</dt><dd><Due item={item} /></dd></div>
        <div><dt>Reporter</dt><dd>{item.reporter.name}</dd></div>
        {item.requiresApproval && (
          <div className="wide">
            <dt>Approval</dt>
            <dd>
              {item.approvedBy ? (
                <span className="ok">✓ Approved by {item.approvedBy.name} {item.approvedAt && <Time iso={item.approvedAt} />}</span>
              ) : item.status === 'pending_approval' ? (
                <span className="warn">Waiting for a lead (not the reporter or owner)</span>
              ) : (
                <span className="warn">Required before work can start</span>
              )}
            </dd>
          </div>
        )}
      </dl>
      {item.description ? <p className="desc">{item.description}</p> : <p className="muted small">No description.</p>}
      <div className="muted small">Opened {fullDate(item.createdAt)} · last activity <Time iso={item.lastActivityAt} /></div>
    </div>
  );
}

type Draft = { title: string; description: string; priority: number; kind: string; dueAt: string; requiresApproval: boolean };
const toDraft = (i: Item): Draft => ({
  title: i.title,
  description: i.description ?? '',
  priority: i.priority,
  kind: i.kind,
  dueAt: i.dueAt ? toLocalInput(i.dueAt) : '',
  requiresApproval: i.requiresApproval,
});
function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const FIELD_LABEL: Record<keyof Draft, string> = { title: 'Title', description: 'Description', priority: 'Priority', kind: 'Kind', dueAt: 'Due', requiresApproval: 'Needs approval' };

/**
 * Editing works against a snapshot ("base") of the item. If someone else saves first, the server
 * answers VERSION_CONFLICT and we show both versions of exactly the fields this user touched,
 * instead of silently overwriting their work or ours.
 */
function EditForm({ item, onDone }: { item: Item; onDone: () => void }) {
  const [base, setBase] = useState(item);
  const [draft, setDraft] = useState<Draft>(() => toDraft(item));
  const [conflict, setConflict] = useState<{ theirs: Item } | null>(null);
  const baseDraft = toDraft(base);
  const changed = (Object.keys(draft) as (keyof Draft)[]).filter((k) => draft[k] !== baseDraft[k]);
  const canWaive = item.allowedActions?.includes('waive_approval');

  const save = useItemCommand<{ version: number; patch: Record<string, unknown> }>(
    item.id,
    ({ version, patch, key }) => api.update(item.id, { expectedVersion: version, ...patch }, key),
    {
      onConflict: (err) => {
        if (err.code !== 'VERSION_CONFLICT') return false;
        setConflict({ theirs: err.details.current });
        return true;
      },
    },
  );

  const patchFor = (fields: (keyof Draft)[]) => {
    const p: Record<string, unknown> = {};
    for (const f of fields) p[f] = f === 'dueAt' ? (draft.dueAt ? new Date(draft.dueAt).toISOString() : null) : draft[f];
    return p;
  };

  const submit = (version: number) => {
    if (!changed.length) return onDone();
    save.mutate({ version, patch: patchFor(changed), key: newKey() }, { onSuccess: onDone });
  };

  const theirsDraft = conflict ? toDraft(conflict.theirs) : null;
  const remoteNewer = item.version > base.version;

  return (
    <form className="form summary" onSubmit={(e) => { e.preventDefault(); submit(base.version); }}>
      {remoteNewer && !conflict && (
        <div className="banner warn">Someone saved a newer version (v{item.version}) while you were editing v{base.version}. You’ll be asked to reconcile when you save.</div>
      )}
      <label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} minLength={3} maxLength={200} required /></label>
      <label>Description<textarea rows={6} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
      <div className="grid3">
        <label>Priority<select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}>{[1, 2, 3, 4].map((p) => <option key={p} value={p}>P{p}</option>)}</select></label>
        <label>Kind<select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></label>
        <label>Due<input type="datetime-local" value={draft.dueAt} onChange={(e) => setDraft({ ...draft, dueAt: e.target.value })} /></label>
      </div>
      <label className="check" title={base.requiresApproval && !canWaive ? 'Only a team lead can remove the approval requirement' : undefined}>
        <input type="checkbox" checked={draft.requiresApproval} disabled={base.requiresApproval && !canWaive} onChange={(e) => setDraft({ ...draft, requiresApproval: e.target.checked })} />
        Needs lead approval before work starts
      </label>
      {base.approvedBy && base.status === 'open' && (changed.includes('title') || changed.includes('description')) && (
        <div className="banner warn">Changing the title or description will void {base.approvedBy.name}’s approval.</div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button className="btn primary" disabled={save.isPending || !changed.length}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </div>

      {conflict && theirsDraft && (
        <Modal title="Someone else changed this item" onClose={() => setConflict(null)} width={640}>
          <p className="muted">Your edit was based on v{base.version}; the item is now v{conflict.theirs.version}. Nothing was overwritten. Choose what to keep:</p>
          <table className="diff">
            <thead><tr><th>Field</th><th>Yours</th><th>Current</th></tr></thead>
            <tbody>
              {changed.map((f) => (
                <tr key={f} className={String(draft[f]) !== String(theirsDraft[f]) ? 'differs' : ''}>
                  <td>{FIELD_LABEL[f]}</td>
                  <td>{String(draft[f]) || '—'}</td>
                  <td>{String(theirsDraft[f]) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="modal-actions">
            <button className="btn" onClick={() => { setConflict(null); onDone(); }}>Discard mine</button>
            <button className="btn" onClick={() => {
              // Rebase: keep my edited fields, take everything else from the current version.
              const theirs = conflict.theirs;
              const merged = toDraft(theirs);
              for (const f of changed) (merged as any)[f] = draft[f];
              setBase(theirs);
              setDraft(merged);
              setConflict(null);
            }}>Keep editing on latest</button>
            <button className="btn primary" onClick={() => {
              const v = conflict.theirs.version;
              setBase(conflict.theirs);
              setConflict(null);
              save.mutate({ version: v, patch: patchFor(changed), key: newKey() }, { onSuccess: onDone });
            }}>Apply my changes</button>
          </div>
        </Modal>
      )}
    </form>
  );
}

function Actions({ item, me }: { item: Item; me: Me }) {
  const allowed = new Set(item.allowedActions ?? []);
  const toast = useToast();
  const claim = useClaim(item, me);
  const transition = useTransition(item);
  const release = useItemCommand<object>(item.id, ({ key }) => api.release(item.id, item.assignee!.id, key), { success: 'Released' });
  const assign = useItemCommand<{ to: number | null }>(item.id, ({ to, key }) => api.assign(item.id, item.version, to, key));
  const [noteFor, setNoteFor] = useState<TransitionAction | null>(null);
  const [note, setNote] = useState('');
  const members = useQuery({
    queryKey: ['members', item.team.id],
    queryFn: () => api.members(item.team.id),
    enabled: allowed.has('assign'),
    staleTime: 5 * 60_000,
  });

  const busy = claim.isPending || transition.isPending || release.isPending || assign.isPending;
  const transitions = (Object.keys(actionLabel) as TransitionAction[]).filter((a) => allowed.has(a));

  const run = (action: TransitionAction) => {
    if (NOTE_REQUIRED.includes(action)) {
      setNote('');
      setNoteFor(action);
      return;
    }
    transition.fire({ action, version: item.version });
  };

  if (!allowed.size || (allowed.size === 1 && allowed.has('comment'))) {
    return allowed.size ? null : <div className="actions muted small">You have read-only access to this team.</div>;
  }

  return (
    <div className="actions">
      {allowed.has('claim') && <button className="btn primary" disabled={busy} onClick={() => claim.fire({})}>Take ownership</button>}
      {transitions.map((a) => (
        <button key={a} className={`btn ${PRIMARY.includes(a) ? 'primary' : ''} ${a === 'cancel' || a === 'reject' ? 'danger' : ''}`} disabled={busy} onClick={() => run(a)}>
          {actionLabel[a]}
        </button>
      ))}
      {allowed.has('release') && item.assignee?.id === me.id && <button className="btn" disabled={busy} onClick={() => release.fire({})}>Release</button>}
      {allowed.has('assign') && (
        <select
          className="assign"
          disabled={busy || members.isPending}
          value={item.assignee?.id ?? ''}
          onChange={(e) => assign.fire({ to: e.target.value ? Number(e.target.value) : null })}
          aria-label="Assign to"
        >
          <option value="">Unassigned</option>
          {members.data?.filter((m) => m.role !== 'viewer').map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
        </select>
      )}
      {busy && <Spinner />}

      {noteFor && (
        <Modal title={actionLabel[noteFor]} onClose={() => setNoteFor(null)}>
          <form className="form" onSubmit={(e) => {
            e.preventDefault();
            if (!note.trim()) return toast('Please add a note', 'warn');
            transition.fire({ action: noteFor, note, version: item.version });
            setNoteFor(null);
          }}>
            <label>{noteFor === 'resolve' ? 'What was done?' : 'Reason'}<textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} required /></label>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setNoteFor(null)}>Back</button>
              <button className={`btn ${noteFor === 'cancel' || noteFor === 'reject' ? 'danger' : 'primary'}`}>{actionLabel[noteFor]}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Activity({ item }: { item: Item }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ev = useQuery({ queryKey: ['events', item.id], queryFn: () => api.events(item.id) });
  const [body, setBody] = useState('');
  const [key, setKey] = useState(newKey);
  const canComment = item.allowedActions?.includes('comment');
  const comment = useMutation<ItemEvent, ApiError>({
    mutationFn: () => api.comment(item.id, body, key),
    retry: (n, e) => e.retryable && n < 2, // same key on retry → never a duplicate comment
    onSuccess: (e) => {
      qc.setQueryData<{ events: ItemEvent[] }>(['events', item.id], (old) =>
        old && !old.events.some((x) => x.id === e.id) ? { ...old, events: [...old.events, e] } : old,
      );
      setBody('');
      setKey(newKey());
    },
    onError: (e) => toast(e.message, 'error'),
  });

  const events = ev.data?.events ?? [];
  return (
    <section className="activity">
      <h3>Activity</h3>
      {ev.isPending && <Spinner />}
      <ol className="timeline">
        {events.map((e) => <EventLine key={e.id} e={e} />)}
      </ol>
      {canComment && (
        <form className="comment-box" onSubmit={(e) => { e.preventDefault(); if (body.trim() && !comment.isPending) comment.mutate(); }}>
          <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add an update, finding or decision…"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.currentTarget.form as HTMLFormElement).requestSubmit(); }} />
          <button className="btn primary" disabled={!body.trim() || comment.isPending}>{comment.isPending ? 'Posting…' : 'Comment'}</button>
        </form>
      )}
    </section>
  );
}

function describe(e: ItemEvent) {
  const d = e.data;
  switch (e.type) {
    case 'created': return <>opened this item</>;
    case 'claimed': return <>took ownership</>;
    case 'released': return <>released ownership{d.statusFrom !== d.statusTo ? ' (back to open)' : ''}</>;
    case 'assigned': return d.to ? <>assigned to <b>{d.to.name}</b>{d.from ? <> (was {d.from.name})</> : null}</> : <>unassigned {d.from?.name}</>;
    case 'status_changed':
      return (
        <>
          {d.action === 'approve' ? 'approved' : d.action === 'reject' ? 'rejected the request' : d.action === 'submit_for_approval' ? 'requested approval' : <>moved {statusLabel[d.from as keyof typeof statusLabel]?.toLowerCase()} → <b>{statusLabel[d.to as keyof typeof statusLabel]?.toLowerCase()}</b></>}
          {d.note && <blockquote>{d.note}</blockquote>}
        </>
      );
    case 'updated':
      return (
        <>
          changed{' '}
          {Object.entries(d.changes ?? {}).map(([f, c]: [string, any], i) => (
            <span key={f}>{i > 0 && ', '}<b>{f}</b>{f === 'description' ? '' : <> {fmt(f, c.from)} → {fmt(f, c.to)}</>}</span>
          ))}
          {d.approvalInvalidated && <div className="warn small">Approval voided because the request changed.</div>}
        </>
      );
    default: return <>{e.type}</>;
  }
}
const fmt = (f: string, v: unknown) => (v === null || v === '' ? '—' : f === 'priority' ? `P${v}` : f === 'dueAt' ? new Date(String(v)).toLocaleDateString() : String(v));

function EventLine({ e }: { e: ItemEvent }) {
  const who = e.actor?.name ?? 'System';
  if (e.type === 'comment') {
    return (
      <li className="ev comment">
        <Avatar name={who} size={26} />
        <div className="bubble">
          <div className="meta"><b>{who}</b> <span className="muted small"><Time iso={e.createdAt} /></span></div>
          <div className="body">{e.data.body}</div>
        </div>
      </li>
    );
  }
  return (
    <li className="ev">
      <span className="dot" />
      <div><b>{who}</b> {describe(e)} <span className="muted small"><Time iso={e.createdAt} /></span></div>
    </li>
  );
}
