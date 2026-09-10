**ExpoOps**

**Business Rules, Permissions & Governance**

RBAC, ticket-state rules, SLA/escalation, OTP, audit, exports and data
integrity

**MVP v1.1 \| Exhibition Operations & Stall Service Management**

8 September 2026

| Working title: ExpoOps. The name is intentionally replaceable; the operating model is the deliverable. |
|--------------------------------------------------------------------------------------------------------|

# Document purpose

Acts as the rulebook for product behavior. Engineering should treat
these rules as server-side invariants; UI behavior must reflect them but
must never be the only enforcement layer.

**Primary audience:** Product owner, backend/frontend engineers, QA,
administrators, security/operations reviewers.

| **MVP PRINCIPLE:** Prefer a smaller number of deterministic workflows over a large number of configurable features. Every action that changes ticket ownership or status must be timestamped and auditable. |
|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 1. Role and scope model

| **Role**     | **Default scope**                    | **Core authority**                                                                       |
|--------------|--------------------------------------|------------------------------------------------------------------------------------------|
| Stall        | One stall within one event           | Create/track own stall tickets; verify OTP; raise complaint.                             |
| Staff        | Assigned event/hall/service scope    | Accept/snooze/start/request closure for own assigned tickets.                            |
| Hall Manager | One or more halls within an event    | View all hall tickets; ping/reassign/reopen/escalate within scope.                       |
| Admin        | One event or configured event set    | Full event operations, masters, workforce, ticket interventions, reports.                |
| SuperAdmin   | Organization / all authorized events | All Admin rights plus cross-event analytics, global configuration and export governance. |

# 2. Permission matrix

| **Action**              | **Stall**            | **Staff**            | **Hall Manager**     | **Admin**     | **SuperAdmin**   |
|-------------------------|----------------------|----------------------|----------------------|---------------|------------------|
| View own stall tickets  | Yes                  | No\*                 | All hall             | All event     | All scoped       |
| Create stall ticket     | Yes                  | No                   | Optional on behalf   | Yes on behalf | Yes on behalf    |
| Accept assigned ticket  | No                   | Own only             | No                   | No            | No               |
| Snooze assigned alert   | No                   | Own only             | No                   | No            | No               |
| Start / request closure | No                   | Own only             | Manager override     | Yes           | Yes              |
| Verify OTP              | Own stall            | No                   | No\*\*               | Override only | Override only    |
| Raise complaint         | Own stall            | No                   | On behalf            | On behalf     | On behalf        |
| Reassign                | No                   | No                   | Within hall          | Within event  | All scoped       |
| Reopen                  | No\*\*\*             | No                   | Within hall          | Within event  | All scoped       |
| Emergency close         | No                   | No                   | Optional policy      | Yes + reason  | Yes + reason     |
| Manage masters/users    | No                   | No                   | No/limited           | Yes event     | Yes global       |
| Export                  | Own history optional | Own history optional | Hall report optional | Event data    | Cross-event data |
| View audit log          | Own ticket timeline  | Own ticket timeline  | Hall timeline        | Event audit   | All scoped audit |

\* Staff sees tickets assigned to them and any limited queue metadata
needed for work. \*\* Normal OTP must be verified from the stall side.
\*\*\* Stall requests complaint/reopen; Hall Manager/Admin performs
formal reopen.

# 3. Ticket creation rules

1\. A ticket must belong to exactly one event, hall, zone and stall.

2\. For stall users, location is derived from authenticated scope and
cannot be client-overridden.

3\. Category and subtype must be from active event configuration.

4\. Created_at is server-generated. Public ticket number must be unique
within its configured namespace.

5\. Ticket creation must be idempotent for repeated client submissions
using an idempotency key.

6\. A ticket starts as NEW and immediately enters routing. No editable
draft state is required for MVP.

7\. Deleting tickets is prohibited. Invalid/withdrawn tickets are
CANCELLED with reason.

# 4. Ticket state-transition rules

