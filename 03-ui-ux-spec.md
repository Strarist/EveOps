**ExpoOps**

**UI/UX Design Specification**

Information architecture, role dashboards, screens, components and
responsive behavior

**MVP v1.1 \| Exhibition Operations & Stall Service Management**

8 September 2026

| Working title: ExpoOps. The name is intentionally replaceable; the operating model is the deliverable. |
|--------------------------------------------------------------------------------------------------------|

# Document purpose

Defines the visual and interaction system for an MVP that must work
under live exhibition pressure. The design intentionally separates
high-frequency mobile actions from management-heavy desktop analysis.

**Primary audience:** UI/UX designer, frontend engineers, product owner,
QA and operational stakeholders.

| **MVP PRINCIPLE:** Prefer a smaller number of deterministic workflows over a large number of configurable features. Every action that changes ticket ownership or status must be timestamped and auditable. |
|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

# 1. Design goals

| **Goal**                   | **Design implication**                                                                                |
|----------------------------|-------------------------------------------------------------------------------------------------------|
| Fast under pressure        | Primary actions must be visible without menus; minimize typing and repeated location selection.       |
| Role clarity               | Each role gets a different information density and action set, not one dashboard with hidden buttons. |
| Status certainty           | Every ticket always displays current state, owner, age and next expected action.                      |
| Exception-first management | Managers see overdue/escalated/complaint items before routine closed work.                            |
| Mobile reliability         | Stall and staff flows must be thumb-friendly and resilient to weak connectivity.                      |
| Audit confidence           | Management ticket detail exposes a readable timeline rather than raw logs.                            |

# 2. Visual system

| **Token**     | **Recommendation**                                                                       |
|---------------|------------------------------------------------------------------------------------------|
| Base surface  | White / very light neutral background; avoid heavy decorative gradients.                 |
| Primary       | Deep navy for navigation and high-confidence system controls.                            |
| Accent        | Teal for active controls and informational emphasis.                                     |
| Success       | Green; reserve for truly closed/verified states.                                         |
| Warning       | Amber; queued, waiting, snoozed, approaching deadline.                                   |
| Critical      | Red; overdue, escalated, failed OTP attempts, unresolved complaint.                      |
| Typography    | A modern sans-serif; 16px minimum body on mobile, 14px minimum dense admin tables.       |
| Touch targets | Minimum 44 x 44 px for stall/staff primary interactions.                                 |
| Cards         | Use cards for active work and exceptions; use tables for management history and exports. |

| **COLOR RULE:** Never communicate status by color alone. Pair color with icon/label such as “Queued”, “Response overdue”, “Closed - OTP verified”. |
|----------------------------------------------------------------------------------------------------------------------------------------------------|

# 3. Information architecture

| **Role**     | **Primary navigation**                                                                |
|--------------|---------------------------------------------------------------------------------------|
| Stall        | Home, Raise Ticket, My Tickets, Help/Profile                                          |
| Staff        | Current Task, Queue/History, Availability, Profile                                    |
| Hall Manager | Hall Overview, Live Tickets, Staff, Exceptions, Search                                |
| Admin        | Command Center, Tickets, Halls/Zones/Stalls, Workforce, Reports, Masters, Audit       |
| SuperAdmin   | Portfolio Overview, Events, Tickets, Analytics, Exports, Configuration, Admins, Audit |

# 4. Stall interface - mobile first

## 4.1 Home screen

| **Region**     | **Content**                                                                               |
|----------------|-------------------------------------------------------------------------------------------|
| Header         | Expo name + Stall A102 + connectivity indicator.                                          |
| Primary action | Large “Raise Ticket” button.                                                              |
| Open tickets   | Up to 3 active tickets with service, state, age, current assignee/status.                 |
| Recent         | Last closed tickets with “Report issue / Reopen request” entry point where policy allows. |
| Support        | Hall manager contact/escalation shortcut only if permitted.                               |

## 4.2 Raise ticket screen

- Show location as locked context: Hall 1 / Zone A / Stall A102.

- Use large service tiles: Electrical, House Help, Hall Manager.

- After Electrical selection, reveal NCP and Lighting subtype tiles.

- Description field should include examples but remain short; optional
  priority should be limited to Normal/Urgent if exposed.

- Submit button shows immediate loading state and prevents duplicate
  submission.

- Success state shows public ticket number and clear next step: “Hall
  Manager notified. Waiting for assignment.”

## 4.3 Ticket detail screen

