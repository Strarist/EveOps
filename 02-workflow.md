**ExpoOps**

**End-to-End Workflow Specification**

Operational flows, ticket lifecycle, assignment queue, OTP closure and
exception handling

**MVP v1.1 \| Exhibition Operations & Stall Service Management**

8 September 2026

| Working title: ExpoOps. The name is intentionally replaceable; the operating model is the deliverable. |
|--------------------------------------------------------------------------------------------------------|

# Document purpose

Translates the business story into deterministic operational flows that
product, engineering, QA and exhibition staff can all follow. Each flow
describes actors, system behavior, alerts and state changes.

**Primary audience:** Operations leadership, product, engineering,
QA/UAT teams, hall managers.

| **MVP PRINCIPLE:** Prefer a smaller number of deterministic workflows over a large number of configurable features. Every action that changes ticket ownership or status must be timestamped and auditable. |
|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 1. System hierarchy and routing context

**EVENT \> HALL \> ZONE \> STALL \> TICKET \> SERVICE POOL / HALL
MANAGER**

| **ROUTING PRINCIPLE:** The stall location is known before the ticket is submitted. Users should never repeatedly select hall/zone/stall if their login is already bound to a stall. |
|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 2. Happy-path ticket flow

| **Step** | **Actor** | **Action**                                                            | **System result**                                                                                                                  |
|----------|-----------|-----------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------|
| 1        | Stall     | Opens “Raise ticket”                                                  | System pre-fills event, hall, zone and stall.                                                                                      |
| 2        | Stall     | Selects category/subtype, adds short description and optional urgency | Ticket is validated and assigned a public ticket number. created_at is captured.                                                   |
| 3        | System    | Routes ticket                                                         | Hall Manager is alerted immediately. Correct service pool is identified.                                                           |
| 4        | System    | Assigns or queues                                                     | Available staff receives assignment; otherwise ticket enters FIFO queue. assigned_at or queued_at is captured.                     |
| 5        | Staff     | Accepts                                                               | Ticket becomes ACCEPTED; accepted_at is captured and assignment-to-accept duration becomes available.                              |
| 6        | Staff     | Starts work                                                           | Ticket becomes IN_PROGRESS; started_at is captured.                                                                                |
| 7        | Staff     | Marks work completed                                                  | Ticket becomes AWAITING_OTP; completion_requested_at is captured and closure OTP challenge is created for stall.                   |
| 8        | Stall     | Checks work and verbally shares displayed OTP with Staff or Hall Manager | Stall never enters the OTP. Staff or Hall Manager enters the stall-supplied code. |
| 8b       | Staff / Hall Manager | Enters stall completion code                                  | Ticket becomes CLOSED; closed_at is captured after valid OTP.                      |
| 9        | System    | Finalizes timeline                                                    | System calculates dispatch, staff-response, mobilization, work, OTP-wait and total-resolution durations from immutable timestamps. |

# 3. Stall workflow

1\. Login using stall credentials or assigned contact identity. The
dashboard shows stall code, current open tickets and a prominent “Raise
Ticket” action.

2\. Choose service category. For Electrical, choose NCP or Lighting. For
House Help or Hall Manager, use the relevant general subtype.

3\. Add a concise issue description. The MVP can allow optional photo
attachment later, but description must remain sufficient without it.

4\. Submit. The system returns the ticket number, current status,
assigned service type and live timeline.

5\. Track the ticket without repeatedly calling the hall team. Visible
states should use human-readable labels such as “Waiting for staff”,
“Staff assigned”, “Work in progress”, “Confirm completion”.

6\. When staff marks completion, view the completion code on your stall
screen. Check the work, then verbally give the code to Staff. Do not
enter the OTP yourself.

7\. If dissatisfied, choose “Not resolved / Raise complaint”, select
reason and enter a short note. The prior work attempt remains in
history.

# 4. Hall Manager workflow

| **Trigger**            | **Hall Manager sees**                                         | **Allowed action**                                       |
|------------------------|---------------------------------------------------------------|----------------------------------------------------------|
| Any new hall ticket    | Ticket number, stall, zone, type, age, current assignee/queue | Open detail, ping staff, reassign if authorized.         |
| Staff response overdue | Overdue badge + elapsed time                                  | Call/ping staff, reassign, escalate to Admin.            |
| Ticket queued          | Queue position and service backlog                            | Monitor; manual prioritization only with audited reason. |
| Complaint raised       | Complaint reason and prior timeline                           | Reopen, reassign, add manager note, escalate.            |
| Closed ticket disputed | Closure/OTP record                                            | Reopen ticket.                                           |
| Hall pressure spike    | Hall summary and category backlog                             | Coordinate workforce; ping Admin for additional staff.   |

# 5. Staff workflow

1\. Staff logs in and sets availability to ON DUTY. Interface shows only
current assignment plus a small queue/workload summary; avoid exposing
unnecessary management data.

