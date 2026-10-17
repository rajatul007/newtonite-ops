import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, KINDS, newKey, type Item, type Me } from '../api';
import { Modal } from './bits';
import { useToast } from '../toast';

export function CreateItem({ me, defaultTeam, onClose, onCreated }: { me: Me; defaultTeam?: number; onClose: () => void; onCreated: (it: Item) => void }) {
  const writable = me.teams.filter((t) => t.role !== 'viewer');
  const qc = useQueryClient();
  const toast = useToast();
  // One key for the lifetime of this form: double-clicks and automatic retries create ONE item.
  const [idemKey] = useState(newKey);
  const [form, setForm] = useState({
    teamId: writable.find((t) => t.id === defaultTeam)?.id ?? writable[0]?.id,
    title: '',
    description: '',
    kind: 'task',
    priority: 3,
    requiresApproval: false,
    dueAt: '',
    assignToMe: false,
  });
  const set = (k: keyof typeof form, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const m = useMutation<Item, ApiError>({
    mutationFn: () =>
      api.create(
        {
          teamId: form.teamId,
          title: form.title,
          description: form.description,
          kind: form.kind,
          priority: form.priority,
          requiresApproval: form.requiresApproval,
          dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null,
          assigneeId: form.assignToMe ? me.id : null,
        },
        idemKey,
      ),
    retry: (n, err) => err.retryable && n < 2,
    onSuccess: (it) => {
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast(`Created ${it.key}`, 'success');
      onCreated(it);
    },
  });

  if (!writable.length) {
    return (
      <Modal title="New work item" onClose={onClose}>
        <p>You have read-only access in all your teams, so you can’t create work items.</p>
        <div className="modal-actions"><button className="btn" onClick={onClose}>Close</button></div>
      </Modal>
    );
  }

  return (
    <Modal title="New work item" onClose={onClose} width={600}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (!m.isPending) m.mutate(); }}>
        <label>Title<input required minLength={3} maxLength={200} value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="What needs to happen, in one line" /></label>
        <label>Why does this exist?<textarea rows={5} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Context, impact, links, customer / payment references…" /></label>
        <div className="grid3">
          <label>Team<select value={form.teamId} onChange={(e) => set('teamId', Number(e.target.value))}>{writable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label>Kind<select value={form.kind} onChange={(e) => set('kind', e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></label>
          <label>Priority<select value={form.priority} onChange={(e) => set('priority', Number(e.target.value))}>
            <option value={1}>P1 · critical (pages leads)</option><option value={2}>P2 · high</option><option value={3}>P3 · normal</option><option value={4}>P4 · low</option>
          </select></label>
        </div>
        <div className="grid3">
          <label>Due<input type="datetime-local" value={form.dueAt} onChange={(e) => set('dueAt', e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={form.requiresApproval} onChange={(e) => set('requiresApproval', e.target.checked)} />Needs lead approval before work starts</label>
          <label className="check"><input type="checkbox" checked={form.assignToMe} onChange={(e) => set('assignToMe', e.target.checked)} />I’ll own this</label>
        </div>
        {m.error && <div className="form-error">{m.error.message}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={m.isPending}>{m.isPending ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}