**\[Ticket \#E-1024\] \[Lighting\] \[IN PROGRESS\]  
Hall 1 \> Zone A \> A102 \| Assigned: Rahul \| Age: 08m  
Timeline: Raised -\> Assigned -\> Accepted -\> Work started**

**Completion panel (AWAITING_OTP, Stall):** large completion code +
expiry; \[Work is not satisfactory\]. Stall never enters the OTP.

**Completion panel (AWAITING_OTP, Staff):** segmented 6-digit OTP entry
+ Verify & close ticket. Hall Managers use the same entry pattern for
scoped hall tickets awaiting verification and never see the generated
code in-app.

# 5. Staff interface - simplified mobile UI

| **STAFF UX RULE:** At any moment, the staff member should know only three things: where to go, what to fix, and what action to take next. |
|-------------------------------------------------------------------------------------------------------------------------------------------|

| **Screen**    | **Essential content/actions**                                                   |
|---------------|---------------------------------------------------------------------------------|
| Incoming task | Ticket type, hall/zone/stall, issue, age; Accept; Snooze 10 min.                |
| Current task  | Location prominent, contact/help, Start Work, Request Closure, escalation note. |
| Availability  | On Duty / Paused / Off Duty; active ticket count.                               |
| History       | Today’s completed/reassigned tasks; no management analytics.                    |

## 5.1 Incoming ticket card

**LIGHTING \| 03m old  
Hall 2 \> Zone B \> Stall B203  
“Main display lights not turning on”  
\[ACCEPT\] \[SNOOZE 10 MIN\]**

# 6. Hall Manager dashboard

| **Area**         | **Content**                                                               |
|------------------|---------------------------------------------------------------------------|
| Top bar          | Event, Hall selector (scoped), search, notification count, profile.       |
| KPI row          | Open, Queued, Response overdue, Escalated/Complaints, Avg response.       |
| Exception panel  | Cards for overdue assignment, repeat complaint, queue spike.              |
| Live ticket list | Ticket, stall, zone, service, status, age, assignee, SLA, quick actions.  |
| Staff panel      | On-duty staff by service, active load, last activity, unavailable status. |
| Ticket drawer    | Timeline, notes, assignment history, Reassign, Reopen, Ping, Escalate.    |

# 7. Admin command center

Desktop-first, dense but readable. Use a sticky filter bar and preserve
filter state while opening ticket details in a side drawer or new route.

| **Block**             | **Recommended design**                                                   |
|-----------------------|--------------------------------------------------------------------------|
| KPI strip             | Open, queued, overdue, escalated, closed today, complaints, reopen rate. |
| Hall status grid      | One compact card per hall with backlog and critical exceptions.          |
| Live operations table | Sortable rows with status chips; server-side filtering/pagination.       |
| Exception inbox       | Dedicated list ranked by operational urgency.                            |
| Workforce load        | Service x hall matrix showing available/busy/offline counts.             |
| Activity stream       | Optional last 20 high-impact events only; avoid noisy every-click feed.  |

## 7.1 Admin timing and duration view

Timing data should be visible at two levels: compact operational columns
in the live ticket table and a richer lifecycle strip/timeline inside
ticket detail. The UI must make bottlenecks scannable without forcing
the Admin to calculate time differences manually.

| UI area                | Required timing treatment                                                                                                                                                            |
|------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Live operations table  | Optional/choosable columns: Raised, Age, Assigned, Accept Delay, Started, Work Duration, OTP Wait, Closed, Total Duration.                                                           |
| Timing summary strip   | Six milestone chips: Raised -\> Assigned -\> Accepted -\> Started -\> Completion Requested -\> Closed, with exact time below each milestone and elapsed duration between milestones. |
| SLA/exception styling  | Use status text + icon/badge for warning/breach; never rely on color alone.                                                                                                          |
| Ticket detail timeline | Every audit event shows actor, event, exact timestamp and relative elapsed time from the previous operational event.                                                                 |
| Reopen cycles          | Group each cycle as Attempt 1, Attempt 2, etc., while retaining one permanent ticket identity.                                                                                       |
| Filters                | Duration threshold filters (e.g., response \> 10 min, work \> 30 min), SLA state, date/time range, hall, zone, service, staff.                                                       |
| Export                 | Current filters and visible timing fields flow into export configuration; Admin should not need a separate reporting screen for basic ticket timing analysis.                        |

# 8. SuperAdmin analytics workspace

| **View**           | **Purpose**                                                         |
|--------------------|---------------------------------------------------------------------|
| Portfolio overview | Compare events and identify operational outliers.                   |
| Event analytics    | Trends by hall, zone, service, status and staff.                    |
| Ticket explorer    | All-ticket searchable/filterable grid with column chooser.          |
| Export center      | Saved export jobs, format, filters, generated time, expiry.         |
| Audit explorer     | Search actor/action/ticket/date for governance and incident review. |

# 9. Management ticket detail layout

| **Section** | **Fields/actions**                                                     |
|-------------|------------------------------------------------------------------------|
| Identity    | Ticket number, event, hall, zone, stall, exhibitor.                    |
| Service     | Category, subtype, description, priority.                              |
| Status      | Current state, age, current assignee, queue position if applicable.    |
| SLA         | Created, assigned, accepted, started, closure requested, closed.       |
| Timeline    | Human-readable chronological audit events.                             |
| Assignments | Each assignee cycle, response time, snooze/reassign reason.            |
| Complaint   | Reason, comment, reopen count, resolution.                             |
| Actions     | Ping, reassign, reopen, escalate, emergency close based on permission. |

# 10. Ticket status labels

| **Internal state** | **User-facing label**  | **Attention**   |
|--------------------|------------------------|-----------------|
| NEW                | Request received       | Info            |
| QUEUED             | Waiting for staff      | Warning         |
| ASSIGNED           | Staff assigned         | Info            |
| SNOOZED            | Staff response pending | Warning         |
| ACCEPTED           | Staff accepted         | Info            |
| IN_PROGRESS        | Work in progress       | Info            |
| AWAITING_OTP       | Confirm completion     | Action required |
| CLOSED             | Closed - OTP verified  | Success         |
| COMPLAINT_RAISED   | Issue reported         | Critical        |
| REOPENED           | Reopened               | Critical        |
| ESCALATED          | Escalated              | Critical        |
| CANCELLED          | Cancelled              | Neutral         |

# 11. Reusable components

- TicketStatusChip, TicketAge, LocationBreadcrumb, ServiceBadge,
  AssigneeChip.

- TicketTimeline with event icons and actor names.

- ExceptionBanner with reason + one primary action.

- StaffAvailabilityChip: On Duty, Busy, Paused, Offline.

- FilterBar with event/hall/zone/service/status/date/assignee.

- ConfirmAction modal for reopen/reassign/override closure; requires
  reason where policy says so.

- OTPInput with numeric keypad behavior, expiry countdown and
  resend/regenerate state.

- ConnectivityBanner and retry state for weak hall networks.

- StageDurationCell / TimingStrip: show exact timestamps, live ages,
  derived durations and SLA state consistently across Admin and
  SuperAdmin views.

# 12. Responsive behavior

| **Viewport** | **Behavior**                                                                                   |
|--------------|------------------------------------------------------------------------------------------------|
| \< 768 px    | Single-column; bottom navigation for Stall/Staff; full-screen ticket detail; no dense tables.  |
| 768-1199 px  | Tablet split view for Hall Manager: ticket list + drawer; compact KPI cards.                   |
| \>= 1200 px  | Admin/SuperAdmin side navigation, multi-column dashboards, full tables and persistent filters. |

# 13. Interaction rules

- Every destructive or authority-heavy action (reassign, reopen, cancel,
  override close) asks for explicit confirmation and, where required, a
  reason.

- Optimistically update harmless UI state only; ticket status
  transitions should confirm server success before showing final state.

- Disable actions that are invalid for the current ticket state and
  explain why via helper text/tooltips.

- Never show “success” merely because a request was sent; distinguish
  “saved locally/retrying” from “confirmed by server”.

- Keep timestamps in local event timezone and optionally show relative
  age (“12m”) beside exact time in detail views.

# 14. Accessibility and field usability

- Minimum WCAG-style contrast targets and keyboard support for
  management screens.

- Status chips contain text, not color alone.

- Form fields have persistent labels; do not rely on placeholder-only
  labeling.

- Large numeric OTP controls and mobile numeric keyboard hint.

- Critical alerts should use sound/vibration only as optional
  enhancement; visual alert remains required.

- Provide a “high density / normal density” admin table option later;
  MVP defaults to normal readable density.

# 15. Empty, loading and failure states

| **State**             | **Required copy/behavior**                                                       |
|-----------------------|----------------------------------------------------------------------------------|
| No open tickets       | “No active requests for this stall.” + Raise Ticket CTA.                         |
| Queue empty           | “No tickets waiting for this service.”                                           |
| Realtime disconnected | Persistent non-blocking banner; automatically reconnect; allow safe API actions. |
| Action failed         | Keep user context and show retry; do not reset entered description.              |
| No search result      | Show active filters and one-click Clear Filters.                                 |
| Export processing     | Show job status and filter snapshot used for export.                             |

# 16. Design acceptance checklist

- Stall can raise a ticket with one hand on a phone in under 45 seconds
  during usability testing.

- Staff can understand an incoming assignment without opening a second
  screen.

- Hall Manager can identify the oldest overdue ticket within five
  seconds.

- Admin can filter to a specific hall + service + status without losing
  live updates.

- SuperAdmin can export the same filtered result set visible on screen.

- All role-specific forbidden actions are absent from UI and rejected by
  backend if attempted directly.

- Admin can identify which stage is causing a delay and read exact
  milestone times plus stage durations without manual calculation.
