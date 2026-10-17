/**
 * Workflow + authorization policy.
 *
 * This is the single source of truth for "who may do what to which item in which state".
 * The API enforces it on every command, and also returns `allowedActions` computed by the
 * same function so the UI can hide buttons — but hiding is a convenience, never the control.
 */
import type { CurrentUser, Role } from './auth';

export const STATUSES = ['open', 'in_progress', 'blocked', 'pending_approval', 'resolved', 'closed', 'cancelled'] as const;
export type Status = (typeof STATUSES)[number];
export const ACTIVE_STATUSES: Status[] = ['open', 'in_progress', 'blocked', 'pending_approval'];
export const TERMINAL_STATUSES: Status[] = ['closed', 'cancelled'];
export const KINDS = ['incident', 'customer', 'payment', 'engineering', 'compliance', 'task'] as const;

export interface PolicyItem {
  team_id: number;
  status: Status;
  assignee_id: number | null;
  reporter_id: number;
  requires_approval: number;
  approved_by: number | null;
}

export const TRANSITIONS = {
  start: { from: ['open', 'blocked'], to: 'in_progress', noteRequired: false },
  block: { from: ['in_progress'], to: 'blocked', noteRequired: true },
  submit_for_approval: { from: ['open'], to: 'pending_approval', noteRequired: false },
  approve: { from: ['pending_approval'], to: 'open', noteRequired: false },
  reject: { from: ['pending_approval'], to: 'open', noteRequired: true },
  resolve: { from: ['in_progress'], to: 'resolved', noteRequired: true },
  close: { from: ['resolved'], to: 'closed', noteRequired: false },
  reopen: { from: ['resolved', 'closed', 'cancelled'], to: 'open', noteRequired: true },
  cancel: { from: ['open', 'in_progress', 'blocked', 'pending_approval'], to: 'cancelled', noteRequired: true },
} as const satisfies Record<string, { from: readonly Status[]; to: Status; noteRequired: boolean }>;
export type TransitionAction = keyof typeof TRANSITIONS;
export const TRANSITION_ACTIONS = Object.keys(TRANSITIONS) as TransitionAction[];

export type Action = 'view' | 'comment' | 'edit' | 'claim' | 'release' | 'assign' | 'waive_approval' | TransitionAction;

export type Decision =
  | { ok: true }
  // FORBIDDEN -> 403 (who you are), INVALID_STATE -> 409 (what state the item is in)
  | { ok: false; kind: 'FORBIDDEN' | 'INVALID_STATE'; reason: string };

const allow: Decision = { ok: true };
const deny = (reason: string): Decision => ({ ok: false, kind: 'FORBIDDEN', reason });
const invalid = (reason: string): Decision => ({ ok: false, kind: 'INVALID_STATE', reason });

const RANK: Record<Role, number> = { viewer: 0, member: 1, lead: 2 };

export function roleIn(user: CurrentUser, teamId: number): Role | undefined {
  return user.roles.get(teamId);
}

/** Admins act with lead rights everywhere. */
export function hasRole(user: CurrentUser, teamId: number, min: Role): boolean {
  if (user.isAdmin) return true;
  const role = user.roles.get(teamId);
  return role !== undefined && RANK[role] >= RANK[min];
}

export function canView(user: CurrentUser, teamId: number): boolean {
  return user.isAdmin || user.roles.has(teamId);
}

export function decide(user: CurrentUser, item: PolicyItem, action: Action): Decision {
  if (!canView(user, item.team_id)) return deny('Not a member of this team');
  if (action === 'view') return allow;

  const isMember = hasRole(user, item.team_id, 'member');
  const isLead = hasRole(user, item.team_id, 'lead');
  const isAssignee = item.assignee_id === user.id;
  const isReporter = item.reporter_id === user.id;
  const terminal = TERMINAL_STATUSES.includes(item.status);

  if (!isMember) return deny('Viewers have read-only access');

  switch (action) {
    case 'comment':
      return allow;
    case 'edit':
      return terminal ? invalid('Reopen the item before editing it') : allow;
    case 'waive_approval':
      return isLead ? allow : deny('Only a team lead can remove an approval requirement');
    case 'claim':
      if (terminal || item.status === 'resolved') return invalid('Item is already finished');
      if (item.assignee_id !== null && !isAssignee) return invalid('Item is already owned by someone else');
      return allow;
    case 'release':
      if (item.assignee_id === null) return invalid('Item is not assigned');
      return isAssignee || isLead ? allow : deny('Only the owner or a lead can release this item');
    case 'assign':
      if (terminal) return invalid('Reopen the item before reassigning it');
      return isLead ? allow : deny('Only a team lead can assign work to others');
  }

  // Workflow transitions
  const t = TRANSITIONS[action];
  if (!(t.from as readonly Status[]).includes(item.status)) {
    return invalid(`Cannot ${action.replace(/_/g, ' ')} an item that is ${item.status.replace(/_/g, ' ')}`);
  }
  switch (action) {
    case 'start':
      if (item.assignee_id === null) return invalid('Assign an owner before starting work');
      if (item.requires_approval && item.approved_by === null) return invalid('This item needs approval before work can start');
      return isAssignee || isLead ? allow : deny('Only the owner or a lead can start this item');
    case 'block':
    case 'resolve':
      return isAssignee || isLead ? allow : deny('Only the owner or a lead can do that');
    case 'submit_for_approval':
      if (!item.requires_approval) return invalid('This item does not require approval');
      if (item.approved_by !== null) return invalid('Already approved');
      return allow;
    case 'approve':
    case 'reject':
      if (!isLead) return deny('Only a team lead can approve or reject');
      // Four-eyes rule: you cannot approve work you requested or will carry out.
      if (isReporter || isAssignee) return deny('Approval must come from someone other than the requester or owner');
      return allow;
    case 'close':
    case 'cancel':
      return isLead || isReporter ? allow : deny('Only the reporter or a lead can do that');
    case 'reopen':
      return allow;
  }
  return deny('Unknown action');
}

export function allowedActions(user: CurrentUser, item: PolicyItem): Action[] {
  const all: Action[] = ['comment', 'edit', 'claim', 'release', 'assign', 'waive_approval', ...TRANSITION_ACTIONS];
  return all.filter((a) => {
    if (a === 'claim' && item.assignee_id !== null) return false; // hide no-op claim for current owner
    if (a === 'waive_approval' && !item.requires_approval) return false;
    return decide(user, item, a).ok;
  });
}