| **From**         | **Allowed to**                          | **Who/what may trigger**                                  |
|------------------|-----------------------------------------|-----------------------------------------------------------|
| NEW              | ASSIGNED / QUEUED / CANCELLED           | Routing engine / Admin                                    |
| ASSIGNED         | ACCEPTED / SNOOZED / REASSIGNED         | Assigned staff / Manager/Admin                            |
| SNOOZED          | ACCEPTED / REASSIGNED / ESCALATED       | Assigned staff / Manager/Admin / timer                    |
| QUEUED           | ASSIGNED / CANCELLED                    | Queue engine / Admin                                      |
| ACCEPTED         | IN_PROGRESS / REASSIGNED                | Assigned staff / Manager/Admin                            |
| IN_PROGRESS      | AWAITING_OTP / ESCALATED                | Assigned staff / Manager/Admin                            |
| AWAITING_OTP     | CLOSED / COMPLAINT_RAISED / IN_PROGRESS | Stall OTP / Stall dissatisfaction / authorized correction |
| CLOSED           | REOPENED                                | Hall Manager/Admin/SuperAdmin                             |
| COMPLAINT_RAISED | REOPENED / ESCALATED                    | Hall Manager/Admin                                        |
| REOPENED         | ASSIGNED / QUEUED                       | Routing engine                                            |
| ESCALATED        | ASSIGNED / REOPENED / CLOSED            | Manager/Admin; closure policy applies                     |
| CANCELLED        | None                                    | Terminal                                                  |

| **INVARIANT:** A status transition and its TicketEvent audit record must commit in the same database transaction. A ticket must never change state without an audit event. |
|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 5. Assignment rules

- Eligibility is determined by event scope, hall/service assignment,
  on-duty status and active-ticket capacity.

- One ticket has at most one current active assignee at a time in MVP.

- Available staff selection uses least active load, then longest idle as
  deterministic tie-breaker.

- If nobody is eligible/available, the ticket enters FIFO queue for that
  compatible pool.

- FIFO order is created_at ascending, then ticket ID ascending as
  deterministic tie-breaker.

- Manual queue priority override requires Hall Manager/Admin permission
  and a mandatory reason.

- Reassignment closes the previous Assignment record; history is never
  overwritten.

- Staff cannot transfer a ticket directly to another staff member in
  MVP.

# 6. Staff response and snooze rules

1\. Assigned staff must either ACCEPT or SNOOZE 10 MINUTES.

2\. Snooze duration is fixed at 10 minutes for MVP unless SuperAdmin
configuration explicitly changes it event-wide.

3\. Snooze does not reset ticket created_at, queue age or SLA age.

4\. Only one active snooze window per assignment should be allowed by
default; repeated snoozes can be disabled or explicitly configured.

5\. At response deadline, generate ASSIGNMENT_RESPONSE_OVERDUE and
notify Hall Manager + Admin.

6\. Manager/Admin can reassign with reason. Reassignment frees the prior
staff capacity and may trigger another FIFO allocation.

# 7. SLA and escalation rules

Because exact service SLAs are business-dependent, implement them as
configuration rather than hard-code final minute values. For MVP,
support at least response target and resolution target by ticket
subtype/priority.

| **Rule**                | **MVP behavior**                                                                                                                                             |
|-------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Response SLA            | Measured created_at -\> accepted_at (or first accepted assignment).                                                                                          |
| Resolution SLA          | Measured created_at -\> final closed_at; also retain active work-cycle durations.                                                                            |
| Approaching SLA         | Optional warning at configurable percentage/remaining time.                                                                                                  |
| Breach                  | Create SLA_BREACHED audit/exception event; alert Hall Manager/Admin.                                                                                         |
| Escalation level        | 0 normal, 1 manager attention, 2 admin attention; SuperAdmin sees all exceptions.                                                                            |
| Manual escalation       | Requires reason and actor; cannot erase previous escalation.                                                                                                 |
| Stage timing visibility | Admin/SuperAdmin can inspect exact milestone timestamps and completed/live durations; filters may flag thresholds independently of formal SLA configuration. |

# 8. OTP rules

- OTP may be generated only for a ticket currently IN_PROGRESS unless an
  authorized correction path is used.

- Only one active OTP challenge may exist per ticket at a time.

- Recommended OTP: 6 numeric digits, short expiry (for example 10
  minutes), protected/hash-stored server-side.

- Maximum attempts and resend/regeneration rate limits must be
  configurable and logged.

- Successful verification sets verified_at/verified_by and closes the
  ticket atomically.

- OTP value must not appear in audit exports, analytics datasets or
  ordinary logs.

- Admin/SuperAdmin override closure must be a distinct action requiring
  reason; never pretend an OTP was verified when it was not.

# 9. Complaint and reopen rules

| **Rule**             | **Requirement**                                                       |
|----------------------|-----------------------------------------------------------------------|
| Complaint ownership  | Complaint is attached to original ticket.                             |
| Reason               | Use controlled reason code + optional/required note.                  |
| Reopen permission    | Hall Manager within scope, Admin, SuperAdmin.                         |
| Reopen identity      | Same ticket number; increment reopen_count.                           |
| Prior history        | Immutable; previous assignment/OTP/closure remain visible.            |
| Routing after reopen | Re-run routing; manager can change category/service only with reason. |
| Repeated reopen      | Flag after configurable threshold for Admin exception review.         |

