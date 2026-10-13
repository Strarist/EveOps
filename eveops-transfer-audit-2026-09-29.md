# EveOps transfer audit — 2026-09-29

Diagnosis only. No features were implemented, no Git history was rewritten, and no database rows were inserted, updated, or deleted by this audit.

Labels used below mean:

- **Present and verified** — code or data was inspected on this Mac and a check in this audit succeeded.
- **Present but not working** — the artifact is on this Mac, and a check in this audit failed or the runtime path is blocked.
- **Partial** — some of the described behavior is in the files, and a required part is not.
- **Confirmed missing on this Mac** — not in this checkout, this working tree, or this local database. This does not prove the item is gone from the old laptop or from a backup.
- **Uncertain without old laptop/backup** — this Mac cannot show whether the item ever existed elsewhere.
- **Requested later, implementation unconfirmed** — would apply if the later UX work existed only as a prompt. It does not: that work is uncommitted in this working tree. See section 4.

## 1. Executive finding

This Mac has the GitHub `main` snapshot from **21 September 2026**, plus a large **uncommitted** working tree created after the clone. The 23 September priority, stall-registration, transfer, archive, and documentation handoff is **confirmed missing on this Mac** and is also absent from the current GitHub `main`. It is **uncertain without the old laptop or a backup** whether that work still exists somewhere else. It should not be called lost everywhere.

The later plain-language UI, ticket-detail activity, manager/staff alerts, and Web Push work is **present on this Mac only as uncommitted and untracked files**. It is not a commit, not a branch, and not on GitHub.

The local database is **not empty**. It is a local PostgreSQL `eveops` database on this Mac. It contains the demo event plus leftover integration-test events. It does **not** match the earlier “at least 26 tickets” snapshot. An empty or different local database would be a data-copy issue, not missing Git source. Here the source for the September 21 MVP is present, the September 23 feature set is absent from Git, and the database looks like a local seed plus later test residue rather than a restored Windows volume.

## 2. Project and Git identity

| Item | Evidence |
|---|---|
| Path | `/Users/arist/Work/EveOps` |
| Identity | Package name `eveops`. Web, API, worker, `packages/contracts`, `packages/operations`, Prisma. This is the EveOps repository. |
| Remote | `origin` `https://github.com/Strarist/EveOps.git` (no credentials in the URL) |
| Branch | `main`, tracking `origin/main` |
| HEAD | `582bfc6d59e5a67205da418dbe661c24d2c763f3` |
| HEAD date | 2026-09-21 22:57:26 +0530 |
| HEAD message | Ensure demo login accounts on API startup for pilot deploys. |
| Match to `main` | Local HEAD and the tracking ref are the same commit. `git rev-list --left-right --count origin/main...HEAD` was `0 0` against the locally stored remote ref. |
| Remote check | `git ls-remote origin refs/heads/* refs/tags/*` on this audit returned only `refs/heads/main` at `582bfc6d59e5a67205da418dbe661c24d2c763f3`. No tags. Remote comparison is current, not stale. |
| Reflog | One entry: `582bfc6 HEAD@{0}: clone: from https://github.com/Strarist/EveOps.git`. There is no local commit history from the old laptop. |
| Other Git state | No stashes, no tags, no extra worktrees, `git fsck --unreachable --no-reflogs` printed nothing. |
| Other copies | `/Users/arist/Work` contains only this EveOps tree plus unrelated portfolio folders. A full-disk search was not completed. |

Commit history on `main` (newest first):

