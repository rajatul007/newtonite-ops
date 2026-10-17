import type { DB, Clock } from './db';
import type { CurrentUser } from './auth';
import type { Bus } from './bus';

export interface Deps {
  db: DB;
  clock: Clock;
  bus: Bus;
}

/** Per-command context. Side effects that must only happen after COMMIT go into afterCommit. */
export interface Ctx extends Deps {
  user: CurrentUser;
  afterCommit: Array<() => void>;
}

export const makeCtx = (deps: Deps, user: CurrentUser): Ctx => ({ ...deps, user, afterCommit: [] });