# 10. Hall Manager rules

- Receives visibility/alert for every ticket created in assigned
  hall(s), regardless of service type.

- May reassign and reopen within hall scope.

- May ping staff and Admin through system notification actions; message
  actions are audit logged.

- Cannot alter event-global configuration unless separately granted
  Admin rights.

- Should not be able to delete or rewrite historical ticket events.

# 11. Admin rules

- Admin actions are restricted to assigned event scope unless explicitly
  multi-event.

- May create/update halls, zones, stalls, staff mappings and service
  configuration before/during event subject to data-integrity
  constraints.

- May reassign/reopen/escalate/cancel and perform emergency close with
  reason.

- May not edit prior audit events; corrections are new events.

- Can export event data and view exception analytics.

- Admin can view raw ticket-stage timestamps and derived durations for
  all tickets in authorized event scope, including active/live durations
  for milestones not yet completed.

## 11.1 Timestamp and duration rules

All ticket timing analytics are based on server-side authoritative
timestamps. Client device clocks are never trusted for SLA or reporting
calculations.

| Timing field / metric   | Rule                                                                                                                                           |
|-------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| created_at              | Set once when ticket creation transaction succeeds; immutable.                                                                                 |
| queued_at               | Recorded for each queue entry/cycle when applicable; queue duration is derived from queue events, not manually entered.                        |
| assigned_at             | Recorded on every Assignment record; first_assigned_at may be derived for ticket-level reporting.                                              |
| accepted_at             | Recorded when assigned staff accepts. Staff response = accepted_at - assigned_at for that assignment cycle.                                    |
| started_at              | Recorded when staff starts work. Mobilization = started_at - accepted_at.                                                                      |
| completion_requested_at | Recorded when staff requests OTP closure. Active work duration = completion_requested_at - started_at.                                         |
| closed_at               | Recorded only on valid OTP closure or authorized emergency-close transaction. OTP wait = closed_at - completion_requested_at.                  |
| Total resolution        | final closed_at - created_at. Reopened tickets retain earlier closed/reopened events and calculate final resolution against the final closure. |
| Active/live duration    | For an incomplete stage, UI may show now - stage_start_time; exports must distinguish live/open duration from completed duration.              |
| Timezone                | Store timestamps in UTC; render in event timezone and include timezone in exports/metadata.                                                    |

Derived durations are not editable business fields. They must be
calculated from event/assignment timestamps in queries, reporting views
or a reproducible analytics layer. Any cached aggregate must be
rebuildable from the immutable timeline.

# 12. SuperAdmin rules

- SuperAdmin has organization-wide or explicitly scoped cross-event
  access.

- Can configure global defaults, manage Admin users and inspect
  cross-event data.

- All SuperAdmin high-risk actions are audited identically to Admin
  actions; privilege does not remove traceability.

- Exports containing personally identifiable contact data should be
  permission-gated and logged.

# 13. Notification rules

| **Rule**        | **Requirement**                                                                                                   |
|-----------------|-------------------------------------------------------------------------------------------------------------------|
| Delivery model  | In-app realtime is authoritative for MVP; optional push/SMS/WhatsApp are adapters.                                |
| Deduplication   | One logical event should not create repeated identical alerts to same recipient.                                  |
| Acknowledgement | Read/unread is separate from action acceptance.                                                                   |
| Critical events | Overdue, complaint and escalation notifications persist in exception inbox until resolved/acknowledged by policy. |
| Scope           | Never send stall-identifying ticket details to users outside authorized event/hall/service scope.                 |

# 14. Audit rules

| **Must record** | **Examples**                                                                                                                                                     |
|-----------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Actor           | user_id or system actor                                                                                                                                          |
| Action          | ticket_created, assigned, accepted, snoozed, started, otp_generated, otp_verified, complaint_raised, reopened, reassigned, escalated, cancelled, override_closed |
| Time            | Server timestamp in UTC + event timezone presentation                                                                                                            |
| State change    | from_status and to_status when applicable                                                                                                                        |
| Context         | old/new assignee, reason code, note reference, queue position, escalation level                                                                                  |
| Request trace   | request/correlation ID for technical troubleshooting                                                                                                             |

| **AUDIT PROTECTION:** Application users, including SuperAdmin, must not have a UI path that edits or deletes audit events. Retention/archival is a separate governance operation. |
|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 15. Data export rules