- `582bfc6` Ensure demo login accounts on API startup for pilot deploys.
- `8323e6e` Default ALLOW_DEMO_SEED on Render so demo passwords stay in sync.
- `428acb8` Bootstrap empty production databases with demo login users.
- `ecb26ae` Add Render build/start helpers so API deploys include TypeScript types.
- `7a94bd7` Fix e2e routing isolation so leftover staff cannot steal assignments.
- `4dfaf90` Allow hall managers to verify stall OTP and reserve person IDs for Admin.
- `c6996e6` Fix Admin workforce create: require Hall and harden create UX.
- `e280269` Harden production-candidate MVP: masters forms, password rotation, and deploy guards.
- `d293151` Correct Stall-display / Staff-verify OTP flow and harden API boot.
- `f2f7e96` Harden residual audit findings: secret separation, safe routingWarning, db:deploy.
- `07dc55a` Initial EveOps MVP: ticket lifecycle, workforce identity, and harden pass.

Working tree, not committed (`git status --short`):

Tracked modifications:

- `apps/api/package.json`
- `apps/api/src/auth.ts`
- `apps/api/src/management.ts`
- `apps/api/src/notifications.ts`
- `apps/api/src/operations.integration.spec.ts`
- `apps/api/src/tickets.ts`
- `apps/api/src/workforce.ts`
- `apps/web/src/app/globals.css`
- `apps/web/src/components/role-views.tsx`
- `apps/worker/package.json`
- `apps/worker/src/main.ts`
- `e2e/operational.spec.ts`
- `package-lock.json`
- `packages/operations/src/index.ts`
- `prisma/schema.prisma`

Untracked:

- `apps/web/public/sw.js`
- `apps/web/src/app/staff/task/` (`page.tsx`)
- `apps/web/src/app/stall/ticket/` (`page.tsx`)
- `apps/web/src/lib/activity-copy.ts`
- `apps/web/src/lib/sounds.ts`
- `prisma/migrations/20260929160000_push_subscriptions/`

`git diff --stat` for tracked edits: 15 files, 944 insertions, 94 deletions.

Ignored but relevant: `.env`, `node_modules/`, `apps/api/dist/`, `apps/worker/dist/`, `apps/web/.next/`, `packages/*/dist/`, `test-results/`.

**Priority / registration changes from the 23 September handoff:** absent from HEAD, absent from the working tree, absent from GitHub `main`.

**Later notification and page-simplification work:** uncommitted. Tracked edits plus the untracked files above. Not on any commit.

## 3. Last known features vs current code

The “previous handoff” column is the 23 September claim. “HEAD” is commit `582bfc6`. “Working tree” is that commit plus uncommitted files on this Mac.

