**ExpoOps**

**MVP Product & Delivery Plan**

Scope, architecture, modules, data model, delivery phases and acceptance
criteria

**MVP v1.1 \| Exhibition Operations & Stall Service Management**

8 September 2026

| Working title: ExpoOps. The name is intentionally replaceable; the operating model is the deliverable. |
|--------------------------------------------------------------------------------------------------------|

# Document purpose

Defines what should be built in the first production-ready MVP, why each
module exists, how the system is structured, and the order in which the
engineering team should implement it.

**Primary audience:** Founder/product owner, engineering lead,
backend/frontend developers, QA, exhibition operations leadership.

| **MVP PRINCIPLE:** Prefer a smaller number of deterministic workflows over a large number of configurable features. Every action that changes ticket ownership or status must be timestamped and auditable. |
|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 1. Product objective

Create a live service-management platform that connects exhibitor stalls
with on-ground operations across multiple halls and zones. The MVP
should replace fragmented calls, walkie-talkie follow-ups and manual
complaint logs with one traceable ticket lifecycle.

| **Objective**            | **MVP outcome**                                                                                                                      |
|--------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| Fast service request     | A stall can raise a correctly routed ticket in less than one minute.                                                                 |
| Operational control      | Hall managers and admins see demand, ownership, delays and exceptions in real time.                                                  |
| Accountable closure      | A ticket cannot be marked complete without the stall-side OTP, except through an explicitly audited override.                        |
| Fair queueing            | Waiting work is allocated FIFO within the correct service pool when staff capacity is exhausted.                                     |
| Management visibility    | Admin and SuperAdmin can filter, audit and export complete service history.                                                          |
| Measurable service cycle | Admin can see every ticket-stage timestamp and the duration between stages, with SLA/exception highlighting and export-ready values. |

# 2. Physical and organizational hierarchy

| **Level**    | **Example**                          | **Meaning**                                         |
|--------------|--------------------------------------|-----------------------------------------------------|
| Organization | Nexus Exhibitions                    | Company operating one or more expos.                |
| Event / Expo | Auto Expo 2026                       | A specific exhibition edition with dates and venue. |
| Hall         | Hall 1, Hall 2, Hall 3               | Major venue subdivision.                            |
| Zone         | A, B, C                              | Operational subdivision inside a hall.              |
| Stall        | A102, B203                           | Exhibitor service endpoint.                         |
| Service Pool | Electrical, House Help, Hall Manager | Staff group eligible to receive a ticket type.      |

| **DATA RULE:** Every operational record must carry event_id. Hall, zone and stall IDs are immutable references during the event so reports remain historically accurate even if display labels are edited. |
|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 3. MVP personas

| **Persona**   | **Primary job in system**                                              | **Primary device**                |
|---------------|------------------------------------------------------------------------|-----------------------------------|
| Stall user    | Raise, track, confirm completion, complain/escalate                    | Mobile-first web/PWA or tablet    |
| Service staff | Receive, accept, work and request closure of assigned tickets          | Mobile-first simplified interface |
| Hall manager  | Monitor all hall tickets, intervene, reassign/reopen, ping staff       | Tablet / desktop / mobile         |
| Admin         | Operate event, manage masters, users, queues, exceptions and analytics | Desktop-first                     |
| SuperAdmin    | Cross-event governance, complete reporting, configuration and exports  | Desktop-first                     |

# 4. MVP functional scope

| **Module**                    | **Must-have capabilities**                                                                                |
|-------------------------------|-----------------------------------------------------------------------------------------------------------|
| Authentication & role binding | Login, session management, role, event scope, hall/service scope, stall binding.                          |
| Master data                   | Events, halls, zones, stalls, service categories, staff, hall managers.                                   |
| Ticketing                     | Create, classify, prioritize, assign, accept, snooze, start, resolve, OTP close, reopen, cancel.          |
| Queue engine                  | Eligible-pool routing, availability tracking, FIFO waiting queue, reassignment after non-response.        |
| Notifications                 | In-app real-time alerts; push/SMS/WhatsApp can be adapters but are not required for MVP core.             |
| Complaint/escalation          | Unsatisfied completion, complaint reason, reopen, manager/admin escalation.                               |
| Dashboards                    | Role-specific live queues and KPI summaries.                                                              |
| Audit log                     | Append-only timeline for every status, assignee, OTP, reopen and override action.                         |
| Reports & exports             | Filterable tables and CSV/XLSX/PDF export for SuperAdmin; CSV/XLSX sufficient as implementation baseline. |

