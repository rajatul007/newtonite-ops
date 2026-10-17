# Engineering Decisions

This document explains the most important decisions behind Newtonite Ops, the trade-offs I accepted, and what I deliberately left out. The guiding principle was the one in the brief: **a smaller system with well-considered behaviour beats a large one with many half-finished features.** Every feature that exists should behave correctly when two people use it at once, when a request is retried, or when a background job fails.

---

## 1. Optimistic concurrency with an explicit version, but intent-based guards where "version" is the wrong question

**Decision.** Every work item has an integer `version`. Every command that changes item *fields* (edit, assign, workflow transition) must send the `expectedVersion` the user was looking at. The write is a compare-and-swap:

```sql
UPDATE work_items SET ..., version = version + 1 WHERE id = ? AND version = ?
```

If the version moved, the API returns `409 VERSION_CONFLICT` **with the current item in the error body**, so the client can reconcile without another round-trip.

However, I did *not* use version checks for everything, because "has anything changed?" is often the wrong question:

| Operation | Guard | Why |
|---|---|---|
| Edit / assign / transition | `version = expected` | The user made a decision based on what they saw; if it changed, they must look again. |
| **Claim** ("take ownership") | `assignee_id IS NULL` | The user's intent is "make me the owner if nobody is". A comment or typo fix from someone else shouldn't make that fail, but someone else claiming first must. Claiming something you already own is a successful no-op, so retries are safe. |
| **Release** | `assignee_id = <owner I saw>` | A stale "release" from an old tab must not unassign the *new* owner. |
| Comment | none (append-only) | Comments can't conflict with each other. They deliberately do **not** bump the version — otherwise every comment would turn someone's in-progress edit into a conflict. |

**Where this pays off in the product.** A lead reviewing an approval request approves *the version they read*. If the requester changes the description while the lead is reading, the approval is rejected with a conflict instead of approving something the lead never saw (`test/concurrency.test.ts`).

**Frontend.** The edit form keeps a snapshot ("base") of the item. Live updates refresh the item underneath and show a banner ("someone saved v4 while you were editing v3"). On save conflict, a dialog shows *only the fields this user changed*, yours vs. current, with three choices: discard mine, apply mine on top of the latest, or keep editing rebased on the latest. Nothing is silently overwritten in either direction.

**Trade-off.** Field-level automatic merging (apply my priority change if they only changed the title) would be friendlier, but it is easy to get subtly wrong; the explicit dialog is simpler to reason about and the server never guesses.

---

## 2. Idempotency keys stored in the same transaction as the effect

**Decision.** All state-changing endpoints accept an `Idempotency-Key` header. The frontend generates one key **per user intent** — per open "New item" form, per click, per comment — and automatic retries (network errors and 5xx only) reuse the same key.

The server (`server/src/http.ts`) runs each command in one immediate write transaction that:

1. looks up `(user_id, key)`;
2. if present with the same request hash → replays the stored response (`Idempotent-Replayed: true`) without re-executing;
3. if present with a *different* request → `422 IDEMPOTENCY_KEY_REUSED`;
4. otherwise executes the command **and inserts the key + response in the same transaction**.

Because the key and the effect commit atomically, there is no window where "the item was created" and "the key was recorded" disagree, and no in-flight/locking state to clean up after a crash.

**Only successes are stored.** A failed command rolled back and changed nothing, so re-executing it on retry is both safe and useful (the user can fix the cause and press the same button). Stripe-style "remember errors too" would turn a transient 500 into a permanent one for that key.

**Trade-off.** Keys are scoped per user and expire after 24h (cleanup job). A client that retries after 24h could duplicate — acceptable for interactive use.

---

## 3. An append-only event log is the history, and a transactional outbox drives async work

**Decision.** Every change appends an immutable row to `item_events` (who, what, structured diff, the item version it produced, when). The timeline in the UI is this table; nothing is ever updated or deleted, so "why was this decision made / who changed priority" always has an answer. Notes are mandatory for decisions that need justification (block, resolve, reject, cancel, reopen).

In the **same transaction** the command inserts a row into `jobs` (a transactional outbox) for follow-up work — currently notifications. This gives the key guarantee: *a committed change always has its follow-up recorded; a rolled-back change never does.* There is no "saved but the notification got lost" and no "notified about a change that didn't happen".

**The worker** (`server/src/jobs.ts`) is at-least-once with:

- **Leases**: a worker atomically leases a job (`UPDATE … RETURNING`) for 30 s. If it crashes, the lease expires and another worker picks it up. A zombie worker that wakes up late can't overwrite the outcome (writes are guarded on `locked_by`).
- **Retries with exponential backoff**, then **`dead`** after N attempts — kept for inspection, never silently dropped.
- **Dedupe keys** (`UNIQUE`) so the same logical job can't be enqueued twice.
- **Idempotent handlers**: notifications have `UNIQUE(user_id, event_id)` + `ON CONFLICT DO NOTHING`, so running a job twice, or retrying after a partial failure, produces exactly one notification per person.
- Recipients are computed **at event time** and stored in the payload, so a delayed or retried job notifies exactly the people who were relevant when it happened, not whoever is assigned an hour later.

You can watch this behave under failure with `NOTIFY_FAILURE_RATE=0.5 npm start --prefix server`.

**What is synchronous vs asynchronous.** Synchronous: anything that decides correctness — authorization, workflow validation, the state change, the history event, and enqueueing. Asynchronous: notification fan-out (and housekeeping). The user's action never waits on, or fails because of, a notification.

**Trade-off.** The event log plus a denormalised current-state row means two representations to keep consistent. I keep them consistent by always writing both in one transaction through a single helper (`recordEvent`), rather than doing full event sourcing, which would make queries and search much harder for no real benefit here.