| Feature | Status | Evidence |
|---|---|---|
| Next.js web, Nest API, Prisma/PostgreSQL, worker, shared packages | **Present and verified** at HEAD and in the working tree | `apps/web`, `apps/api`, `apps/worker`, `packages/contracts`, `packages/operations`, `prisma/schema.prisma`. Production build in this audit completed. |
| Five roles: Stall, Staff, Hall Manager, Admin, SuperAdmin | **Present and verified** | Routes in `apps/web/src/proxy.ts`: `/stall`, `/staff`, `/hall-manager`, `/admin`, `/super-admin`. Pages under `apps/web/src/app/`. |
| Stall `servicePriority` HIGH / MEDIUM / LOW, default MEDIUM | **Confirmed missing on this Mac** | No `servicePriority` string in the repo. `Stall` in `prisma/schema.prisma` has `stallCode`, `exhibitorName`, `contact`, `active`. |
| Ticket priority snapshot HIGH → MEDIUM → LOW, then `createdAt`, then id, after manual override | **Confirmed missing on this Mac** | `enum TicketPriority` is `NORMAL` and `URGENT` only. `routeTicket` in `packages/operations/src/index.ts` orders the queue by `queuePriorityOverrideAt` (nulls last), then `createdAt`, then `id`. |
| Priority-aware routing across create and queue drain, without preempting assigned work | **Partial** | FIFO plus reasoned override is present in `routeTicket` (assigned work is not a transition source; only `NEW`, `QUEUED`, `REOPENED`). The HIGH/MEDIUM/LOW scheme is missing. |
| Pending-ticket priority change endpoint | **Partial** | `POST tickets/:id/prioritize` calls `TicketService.prioritizeQueued` at HEAD (`apps/api/src/tickets.ts`). It records a reasoned queue override. It does not set HIGH/MEDIUM/LOW. Covered by `operations.integration.spec.ts` at HEAD (`prioritizeQueued`). |
| Admin stall edit, exhibitor transfer, archive APIs | **Confirmed missing on this Mac** | `ManagementController` can `POST management/masters/:type` to create a hall, zone, or stall (`management.ts`). No stall patch, transfer, or archive route. Spec text in `04-rules-permissions.md` says not to hard-delete locations that tickets reference. There is no implementation of transfer or archive. |
| `/admin/registrations` and distinct route trees | **Partial** | Distinct role trees exist (`/admin`, `/stall`, `/staff`, `/hall-manager`, `/super-admin`, `/governance-access`, `/login`). There is no `/admin/registrations` page. Admin UI is one page with in-page sections in `role-views.tsx`. |
| Mobile management navigation | **Partial**, and the reachable phone nav is **uncommitted** | At HEAD, the narrow-screen CSS hid `.sidebar nav` and search inputs (`display: none`). The working tree makes the sidebar a sticky horizontal nav (`apps/web/src/app/globals.css`). Stall and staff still use `.bottom-nav`. |
| `docs/route-section-matrix.md` and `docs/priority-operations-notes.md` | **Confirmed missing on this Mac** | `docs/` contains only `pilot-runbook.md`, `harden-pass.md`, `mvp-completion-report.md`, `deep-runtime-audit.md`. Repo search found neither filename nor `servicePriority`. |
| Migration `20260923160000_stall_service_priority` | **Confirmed missing on this Mac** | Not in `prisma/migrations/`, not in the `_prisma_migrations` table. GitHub `main` has no commit after 21 September that could contain it. |
| Reported 71 unit/integration tests plus 18 E2E | **Partial** / count does not match the claim as written | Source files contain 16 unit tests (`domain.spec.ts`, `auth.spec.ts`), 37 integration tests (`operations.integration.spec.ts` 24, `workforce.integration.spec.ts` 13), and 18 E2E (`e2e/operational.spec.ts`). 16 + 37 + 18 = 71 test cases in total, not 71 unit/integration plus another 18 E2E. |
| Prior `eveops_test` database | **Confirmed missing on this Mac** | Local PostgreSQL lists only `eveops` among EveOps names. Integration specs use `PrismaService` and therefore `DATABASE_URL`, which points at `eveops`. |
| Previous `eveops` snapshot of ≥3 stalls and 26 tickets | **Uncertain without old laptop/backup** | This Mac’s `eveops` database has 3 stalls and 19 tickets, but 18 of those tickets belong to an event named `Integration event`, not the demo event. Demo event `Auto Expo 2026` has 1 ticket. See section 5. |
| Open work on stall B203 blocking a transfer walkthrough | **Present and verified** as data; the transfer feature is **Confirmed missing on this Mac** | B203 is active and has ticket `EV-00001`, status `ASSIGNED`, category `ELECTRICAL`, priority `URGENT`. There is no transfer API to walk through. |

Other references: `node_modules` is installed. `exports/` exists and is empty. No `uploads/` directory. No source file points at a deleted path for the missing September 23 features; those symbols are simply not referenced.

Routing order that **is** present (`packages/operations/src/index.ts`, `routeTicket`):

1. Compatible on-duty staff under capacity, least load, then longest-waiting availability, then user id.
2. Waiting ticket chosen by override timestamp, then `createdAt`, then id.
3. Statuses that can be assigned: `NEW`, `QUEUED`, `REOPENED`. An already assigned ticket is not taken back by this function.

Existing notification stack at HEAD, still present in the working tree:

- Prisma models `Notification`, `OutboxEvent`, `TicketEvent`.
- `createLifecycleNotifications` in `apps/api/src/tickets.ts`.
- SSE `GET tickets/stream/live` (`tickets.ts`, `realtime.ts`).
- Client `subscribeRealtime` in `apps/web/src/lib/api-client.ts`.
- Worker `processOutbox` in `apps/worker/src/main.ts`.

