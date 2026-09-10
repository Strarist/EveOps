# EveOps final MVP completion report

Date: 10 September 2026  
Previous deep-runtime gate: conditional YES  
This pass: **MVP completion remediation**

Authoritative product sources used: repository-root `01-product-plan.md`, `02-workflow.md`, `03-ui-ux-spec.md`, `04-rules-permissions.md`, and `docs/deep-runtime-audit.md`. The requested `docs/expoops/*` paths do not exist in this repository.

## 1. Remaining defects found in this pass

| Defect | Evidence | Severity | Fix |
|---|---|---|---|
| Staff action buttons appeared blank | `.ticket-actions button` forced white background while `.primary` forced white text | P0 UX | Contrast CSS for primary/secondary action buttons |
| Ticket age shown as `229m` | Frontend truncated total minutes only | P1 | Humanized age: `45s`, `07m`, `1h 12m`, `1d 3h` from server `createdAt` |
| Staff label “Confirm completion” / “Request closure” | Status and action copy mismatched stall-OTP ownership | P0 product | Stall status `Awaiting stall OTP`; Staff action `Request completion` |
| Availability 400 / false failure | Missing validated DTO; routing errors after PAUSED→ON_DUTY could fail the whole request after availability already changed | P0 | `AvailabilityDto` + best-effort routing + clearer client errors |
| Lifecycle milestones stayed “pending” | Drawer used only `/management/timing`; ignored ticket detail timestamps | P0 | Fall back to ticket `createdAt` / `firstAssignedAt` / `firstAcceptedAt` / `firstStartedAt` / `completionRequestedAt` / `closedAt` |
| No operational user creation UI/API | Seed-only identities | P0 MVP | Workforce people create/update/deactivate with RBAC + audit |
| Person age vs ticket age confusion | Product risk | Spec | **No person-age field.** Ticket age remains server-derived and non-editable |
| OTP verify throttle too low for suite/event | E2E duplicate verify hit 429 after earlier scenarios | P1 | Verify limit raised to 20/min |
| Hall Manager 403 on management APIs | Not reproducible on the restored stack with seeded HM scope; APIs already role/scope-aware | Cleared | Confirmed 200 for metrics/timing/workforce/exceptions/audit for Hall Manager |

## 2. User / ID management implementation

- Public operational ID: `User.employeeCode` (unique, optional, not the DB primary key).
- Account status: `ACTIVE` / `DISABLED` (no hard delete).
- APIs:
  - `POST /api/workforce/people`
  - `GET /api/workforce/people/:id`
  - `PATCH /api/workforce/people/:id`
  - enriched `GET /api/workforce`
- Management UI: Workforce → **Add person**, edit capacity, activate/deactivate.
- Append-only `ManagementAudit` for `USER_CREATED`, `USER_UPDATED`, `USER_DEACTIVATED`, `CAPACITY_CHANGED`, `SCOPE_CHANGED`.

## 3. User permission matrix (enforced server-side)

| Actor | Can create/manage | Cannot |
|---|---|---|
| Hall Manager | STAFF in own hall(s), capacity/status within hall | ADMIN, SUPER_ADMIN, HALL_MANAGER, other halls |
| Admin | STAFF, HALL_MANAGER in authorized event(s) | SUPER_ADMIN |
| SuperAdmin | ADMIN and below across authorized org/events | (governance portal only) |
| Staff / Stall | own availability / own tickets | any identity management |

## 4. Ticket age vs person age

- **Ticket age** = `now - ticket.createdAt`, server timestamps only, never editable, display-only formatting.
- **Person age** is not an MVP operational field. Public employee code + name/phone/email/role/scope/capacity are used instead.

## 5. Staff workflow completion

Staff path now supports and labels:

ASSIGNED → Accept / Snooze 10 min  
ACCEPTED → Start work  
IN_PROGRESS → Request completion  
AWAITING_OTP → waiting for stall (no self-close)  
CLOSED → capacity freed, history/completed counters update

## 6. OTP implementation

- Generated atomically on transition to `AWAITING_OTP`
- Stall-only present/verify
- Wrong OTP → 400 controlled error
- Expired → regenerate path
- Closed ticket verify is idempotent
- Stall UI: show code + mandatory 6-digit entry + Verify completion + report problem

## 7. Hall Manager 403 root cause / fix

- Root cause on the restored local stack was not an authorization matrix bug for scoped management reads.
- Seeded Hall Manager receives 200 for metrics, timing, workforce, exceptions, audit.
- Ping/reassign validated in E2E with audit/notification evidence.
- Milestone “pending” inconsistency was fixed by timestamp fallback, not by widening Admin rights.

## 8. Availability 400 root cause / fix

- Contract hardened with `AvailabilityDto` (`ON_DUTY` | `PAUSED` | `OFF_DUTY`).
- Empty memberships rejected with clear 400.
- ON_DUTY queue drain is best-effort so routing exceptions no longer look like availability failure.
- PAUSED keeps active work and blocks new routing (E2E covered).

## 9. Realtime propagation verification

Covered by existing + extended Playwright scenarios:

- Staff Accept → AWAITING_OTP → Stall OTP UI
- Closure → Staff active=0, completed≥1, history contains ticket
- Manager timing has assigned/closed timestamps
- Admin detail CLOSED with milestone fields present
- Cross-role visibility after offline reconciliation

## 10. Tests added

- `apps/api/src/workforce.integration.spec.ts` (identity RBAC, availability DTO, deactivation)
- Playwright scenarios 11–14:
  - Hall Manager creates/deactivates House Help worker
  - House Help OTP close + capacity free + duplicate verify
  - Ping + reassign history
  - Availability pause keeps active work / queues new work

## 11. Playwright results

**14/14 passed**

## 12. Build / typecheck / lint / load

| Gate | Result |
|---|---|
| Jest | 45 passed |
| Playwright | 14 passed |
| Typecheck | passed |
| Lint | passed |
| Migration preflight | passed (incl. documented user_management reconciliation) |
| Production build | passed |
| Load smoke | 93 requests, 0 failures, p95 123 ms |

## 13. Remaining MVP limitations

- Stall identity creation UI does not yet include a stall picker (API supports STALL role; HM UI creates STAFF).
- External SMS/WhatsApp OTP delivery remains out of MVP; OTP is stall-session presented.
- Venue-scale load, HTTPS/proxy production validation, backup/restore rehearsal remain untested outside this repo.
- Person date-of-birth/age intentionally omitted.

## 14. Pilot readiness

**YES — controlled local MVP gate.**

A manager can create operational people, a stall can raise a ticket, the compatible worker can accept/start/request completion, the stall can verify OTP, capacity frees for FIFO, and Hall Manager/Admin projections reflect the same authoritative lifecycle.