2\. When assigned, the ticket card shows service type, hall, zone, stall
code, issue description, age and navigation hint.

3\. Staff chooses “Accept” or “Snooze 10 min”. There is no silent
dismissal.

4\. Accepting locks ownership unless a manager/admin explicitly
reassigns the ticket.

5\. Staff taps “Start Work” when physically attending the stall.

6\. After resolving the issue, staff taps “Request Closure”. System
creates OTP challenge and moves to AWAITING_OTP.

7\. If the stall refuses closure because work is incomplete, staff
cannot force normal closure. The ticket follows
complaint/reopen/escalation flow.

8\. After a ticket closes or is reassigned away, capacity is freed and
the engine may assign the next FIFO ticket.

# 6. Assignment and FIFO flow

| **Condition**                 | **System decision**                                    | **Audit event**             |
|-------------------------------|--------------------------------------------------------|-----------------------------|
| Eligible staff available      | Assign to lowest active load; longest idle wins tie    | ASSIGNMENT_CREATED          |
| All eligible staff busy       | Place ticket at end of service-pool FIFO queue         | TICKET_QUEUED               |
| Staff becomes available       | Take oldest compatible queued ticket                   | DEQUEUED_AND_ASSIGNED       |
| Assigned staff accepts        | Lock as active owner                                   | ASSIGNMENT_ACCEPTED         |
| Staff snoozes                 | Keep owner, start/continue 10-minute response deadline | ASSIGNMENT_SNOOZED          |
| 10 min expires without accept | Alert Hall Manager + Admin; flag response overdue      | ASSIGNMENT_RESPONSE_OVERDUE |
| Manager reassigns             | Close previous assignment with reason; create new one  | ASSIGNMENT_REASSIGNED       |

| **FIFO DEFINITION:** FIFO applies to waiting tickets within a compatible event/hall/service pool. A higher-priority operational override may move a ticket ahead only when performed by Hall Manager/Admin with a mandatory reason and audit event. |
|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 7. Snooze / no-response workflow

1\. Staff receives assignment at T0.

2\. Staff taps “Snooze 10 min”. Ticket remains visibly assigned; it is
not returned to the queue immediately.

3\. At or before T0+10, staff can accept. The overdue timer is
cancelled.

4\. At T0+10 without acceptance, system marks response overdue and sends
an exception alert to Hall Manager and Admin.

5\. Manager/Admin decides to reassign, contact the staff, or allow a
short continuation. Any action is written to the ticket timeline.

6\. Repeated no-response events are reportable by staff member for
post-event performance analysis.

# 8. OTP completion workflow

| **Step**                | **Rule**                                                                                       |
|-------------------------|------------------------------------------------------------------------------------------------|
| Request closure         | Only current assignee or authorized manager can initiate normal closure request.               |
| Generate OTP            | Ticket must be IN_PROGRESS. Generate one active OTP challenge at a time.                       |
| Present to stall        | OTP is visible only to the bound stall identity. Staff and managers never see the generated value in-app. |
| Verify                  | Assigned Staff or the scoped Hall Manager enters the stall-supplied OTP; correct non-expired OTP closes the ticket. |
| Wrong attempts          | Increment attempt counter and rate-limit; do not reveal whether individual digits are correct. |
| Expired OTP             | Regenerate with a new challenge; invalidate previous one.                                      |
| No stall representative | Manager/Admin may use audited override only under documented event policy.                     |

# 9. Complaint / dissatisfaction workflow

| **Scenario**            | **Stall action**                              | **System/manager behavior**                                                    |
|-------------------------|-----------------------------------------------|--------------------------------------------------------------------------------|
| Work not completed      | Choose “Not resolved” before OTP confirmation | Do not close. Create complaint event and alert Hall Manager.                   |
| Work poor after closure | Raise complaint from recent closed ticket     | Hall Manager reviews and may REOPEN.                                           |
| Wrong service/person    | Select relevant complaint reason              | Manager may change service pool and reassign.                                  |
| Repeated failure        | Escalate complaint                            | Admin alerted; escalation level increases while preserving original ticket ID. |

| **IDENTITY RULE:** A reopened ticket keeps the same ticket number. Do not create a new disconnected ticket for the same unresolved incident; use reopen_count and new assignment records. |
|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 10. Reopen workflow

1\. Hall Manager/Admin opens the closed or complaint ticket.

2\. Selects “Reopen” and enters mandatory reason.

3\. System increments reopen_count, writes REOPENED event and clears any
obsolete active assignment.

4\. Ticket returns to routing using current category/service pool unless
manager deliberately changes it.

5\. New work attempt proceeds through acceptance, in-progress and OTP
closure again.

6\. Reports show first-response time, total elapsed time and each work
cycle separately.

# 11. Hall Manager ticket type

A “Hall Manager” ticket is a request for direct managerial assistance
rather than field service. Recommended MVP behavior: route directly to
the manager assigned to that hall, alert Admin for visibility, and use
ACCEPTED -\> IN_PROGRESS -\> AWAITING_OTP -\> CLOSED unless the business
chooses a lighter acknowledgement-only closure policy.