## 4. Later requested UX and notification work

The later phase was a request after the 23 September handoff (plain language, responsive layout, activity inside ticket detail, manager alerts on create/reopen, staff assignment sound, Web Push). On this Mac it is **uncommitted local work**, not merely a prompt.

| Requested item | Status | Evidence |
|---|---|---|
| Staff plain language | **Partial**, uncommitted | `statusLabelFor` in `apps/web/src/components/role-views.tsx` maps staff `ASSIGNED` → “New task”, `ACCEPTED` → “Accepted — go to stall”, `IN_PROGRESS` → “Work in progress”, `AWAITING_OTP` → “Waiting for stall's code”, `REOPENED` → “Task opened again”. Buttons include “Accept task” and “10 min later”. Manager-facing maps still say “Awaiting OTP” and “New assignment”. |
| Responsive layout, phone nav | **Partial**, uncommitted | Bottom nav for stall/staff. Management nav is no longer `display: none` under the mobile breakpoint. Desktop sidebar remains. This audit did not re-measure every viewport. |
| Activity inside ticket detail, not on every list | **Partial**, uncommitted | `TicketActivity` loads `GET /api/tickets/:id/activity` and renders `activitySentence` (`apps/web/src/lib/activity-copy.ts`). Routes `apps/web/src/app/staff/task/[id]/page.tsx` and `apps/web/src/app/stall/ticket/[id]/page.tsx` are untracked. List cards do not render the event feed. The management ticket drawer still contains a closed `<details>Activity` block. The management Audit section still prints `eventType` with underscores replaced by spaces. |
| Manager alert on create and reopen | **Partial**, uncommitted | Ticket create notifies the stall user and hall managers of that hall, with summary text “New request · Stall …”. Reopen uses “Ticket opened again · Stall …”. Admin and SuperAdmin are not in that recipient query. A toast in `ManagementWorkspace` can show an unread create/reopen row. Hall managers still also receive other lifecycle types from `createLifecycleNotifications`. |
| Staff assignment alert and ringtone | **Partial**, uncommitted | `apps/web/src/lib/sounds.ts` `playRepeatAlert` (default 20 seconds). Staff workspace shows a banner with View task, Silence, Accept task, and 10 min later. Sound is a generated tone, gated by an explicit enable action. |
| Web Push / service worker | **Partial**, uncommitted, **Present but not working** for lint | `PushSubscription` is in the working-tree schema and in untracked migration `20260929160000_push_subscriptions`, which **is applied** on this Mac’s database. API routes `GET notifications/push-config`, `POST` and `DELETE notifications/push-subscription`. Worker `deliverPushes` in `apps/worker/src/main.ts`. `apps/web/public/sw.js` shows a visible notification and focuses a URL. Zero rows in `PushSubscription`. `npm run lint` fails on `sw.js` (`self` is not defined). |
| Docs and route matrix from the request | **Confirmed missing on this Mac** | No `docs/route-section-matrix.md`. |

This later work is one dirty tree mixed with other uncommitted edits in `management.ts` (metrics/command panels) and `role-views.tsx`. None of it is on `582bfc6`.

## 5. Local data and configuration

### Environment files

Only `.env` and `.env.example` were found. `.env` is gitignored, 759 bytes. Names and whether a value is present. No values are printed.

