# Route and section matrix

Role home routes stay separate. Admin registrations are a distinct page, with exhibitor, staff, and hall-manager sections on that page.

| Route | Role | What it shows |
| --- | --- | --- |
| `/login` | Operations roles | Sign in |
| `/governance-access` | SuperAdmin | Governance sign in |
| `/stall` | Stall | Own stall requests and completion code |
| `/stall/ticket/[id]` | Stall | One request, including its activity |
| `/staff` | Staff | Current task, history, availability |
| `/staff/task/[id]` | Staff | One task, including its activity |
| `/hall-manager` | Hall Manager | Hall overview, live tickets, staff, exceptions, search |
| `/admin` | Admin | Command center, tickets, halls/zones/stalls, workforce, reports, masters, audit |
| `/admin/registrations` | Admin | Stall registrations; exhibitor accounts; staff; hall managers |
| `/super-admin` | SuperAdmin | Portfolio, events, tickets, analytics, exports, configuration, admins, audit |
| `/change-password` | Any signed-in user who must rotate a password | Password change |

Staff and hall-manager account changes remain on Workforce. Stall registration edit, exhibitor transfer, and archive are only on `/admin/registrations`.