# 5. Explicitly out of scope for MVP

- Vendor billing, invoicing, payment collection or service charge
  settlement.

- Inventory/spares consumption management beyond an optional free-text
  work note.

- AI-based routing, forecasting or auto-prioritization.

- Native iOS/Android applications; a responsive web app/PWA is
  sufficient.

- Complex workforce shift planning and payroll.

- Public exhibitor onboarding marketplace or visitor-facing features.

- Multi-language support beyond keeping UI text architecture
  localization-ready.

# 6. Ticket taxonomy for v1

| **Category** | **Subtype** | **Default pool** | **Notes**                                                                                          |
|--------------|-------------|------------------|----------------------------------------------------------------------------------------------------|
| Electrical   | NCP         | Electrical staff | Preserve “NCP” as supplied business terminology; define its operational meaning during onboarding. |
| Electrical   | Lighting    | Electrical staff | Lighting/power-related support.                                                                    |
| House Help   | General     | House-help staff | Cleaning/support request.                                                                          |
| Hall Manager | General     | Hall manager     | Direct managerial assistance; may not require field-staff assignment.                              |

# 7. Core ticket state model

| **State**        | **Meaning**                                                     | **Next normal states**          |
|------------------|-----------------------------------------------------------------|---------------------------------|
| NEW              | Created and validated; routing pending                          | ASSIGNED, QUEUED, CANCELLED     |
| ASSIGNED         | Owned by an eligible staff member                               | ACCEPTED, SNOOZED, REASSIGNED   |
| SNOOZED          | Staff deferred response for the fixed 10-minute response window | ACCEPTED, REASSIGNED, ESCALATED |
| QUEUED           | No eligible staff currently free                                | ASSIGNED, CANCELLED             |
| ACCEPTED         | Staff acknowledged responsibility                               | IN_PROGRESS, REASSIGNED         |
| IN_PROGRESS      | Work has started                                                | AWAITING_OTP, ESCALATED         |
| AWAITING_OTP     | Staff claims work complete; stall displays OTP for Staff entry  | CLOSED, COMPLAINT_RAISED        |
| CLOSED           | Stall-supplied OTP entered by Staff; ticket completed           | REOPENED                        |
| COMPLAINT_RAISED | Stall is not satisfied                                          | REOPENED, ESCALATED             |
| REOPENED         | Manager/Admin has returned the ticket to active work            | ASSIGNED, QUEUED                |
| ESCALATED        | Exception requiring managerial/admin attention                  | ASSIGNED, REOPENED, CLOSED      |
| CANCELLED        | Request withdrawn or invalid                                    | Terminal                        |

# 8. Assignment engine

1\. Derive the service pool from ticket category/subtype and event/hall
scope.

2\. Find eligible staff who are on duty, not paused/offline and below
the configured active-ticket cap.

3\. If one or more are available, assign using least-active-load, then
longest-idle as tie-breaker. Record assignment timestamp.

4\. If nobody is available, place the ticket in the pool queue ordered
by created_at ascending (FIFO).

5\. When a staff member becomes available, assign the oldest eligible
waiting ticket automatically.

6\. An assigned staff member may accept immediately or snooze the alert
for exactly 10 minutes. Snooze does not erase ownership or the response
timer.

7\. If the 10-minute response deadline expires without acceptance, alert
Hall Manager + Admin and mark the assignment as response_overdue. The
manager/admin can reassign; the engine may auto-reassign when
configured.

| **RECOMMENDED MVP BEHAVIOR:** Do not let staff permanently reject tickets. “Snooze 10 min” is a controlled deferral. Rejection/transfer should require a reason and manager/admin action, preventing cherry-picking of easy tasks. |
|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 9. OTP closure model

- **Generation -** When staff taps “Work completed”, generate a
  short-lived numeric OTP tied to that ticket and stall.

- **Verification -** Stall displays the OTP on their authenticated
  interface and verbally shares it only after checking the work. The
  assigned Staff enters the OTP; successful verification records
  verified_by (Staff), timestamp and attempt count. Staff must never
  receive the OTP value from the system.