| Name | In `.env` | In `.env.example` | Notes from parsing, without secrets |
|---|---|---|---|
| `DATABASE_URL` | set | listed | `postgresql`, host `localhost`, port `55432`, database name `eveops`, user set, password set, query key `schema` |
| `REDIS_URL` | set | listed | `redis`, host `localhost`, port `6379`, no username, no password, no database path |
| `SESSION_SECRET` | set, length 39 | listed | Not equal to the OTP secret |
| `OTP_ENCRYPTION_SECRET` | set, length 39 | listed | Not equal to the session secret |
| `API_URL` | set | listed | `http`, `localhost`, port `4000`, path `/api` |
| `NEXT_PUBLIC_API_URL` | set | listed | same host and path as `API_URL` |
| `WEB_ORIGIN` | set | listed | `http`, `localhost`, port `3000`, path empty |
| `COOKIE_SECURE` | set | listed | value `false` |
| `MAX_EXPORT_ROWS` | set | listed | present |
| `BUILD_SHA` | set, length 11 | listed | present |
| `VAPID_PUBLIC_KEY` | set | **not in example** | present |
| `VAPID_PRIVATE_KEY` | set | **not in example** | present |
| `VAPID_SUBJECT` | set | **not in example** | starts with `mailto:` |

`WEB_ORIGIN` names port 3000. During this audit, port 3001 accepted a connection and port 4000 accepted a connection. Port 3000 was not treated as the EveOps origin for this report.

### PostgreSQL

- Reachable on this Mac: TCP `localhost:55432` open.
- Cluster database list matching `eve%`: only `eveops`. **`eveops_test` is confirmed missing on this Mac.**
- Host category: local.
- Applied migrations (all `finished`): the 14 migrations from `20260908115752_init` through `20260910180000_must_change_password`, plus `20260929160000_push_subscriptions`. The September 23 service-priority migration is not applied.

Counts (read-only):

| Item | Count |
|---|---|
| Events | 3 |
| Halls | 3 |
| Zones | 2 |
| Stalls | 3 |
| Users | 12 |
| Users whose email ends with `@eveops.test` | 6 |
| Assignments | 16 |
| Tickets | 19 |
| Ticket events (audit rows on tickets) | 69 |
| Notifications | 132 |
| Push subscriptions | 0 |
| Outbox events | 61 |
| Management audits | 0 |
| Export jobs | 0 |

Users by role: ADMIN 2, HALL_MANAGER 2, STAFF 4, STALL 2, SUPER_ADMIN 2.

Tickets by status: ASSIGNED 8, ACCEPTED 1, CLOSED 6, COMPLAINT_RAISED 2, ESCALATED 1, QUEUED 1.

Tickets by event name:

| Event | Status | Tickets |
|---|---|---|
| Auto Expo 2026 | ACTIVE | 1 |
| Integration event | ACTIVE | 18 |
| Other event | ACTIVE | 0 |

Organizations: 2. One name is `Nexus Exhibitions`. The other name starts with `integration-`. That second organization and the events named `Integration event` and `Other event` are leftover rows from integration tests that used this same database. They are not evidence of the old laptop’s demo dataset.

Stalls (code, active, ticket count only):

| Stall code | Active | Tickets |
|---|---|---|
| B203 | true | 1 (`EV-00001`, ASSIGNED, ELECTRICAL, URGENT) |
| S1 | true | 18 |
| S2 | true | 0 |

B203’s single ticket is the demo event ticket. S1 and S2 sit with the integration event, not with a second copy of a 26-ticket demo history.

Notification types present: SLA_BREACHED 72, TICKET_ASSIGNED 17, TICKET_CLOSED 11, TICKET_ACCEPTED 8, TICKET_IN_PROGRESS 6, TICKET_AWAITING_OTP 6, TICKET_CREATED 4, ASSIGNMENT_RESPONSE_OVERDUE 4, COMPLAINT_RAISED 2, TICKET_REOPENED 1, TICKET_ESCALATED 1.

### Redis

`REDIS_URL` points at local port 6379. That port was **closed** during this audit. Application TypeScript does not read `REDIS_URL`. Mentions are `.env.example`, `README.md`, `01-product-plan.md`, and `docker-compose.yml`. No cafe project is in `/Users/arist/Work`. This audit did not prove a historical collision with another project’s Redis. Current state: the variable is set, the process is not running, and EveOps code does not use it.

### Files and browser state

