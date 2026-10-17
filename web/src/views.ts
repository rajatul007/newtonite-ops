import { ACTIVE, type ListParams } from './api';

export interface ViewDef { id: string; label: string; base: ListParams; sort: string }

/** Saved queries shown in the sidebar. The dashboard's sections link to the same ids. */
export const VIEWS: ViewDef[] = [
  { id: 'mine', label: 'Assigned to me', base: { assignee: 'me', status: ACTIVE }, sort: 'priority' },
  { id: 'approvals', label: 'Awaiting my approval', base: { needsMyApproval: true }, sort: 'priority' },
  { id: 'unowned', label: 'Urgent & unowned', base: { assignee: 'none', priority: [1, 2], status: ['open', 'blocked', 'pending_approval'] }, sort: 'priority' },
  { id: 'overdue', label: 'Overdue', base: { overdue: true }, sort: 'priority' },
  { id: 'stale', label: 'Going stale', base: { stale: true }, sort: 'priority' },
  { id: 'reported', label: 'Reported by me', base: { reporter: 'me' }, sort: 'activity' },
  { id: 'all', label: 'All work', base: {}, sort: 'activity' },
];
export const viewById = (id: string | null) => VIEWS.find((v) => v.id === id);