- **Expiry -** OTP should expire after a configurable short period
  (recommended 10 minutes) and be regenerable with rate limits.

- **No sharing in logs -** Store only a secure hash or protected
  representation of OTP; never expose the OTP in admin exports or audit
  logs.

- **Override -** Admin/SuperAdmin emergency closure is permitted only
  with reason, actor, timestamp and an OVERRIDE_CLOSED audit event.

# 10. Suggested technical architecture

| **Layer**       | **MVP recommendation**                              | **Reason**                                                                            |
|-----------------|-----------------------------------------------------|---------------------------------------------------------------------------------------|
| Client          | Responsive Next.js/React web app or equivalent PWA  | One codebase, fast role-specific UI, mobile usability for stalls/staff.               |
| API             | REST API with WebSocket/SSE channel for live events | REST for deterministic actions; realtime channel for alerts/status changes.           |
| Backend         | Modular monolith                                    | Simpler MVP deployment while preserving module boundaries.                            |
| Database        | PostgreSQL                                          | Strong transactions for ticket state, assignment and audit history.                   |
| Queue/cache     | Redis optional but recommended                      | Presence, short locks, notification fan-out, rate limits; DB remains source of truth. |
| Background jobs | Lightweight worker/queue                            | Escalation timers, OTP expiry, queued assignments, export generation.                 |
| Storage         | Object storage                                      | Generated reports and optional ticket attachments later.                              |
| Observability   | Structured logs + error tracking + basic metrics    | Operations software must expose failures quickly during a live expo.                  |

# 11. Minimum data model

| **Entity**           | **Key fields**                                                                                                                                                                                                                              |
|----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Event                | id, name, venue, starts_at, ends_at, status                                                                                                                                                                                                 |
| Hall                 | id, event_id, code, name                                                                                                                                                                                                                    |
| Zone                 | id, hall_id, code                                                                                                                                                                                                                           |
| Stall                | id, zone_id, stall_code, exhibitor_name, contact, service_priority (HIGH/MEDIUM/LOW, default MEDIUM), active, archived_at                                                                                                                  |
| User                 | id, name, phone/email, role, status                                                                                                                                                                                                         |
| UserScope            | user_id, event_id, hall_id?, stall_id?, service_type?                                                                                                                                                                                       |
| Ticket               | id, public_no, event_id, hall_id, zone_id, stall_id, category, subtype, priority, service_priority snapshot, status, created_by, created_at, queued_at?, first_assigned_at?, first_accepted_at?, first_started_at?, completion_requested_at?, closed_at?, reopen_count |
| Assignment           | id, ticket_id, staff_id, assigned_at, accepted_at, started_at?, snoozed_until, completion_requested_at?, released_at, release_reason                                                                                                        |
| TicketEvent          | id, ticket_id, event_type, actor_id, from_status, to_status, metadata_json, created_at                                                                                                                                                      |
| OTPChallenge         | id, ticket_id, otp_hash, expires_at, attempts, verified_at, verified_by                                                                                                                                                                     |
| Complaint            | id, ticket_id, reason_code, comment, created_by, created_at, resolution                                                                                                                                                                     |
| Notification         | id, recipient_id, ticket_id, type, read_at, sent_at                                                                                                                                                                                         |
| TicketTimingSnapshot | Derived/query model: raise_to_assign, assign_to_accept, accept_to_start, start_to_completion_request, otp_wait, total_resolution, queue_wait, active_work_time; values calculated from authoritative timestamps.                            |

# 12. Dashboard KPIs

| **Role**     | **Top KPIs**                                                                                                                                                                                   |
|--------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Hall Manager | Open now, queued, response overdue, escalated, avg response time, avg resolution time, staff load.                                                                                             |
| Admin        | All hall KPIs, category backlog, reopened %, complaint %, SLA breaches, staff utilization, closure throughput, avg/median/P90 stage durations, oldest unassigned/accepted/in-progress tickets. |
| SuperAdmin   | Cross-event totals/trends, event comparison, hall/service performance, unresolved exceptions, stage-duration benchmarks, export center.                                                        |

## 12.1 Admin timing and duration analytics

Every meaningful ticket-stage change is server-timestamped. Admin must
be able to inspect the exact timestamp and elapsed duration for the full
service cycle from ticket creation to final closure. SuperAdmin inherits
the same visibility across authorized events.