- `exports/` is empty. Export jobs: 0. No missing files to match.
- No uploads directory.
- Push subscription rows: 0. A new browser must grant permission and register again even when VAPID keys exist. Lock-screen delivery was not tested.
- Demo login fixtures are defined in `prisma/seed.ts` and 6 `@eveops.test` users exist. Passwords are not recorded here.
- Local requirements already on disk: `.env`, `node_modules`, generated `dist` and `.next` folders, Homebrew-style PostgreSQL on port 55432. VAPID keys exist only in `.env`.

This database being different from the 26-ticket claim is a **local data migration issue**. It is not evidence that Git source for the September 21 MVP failed to transfer.

## 6. Verification results

Run from `/Users/arist/Work/EveOps` unless noted. Integration and E2E were **not** run. They write fixture rows into `DATABASE_URL` (`eveops` on this Mac). `eveops_test` does not exist, and the current database already contains an integration fixture. Running them would change local data.

| Command | Result |
|---|---|
| `npm run typecheck` | Exit 0. Contracts, operations, API, worker, web, and `tsconfig.e2e.json`. |
| `npm run lint` | Exit 1. Five errors, all in `apps/web/public/sw.js`: `'self' is not defined` (`no-undef`) at lines 1, 8, 15, 18, and 22. |
| Unit tests | Exit 0. From `apps/api`, using `apps/api/jest.config.cjs`: `--testPathPatterns='domain.spec\|auth.spec'`. **2 suites, 16 tests passed.** |
| `npm run build` | Exit 0. Contracts, operations, Nest API, worker, Next.js 16.3.4 web. Routes include `/staff/task/[id]` and `/stall/ticket/[id]`. |
| Integration (`operations` 24 + `workforce` 13) | **Not run.** Blocker: no isolated test database. They target `eveops`. |
| `npx playwright test` | **Not run** in this audit. Same isolation blocker, and Playwright would also need `E2E_BASE_URL` if the web app is not on port 3000. |
| A first attempt `npm test -w @eveops/api -- --testPathPattern=...` | Exit 1 before any test ran. Jest 30 rejected `testPathPattern`. This was a command error, not a product failure. The later `--testPathPatterns` run passed. |

Classification:

- September 23 priority and registration source: **source code missing** on this Mac and on GitHub `main`.
- Dependencies: **present** (`node_modules` exists; build and typecheck used them).
- PostgreSQL: **running** locally. Contents are a local dataset, not the claimed 26-ticket snapshot.
- `eveops_test`: **database absent** on this Mac.
- Redis: **service not running**; also unused by app code.
- `sw.js` lint: **real lint failure** in uncommitted later work, not a missing transfer of the September 21 tree.
- Uncommitted UX/notification work: present as files. Browser behavior was not re-tested in this audit.

## 7. Missing or at-risk items

### P0

1. **23 September stall service priority, transfer, archive, `/admin/registrations`, and the two docs are confirmed missing on this Mac.** They are also absent from GitHub `main` (`582bfc6`, 21 September). Confidence high for this Mac and for GitHub. Whether the old laptop still has them is **uncertain without the old laptop or a backup**. Do not describe them as globally lost.
2. **The later UX, activity, alert, and push work exists only as uncommitted files in `/Users/arist/Work/EveOps`.** Confidence high. `git clean`, a fresh clone, or copying only committed Git will drop it. It is not on `origin/main`.

### P1

1. **Local `eveops` is not the reported 26-ticket database.** Confidence high about the current counts (19 tickets, 1 of them on Auto Expo 2026). Confidence low that the other tickets were destroyed; they may never have been copied. **Uncertain without a Windows dump.**
2. **`eveops_test` is confirmed missing on this Mac.** Integration tests share the demo database and have already left `Integration event` (18 tickets) and an `integration-…` organization. Confidence high.
3. **`WEB_ORIGIN` is port 3000 while a listener was on 3001.** Risk of hitting a different local site or a mismatched cookie origin. Confidence high about the parsed URL and the open ports.
4. **`npm run lint` fails on `apps/web/public/sw.js`.** The file is present and fails ESLint. Confidence high.
5. **VAPID private key lives only in gitignored `.env`.** A clone will not have it. Confidence high.