| **Rule**         | **Requirement**                                                                                                                                                                               |
|------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Filter fidelity  | Export uses exactly the submitted filter snapshot; save it with export job metadata.                                                                                                          |
| Formats          | CSV and XLSX are baseline; PDF is presentation export and may contain fewer columns.                                                                                                          |
| Authorization    | Re-check permission when export is generated and downloaded.                                                                                                                                  |
| Sensitive fields | Contact details excluded by default unless required/authorized.                                                                                                                               |
| Audit            | Record who exported, when, scope, row count and filter snapshot.                                                                                                                              |
| Retention        | Generated export files expire after configurable period; source data remains governed separately.                                                                                             |
| Timing columns   | CSV/XLSX should include authoritative ISO timestamps plus duration values in seconds (or another documented machine-friendly unit); human-readable duration labels may be additional columns. |

# 16. Data integrity rules

- Zone must belong to selected Hall; Stall must belong to selected Zone;
  ticket hierarchy is validated server-side.

- A user scope cannot reference a hall/stall outside its event.

- Historical tickets retain original event/hall/zone/stall foreign keys
  even if labels change.

- Do not hard-delete events/halls/zones/stalls referenced by tickets;
  deactivate/archive instead.

- Use database constraints/transactions for unique ticket numbers, one
  active assignment, valid scope and OTP closure.

- Every write endpoint should be safe against duplicate network retries
  where practical.

# 17. Security baseline

- Server-side RBAC and object-level scope checks on every protected
  read/write.

- Short-lived sessions/access tokens with secure refresh/session
  handling appropriate to deployment.

- Rate-limit login, OTP attempts, OTP generation and
  notification-triggering endpoints.

- Encrypt transport with HTTPS; protect secrets through
  environment/secret manager, never client bundles.

- No OTP/plain credentials in logs. Minimize personal contact data.

- Admin/SuperAdmin sessions should support stronger authentication
  policy (MFA recommended before production scale).

- Maintain tested backups and a documented restore procedure for
  live-event continuity.

# 18. Reporting definitions

| **Metric**               | **Definition**                                                                |
|--------------------------|-------------------------------------------------------------------------------|
| Ticket volume            | Count of created tickets in selected scope/date.                              |
| First response time      | created_at to first accepted_at.                                              |
| Resolution time          | created_at to final closed_at.                                                |
| Queue wait               | Total time in QUEUED state before assignment.                                 |
| Reopen rate              | Tickets with reopen_count \> 0 / closed-or-reopened tickets.                  |
| Complaint rate           | Tickets with complaint / tickets reaching closure attempt.                    |
| Staff throughput         | Tickets closed with staff as active work assignee in selected period.         |
| Response overdue rate    | Assignments producing response_overdue / assignments created.                 |
| Dispatch / assign delay  | created_at to first assigned_at; report queue time separately where relevant. |
| Assignment response time | assigned_at to accepted_at for each assignment cycle.                         |
| Mobilization time        | accepted_at to started_at.                                                    |
| Active work duration     | started_at to completion_requested_at for each work cycle.                    |
| OTP confirmation wait    | completion_requested_at to closed_at for a closure attempt.                   |

# 19. Rules requiring business confirmation before pilot

| **Open policy decision**                      | **Recommended default**                                         |
|-----------------------------------------------|-----------------------------------------------------------------|
| Meaning/handling of Electrical “NCP”          | Keep as subtype; operations owner supplies exact definition.    |
| Can Hall Manager emergency-close without OTP? | No by default; Admin/SuperAdmin only with reason.               |
| Can staff snooze more than once?              | No by default.                                                  |
| Staff active-ticket capacity                  | 1 for field staff unless service requires parallel tasks.       |
| Priority levels                               | Normal + Urgent only; priority override requires manager/admin. |
| Exact response/resolution SLAs                | Configure per service after operational workshop.               |
| Notification channels beyond in-app           | Add based on venue connectivity and business cost.              |
| Post-event retention period                   | Set organization policy before first live deployment.           |

# 20. Rule acceptance checklist

- No forbidden role action succeeds through direct API calls.

- No ticket status changes without a matching audit event.

- No normal ticket closure succeeds without valid OTP verification.

- No reassignment overwrites prior assignment history.

- No queued ticket bypasses FIFO unless a privileged, reasoned override
  is recorded.

- No staff no-response passes the configured deadline without an
  exception event/alert.

- No export returns data outside the requesting user’s authorized scope.

- No Admin timing view/export computes SLA or duration from
  client-device timestamps; values must trace back to server-side
  authoritative ticket/assignment events.