| Stage / metric                     | Calculation                                                        | Admin presentation                                                 |
|------------------------------------|--------------------------------------------------------------------|--------------------------------------------------------------------|
| Ticket raised                      | created_at                                                         | Exact date/time + live ticket age                                  |
| Raise -\> assignment               | first_assigned_at - created_at                                     | Dispatch delay; show queue contribution separately when applicable |
| Assignment -\> acceptance          | accepted_at - assigned_at                                          | Staff response duration; highlight response SLA breach             |
| Acceptance -\> work start          | started_at - accepted_at                                           | Mobilization delay                                                 |
| Work start -\> completion request  | completion_requested_at - started_at                               | Active work duration                                               |
| Completion request -\> OTP closure | closed_at - completion_requested_at                                | OTP/customer confirmation wait                                     |
| Raise -\> final closure            | closed_at - created_at                                             | Total resolution duration                                          |
| Reopened tickets                   | Each work cycle retained separately + total across ticket lifetime | Cycle-by-cycle timeline and cumulative duration                    |

Dashboard and export rules: durations must support sort/filter by
threshold, SLA status, hall, zone, service, assignee and date range.
Store authoritative timestamps; derive durations in seconds/minutes for
analytics and display a human-readable value in the UI.

# 13. Delivery plan

| **Phase**                   | **Build focus**                                                                            | **Exit criterion**                                                                                                                    |
|-----------------------------|--------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| 0 - Foundation              | Auth, roles/scopes, event-hall-zone-stall masters, audit framework                         | Users can log in and only see allowed operational scope.                                                                              |
| 1 - Ticket core             | Create ticket, taxonomy, status engine, stall tracking                                     | Stall can create and view an auditable ticket.                                                                                        |
| 2 - Workforce routing       | Staff availability, assignment, FIFO queue, accept/snooze, timers                          | Tickets reliably reach the correct staff pool and queue.                                                                              |
| 3 - Completion & exceptions | OTP close, complaint, reopen, escalation                                                   | Happy path and dissatisfaction path both complete end-to-end.                                                                         |
| 4 - Management views        | Hall/Admin/SuperAdmin dashboards, filters, audit timeline, stage timing/duration analytics | Operations team can run a simulated hall, inspect delays between every ticket stage and identify bottlenecks without database access. |
| 5 - Reporting & hardening   | Exports, monitoring, rate limits, load tests, backup/restore, UAT                          | Pilot-ready release with reproducible acceptance test evidence.                                                                       |

# 14. MVP acceptance criteria

- A stall bound to Hall 2 / Zone B / Stall B203 cannot create a ticket
  for another stall unless granted a management role.

- Every ticket shows a complete chronological timeline from creation
  through closure/reopen.

- Hall Manager receives all ticket events for their hall; Admin sees all
  event tickets; SuperAdmin sees all authorized events.

- When staff capacity is full, new tickets wait in FIFO order and the
  oldest eligible ticket is assigned first when capacity frees.

- An unanswered assignment produces a manager/admin alert at the
  configured 10-minute deadline.

- Normal completion requires the Stall to supply the displayed OTP and
  the assigned Staff to enter it successfully.

- A dissatisfied stall can raise a complaint; a Hall Manager/Admin can
  reopen the ticket without losing prior history.

- SuperAdmin can filter by event, hall, zone, stall, service, staff,
  status and date range and export the result.

- Role checks are enforced server-side, not only hidden in the UI.

- System remains usable on typical exhibition-hall mobile networks and
  gracefully retries transient realtime failures.

- Admin can open any authorized ticket and see raised, assigned,
  accepted, started, completion-requested and closed timestamps plus
  derived stage durations; the same values are filterable/exportable.

# 15. Pilot readiness checklist

| **Area**   | **Ready when**                                                                           |
|------------|------------------------------------------------------------------------------------------|
| Masters    | All halls, zones, stalls and on-duty users imported and validated.                       |
| Devices    | Stall/staff interfaces tested on representative Android/iPhone browsers and tablets.     |
| Network    | Fallback path works when realtime connection drops; actions sync after reconnection.     |
| Operations | Hall managers trained on reassign/reopen/escalation and emergency override.              |
| Support    | One technical admin can inspect logs and recover a stuck ticket without direct DB edits. |
| Data       | Daily backup and post-event export procedure tested.                                     |