### P2

1. Redis is configured and stopped, and the app does not use it. Confidence high that current source ignores it.
2. Push subscriptions are zero. Expected until this browser registers. Not evidence of lost users from Windows.
3. `exports/` and management-audit rows are empty. No missing file set to repair.
4. Management Audit still shows raw event codes. That is unfinished presentation in the uncommitted UI, not a deleted audit table. Ticket events: 69 rows.

## 8. Recovery sources

| Source | What it can recover | Evidence |
|---|---|---|
| GitHub `main` `582bfc6d59e5a67205da418dbe661c24d2c763f3` | September 21 MVP only | `git ls-remote` during this audit. Only that branch and no tags. |
| This working tree | The uncommitted UX, alerts, push migration, and management-panel edits | `git status` and the untracked paths in section 2. This is the only copy evidenced. |
| This Mac’s PostgreSQL data directory for `eveops` on port 55432 | Current local demo ticket `EV-00001` and the integration residue | Counts in section 5. Not a 26-ticket history. |
| `.env` on this Mac | Local secrets and VAPID keys | File present, gitignored. |
| Stash, reflog, other worktrees, other EveOps folders under `/Users/arist/Work` | Nothing additional | Reflog is clone-only. Those stores are empty or absent. |
| Old Windows laptop, an unpushed branch, or a database dump | The only plausible place for the 23 September priority/registration work and the earlier 26-ticket snapshot | Those objects are not on GitHub and not in this checkout. **Uncertain until that machine or a dump is inspected.** |

## 9. Safe recovery plan

Do not execute these during the audit. Take a backup before any step that writes Git or the database.

1. **Copy the working tree, including untracked files and `.env`, to a second disk or archive.** Prerequisite: none. This protects the only evidenced copy of the later UX/notification work. Do not `git clean`, `git reset`, or `git checkout` over the dirty tree first.
2. **Optionally commit that work on a new local branch after the copy exists.** Prerequisite: the backup from step 1. Do not push secrets. Confirm `.env` stays ignored.
3. **Ask the old laptop for a branch list, `git log`, and a search for `servicePriority` and `20260923160000`.** Prerequisite: laptop access. If those commits exist only there, copy the repo with a bundle or patch. Do not force-push over GitHub `main`.
4. **If the 26-ticket dataset matters, dump it on the old machine (`pg_dump`) and keep this Mac’s `eveops` untouched until the dump is compared.** Prerequisite: old database credentials and a stated target. Restoring over this Mac’s `eveops` would replace `EV-00001` and the integration residue. Backup this Mac’s database first if any restore is chosen.
5. **Create an isolated test database before the next integration or E2E run.** Prerequisite: a new empty database, not `eveops`. Point only the test command at it. Do not point tests at the demo database again if the integration rows should stay distinguishable.
6. **Decide `WEB_ORIGIN` against the port that is actually serving EveOps** before the next browser session. Prerequisite: know which process owns 3000 and 3001. This does not require a database change.
7. **Lint and push notification registration** can wait until the uncommitted branch is kept. Service-worker lint is a code fix, not a transfer repair. Push endpoints must be created again on this browser; do not copy browser permission state.

## 10. Information still required

This inspection cannot answer:

1. Can the old Windows laptop be opened, and does its EveOps repo contain commits after `582bfc6` or a branch that is not on GitHub?
2. Is there a `pg_dump`, Docker volume, or other backup of the database that had about 26 tickets?
3. Was `20260923160000_stall_service_priority` ever committed on that laptop, or only edited in a working tree that was not pushed?
4. Which directory on the old laptop was the last-working copy, if it was not `Strarist/EveOps` `main`?

No other question is required to trust the findings about **this Mac**.