# 12. Admin workflow

- Live command center across all halls in the event.

- Filter by hall, zone, service, status, age, assignee, complaint/reopen
  and SLA state.

- Manage event masters and workforce assignments.

- Ping hall managers and staff, reassign tickets, reopen/override when
  permitted, and inspect audit history.

- See exception inbox: unaccepted assignments, long queues, escalations,
  OTP anomalies, repeatedly reopened tickets.

- Export filtered operational data for event reporting.

## 12.1 Admin timing and duration monitoring

For every ticket in Admin scope, the Admin can move from the live
operations list into a timing view that exposes the service lifecycle as
measurable intervals.

| Admin workflow step      | System behavior                                                                                                                       |
|--------------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| Open live ticket table   | Show Raised Time, Current Age, Assigned Time, Accepted Time, Started Time, Completion Requested Time and Closed Time where available. |
| Inspect duration columns | Show Raise-\>Assign, Assign-\>Accept, Accept-\>Start, Work Duration, OTP Wait and Total Resolution.                                   |
| Sort/filter bottlenecks  | Filter/sort by any duration threshold, SLA state, hall, zone, category, assignee, status, complaint/reopen state and date range.      |
| Open ticket detail       | Render a chronological timeline with timestamp on each event and elapsed duration between adjacent operational milestones.            |
| Inspect reopened ticket  | Show each assignment/work/closure cycle separately; do not overwrite timestamps from earlier cycles.                                  |
| Export current view      | Export raw timestamps and machine-friendly duration values using the same active filter snapshot.                                     |

Exception behavior: if a milestone has not occurred, its timestamp is
blank and the duration remains live (for example, “Assigned 00:07:42
ago”). Admin views should make ageing work visually obvious without
implying a completed interval.

# 13. SuperAdmin workflow

- Switch between events and view cross-event performance without losing
  event-level filters.

- Access complete ticket, stall, workforce and audit data according to
  organizational scope.

- Use saved filters and export center for CSV/XLSX/PDF-ready reports.

- Inspect trends: request volume, response/resolution times,
  reopen/complaint rate, staff throughput and service bottlenecks.

- Manage global configuration such as ticket types, SLA defaults, export
  retention and organization admins.

# 14. Notification matrix

| **Event**        | **Stall**       | **Staff**             | **Hall Manager** | **Admin**                    | **SuperAdmin** |
|------------------|-----------------|-----------------------|------------------|------------------------------|----------------|
| Ticket created   | Confirmation    | Assigned staff only   | Yes              | Visible / configurable alert | Visible        |
| Assigned         | Status update   | Yes                   | Visible          | Visible                      | Visible        |
| Response overdue | Visible status  | Yes reminder          | Urgent alert     | Urgent alert                 | Exception feed |
| Work started     | Status update   | Current assignee      | Visible          | Visible                      | Visible        |
| Awaiting OTP     | Action required | Current assignee      | Visible          | Visible                      | Visible        |
| Complaint raised | Confirmation    | Current/next assignee | Urgent alert     | Alert                        | Exception feed |
| Reopened         | Status update   | New/current assignee  | Alert            | Visible                      | Visible        |
| Closed           | Confirmation    | Confirmation          | Visible          | Visible                      | Visible        |

# 15. Edge-case workflows

| **Edge case**                         | **Required MVP behavior**                                                                           |
|---------------------------------------|-----------------------------------------------------------------------------------------------------|
| Network drop while action submitted   | Client retries idempotently; duplicate button taps must not create duplicate tickets/status events. |
| Staff goes offline with active ticket | Manager sees offline indicator; ticket remains owned until reassigned by policy.                    |
| Two managers reassign simultaneously  | Transactional ownership update; only one reassignment succeeds.                                     |
| OTP entered twice                     | Second verification returns already-closed state without duplicate closure event.                   |
| Stall raises same issue repeatedly    | Allow creation but show recent open similar tickets to reduce accidental duplicates.                |
| Event ends with open tickets          | Admin gets unresolved-ticket report; tickets are not silently auto-closed.                          |

# 16. UAT scenarios

| **Scenario**                                      | **Expected result**                                                 |
|---------------------------------------------------|---------------------------------------------------------------------|
| Electrical Lighting ticket with free electrician  | Immediate assignment, manager alert, staff accept, work, OTP close. |
| Electrical NCP ticket with all electricians busy  | Ticket enters FIFO; oldest ticket gets next free electrician.       |
| Staff snoozes and ignores                         | At 10 minutes, Hall Manager + Admin receive overdue alert.          |
| Stall rejects completion                          | Ticket does not close; complaint path starts.                       |
| Manager reopens closed ticket                     | Same ticket ID returns active with reopen reason preserved.         |
| SuperAdmin filters Hall 3 + House Help + reopened | Correct result set can be exported with timeline identifiers.       |