---

## 4. Authorization: per-team roles, one policy function, enforced on the server, exposed to the UI

**Model.** Users belong to teams with a role per team: `viewer` (read-only), `member` (create, comment, claim, work on items they own, request approval), `lead` (assign anyone, approve/reject, cancel/close, waive approval requirements). Admins act as leads everywhere. A user can be a lead in one team and a viewer in another.

**Resource-level rules beyond roles** (in `server/src/policy.ts`):

- **Four-eyes approval** — an approver must be a lead *and* not the reporter or the current owner. A lead can't approve their own request.
- Members can't silently remove an approval requirement; only leads can.
- Editing the title/description of an approved-but-not-started item **voids the approval**, so "approve the typo fix" can't become "refund 300 merchants".
- Work can only be assigned to members/leads of the item's team (never viewers, never other teams).
- Items in teams you can't see return **404, not 403**, everywhere (read, write, history, search), so their existence isn't leaked.

**One source of truth.** `decide(user, item, action)` is the only place these rules live. Every command calls it, and `GET /items/:id` returns `allowedActions` computed by the same function. The UI uses `allowedActions` to show buttons, but hiding a button is a convenience, never the control. A test checks over 1,300 combinations of user × status × owner × reporter × approval state that what the UI is told and what the server enforces never disagree.

**Distinguishing "who you are" from "what state it's in".** The policy returns `FORBIDDEN` (403) vs `INVALID_STATE` (409). The UI handles them differently: a 409 means "the world changed, here's the current item", a 403 means "you can't do this".

**Trade-off.** Roles are loaded from the DB on every request (memberships are tiny and indexed), so permission changes take effect immediately instead of when a session/JWT expires.

---

## 5. SQLite (WAL) behind a small service layer, with keyset pagination and FTS

**Decision.** SQLite in WAL mode via `better-sqlite3`, with a schema and query patterns that port directly to Postgres.

Why for this exercise: zero setup for reviewers (`npm run setup && npm run seed && npm start`), real transactions, real constraints, `UPDATE … RETURNING`, and a built-in full-text index (FTS5). WAL lets readers proceed while a writer commits and lets a separate worker process share the file. Seeded with 30,000 items / 94,000 events, the dashboard query set takes ~35 ms and a filtered full-text search ~10 ms on a laptop.

**Designed for growth, not for the whole dataset in memory:**

- **Keyset (seek) pagination** on `(sort key…, id)` with an opaque cursor. Cost is O(page) regardless of depth, and pages don't skip or duplicate rows when new items arrive between page loads (tested). OFFSET would degrade and drift.
- Composite indexes matching the actual access paths (team + activity, team + status + priority, assignee + status, status + due date).
- **FTS5** external-content index kept in sync by triggers. User input is tokenised into quoted prefix terms, so it can never be interpreted as FTS syntax (tested with hostile input). Typing an item key (`PAY-123`) jumps straight to it.
- The browser only ever holds the pages it has scrolled through (infinite scroll with an `IntersectionObserver`), and the event timeline is paginated server-side.
- The dashboard is a set of **saved queries** (assigned to me, awaiting my approval, urgent & unowned, overdue, going stale) returning counts plus the top 5; each links to the full list.

**Trade-off / honesty about concurrency.** SQLite has a single writer. Every command runs in `BEGIN IMMEDIATE`, so writes are serialised, and within one Node process the handlers are synchronous. That means the race tests exercise the real HTTP + transaction path, but the "two writers truly interleave" scenario only fully arises with multiple processes or Postgres. I wrote every write as a compare-and-swap *anyway* (`WHERE version = ?`, `WHERE assignee_id IS NULL`, `UNIQUE` constraints for idempotency and notifications) so correctness does not depend on serialisation; moving to Postgres under READ COMMITTED needs no change to the guards.

With thousands of concurrent users the single writer becomes the ceiling (roughly thousands of short writes/second here, plenty for this load). That is the first thing I'd change at scale — see the README.

---

## 6. Frontend state: server state in a query cache; the URL for navigation; live events as invalidation hints

- **TanStack Query** owns all server state. The server's response is always authoritative: after any command, the returned item replaces the cache entry.
- **Optimistic updates only where they're cheap to undo.** "Take ownership" shows you as owner immediately; if someone beat you to it, the server's `409 ALREADY_CLAIMED` carries the current item, the cache is rolled back to the truth, and a toast says who owns it. Edits are not optimistic — a conflicting edit needs a decision from the user, not a silent rollback.
- **Live updates via Server-Sent Events** are *hints, not data*: an event says "item 42 changed to v7 by Meera", and the client refetches that item through the normal API. Authorization therefore lives in exactly one place (the REST endpoints), and a missed event costs freshness, never correctness. Bursts are coalesced (one list refresh per ~800 ms), and after a reconnect the client refetches everything, because events sent while disconnected are gone. A small indicator in the top bar shows whether live updates are connected.
- **The URL is the navigation state** (view, team, filters, search, open item), so every view and item is linkable and survives reloads.

---

## What I intentionally did not build

- **Field-level automatic merge** of concurrent edits (see §1).
- **Real-time co-editing / presence** ("Meera is viewing this"). Valuable, but conflict detection + live refresh covers the correctness problem.
- **Email/Slack delivery.** Notifications are in-app; the outbox makes adding a delivery channel a new job type, not a redesign.
- **User/team administration UI.** Teams, users and roles are seeded; the model and enforcement are complete.
- **SLA engine / escalation policies.** "Going stale" and "Overdue" are computed views rather than timers that mutate items.
- **Attachments, sub-tasks, linking items, custom fields.**
- **SSO / password reset.** Sessions are opaque random tokens (hashed at rest) in an HttpOnly, SameSite=Strict cookie.
