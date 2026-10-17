// Thin typed client for the Newtonite Ops API.

export type Status = 'open' | 'in_progress' | 'blocked' | 'pending_approval' | 'resolved' | 'closed' | 'cancelled';
export type Kind = 'incident' | 'customer' | 'payment' | 'engineering' | 'compliance' | 'task';
export type TransitionAction =
  | 'start' | 'block' | 'submit_for_approval' | 'approve' | 'reject' | 'resolve' | 'close' | 'reopen' | 'cancel';
export type Action = 'comment' | 'edit' | 'claim' | 'release' | 'assign' | 'waive_approval' | TransitionAction;

export const STATUSES: Status[] = ['open', 'in_progress', 'blocked', 'pending_approval', 'resolved', 'closed', 'cancelled'];
export const ACTIVE: Status[] = ['open', 'in_progress', 'blocked', 'pending_approval'];
export const KINDS: Kind[] = ['incident', 'customer', 'payment', 'engineering', 'compliance', 'task'];

export interface Ref { id: number; name: string }
export interface Item {
  id: number;
  key: string;
  team: { id: number; key: string; name: string };
  title: string;
  description?: string;
  kind: Kind;
  priority: number;
  status: Status;
  assignee: Ref | null;
  reporter: Ref;
  requiresApproval: boolean;
  approvedBy: Ref | null;
  approvedAt: string | null;
  dueAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  resolvedAt: string | null;
  allowedActions?: Action[];
}
export interface ItemEvent {
  id: number;
  itemId: number;
  actor: Ref | null;
  type: string;
  data: any;
  itemVersion: number;
  createdAt: string;
}
export interface Me {
  id: number;
  name: string;
  email: string;
  isAdmin: boolean;
  teams: { id: number; name: string; key: string; role: 'viewer' | 'member' | 'lead' }[];
}
export interface Page { items: Item[]; nextCursor: string | null }
export interface DashboardSection { id: string; title: string; hint: string; filters: Record<string, unknown>; count: number; items: Item[] }
export interface Dashboard { statusCounts: Record<string, number>; sections: DashboardSection[] }
export interface Notification { id: number; itemId: number; message: string; readAt: string | null; createdAt: string }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
  /** Network failures and 5xx/503 are worth retrying; 4xx are decisions, not accidents. */
  get retryable() {
    return this.status === 0 || this.status >= 500;
  }
}

async function request<T>(method: string, url: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'UNKNOWN', e.message ?? res.statusText, e.details);
  }
  return data as T;
}

export const newKey = () => crypto.randomUUID();

const qs = (params: Record<string, unknown>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    u.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
};

export interface ListParams {
  teamId?: number;
  status?: string[];
  priority?: number[];
  kind?: string[];
  assignee?: string;
  reporter?: string;
  q?: string;
  overdue?: boolean;
  stale?: boolean;
  needsMyApproval?: boolean;
  sort?: string;
}

/**
 * Every mutating call takes an idempotency key generated once per user intent (e.g. per click),
 * so automatic retries after a timeout can never apply the same action twice.
 */
export const api = {
  login: (email: string, password: string) => request<{ token: string }>('POST', '/api/auth/login', { email, password }),
  logout: () => request('POST', '/api/auth/logout'),
  me: () => request<Me>('GET', '/api/me'),
  members: (teamId: number) => request<{ id: number; name: string; role: string }[]>('GET', `/api/teams/${teamId}/members`),
  dashboard: (teamId?: number) => request<Dashboard>('GET', `/api/dashboard${qs({ teamId })}`),
  list: (p: ListParams, cursor?: string) => request<Page>('GET', `/api/items${qs({ ...p, cursor, limit: 50 })}`),
  item: (id: number) => request<Item>('GET', `/api/items/${id}`),
  events: (id: number) => request<{ events: ItemEvent[]; nextAfter: number | null }>('GET', `/api/items/${id}/events`),
  create: (body: object, key: string) => request<Item>('POST', '/api/items', body, key),
  update: (id: number, body: object, key: string) => request<Item>('PATCH', `/api/items/${id}`, body, key),
  claim: (id: number, key: string) => request<Item>('POST', `/api/items/${id}/claim`, {}, key),
  release: (id: number, expectedAssigneeId: number, key: string) =>
    request<Item>('POST', `/api/items/${id}/release`, { expectedAssigneeId }, key),
  assign: (id: number, expectedVersion: number, assigneeId: number | null, key: string) =>
    request<Item>('POST', `/api/items/${id}/assign`, { expectedVersion, assigneeId }, key),
  transition: (id: number, expectedVersion: number, action: TransitionAction, note: string | undefined, key: string) =>
    request<Item>('POST', `/api/items/${id}/transitions`, { expectedVersion, action, note }, key),
  comment: (id: number, body: string, key: string) => request<ItemEvent>('POST', `/api/items/${id}/comments`, { body }, key),
  notifications: () => request<{ unread: number; notifications: Notification[] }>('GET', '/api/notifications'),
  markRead: (upToId: number) => request('POST', '/api/notifications/read', { upToId }),
};
