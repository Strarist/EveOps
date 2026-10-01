# Priority operations

Rebuilt on 29 September 2026 from the documented 23 September handoff. The original Windows source and its database were not recovered. Ticket urgency (`NORMAL` / `URGENT`) remains the SLA flag. Stall service priority is a separate queue key.

## Stall service priority

Each stall has `servicePriority`: `HIGH`, `MEDIUM`, or `LOW`. New stalls default to `MEDIUM`.

Creating a ticket copies that value onto the ticket. Later edits to the stall do not rewrite tickets already created.

## Queue order

Within one compatible pool, waiting tickets (`NEW`, `QUEUED`, `REOPENED`) are chosen in this order:

1. Reasoned manual override (`queuePriorityOverrideAt` set, earliest first; tickets without an override stay behind).
2. Service priority `HIGH`, then `MEDIUM`, then `LOW`.
3. Ticket creation time, oldest first.
4. Ticket id.

Assigned work is not taken back to satisfy a higher priority. The same order is used when a ticket is created and when a free worker drains the queue.

A Hall Manager or Admin can change the service priority of a waiting ticket with a reason. That writes `SERVICE_PRIORITY_CHANGED` and does not assign or unassign anyone. The existing “move ahead” action still records `QUEUE_PRIORITY_OVERRIDDEN` for a queued ticket.

## Registration

Admin registration edit updates the stall code, exhibitor name, contact, and service priority. Historical tickets keep their original stall and the priority they snapshotted.

Exhibitor transfer and archive are refused while the stall has unresolved tickets. Transfer also refuses a destination that has unresolved tickets, is archived, or already has an exhibitor account. A successful transfer moves the exhibitor login to the destination stall, copies the exhibitor name and contact onto that stall, clears the contact on the stall they left, revokes that person’s sessions, and leaves ticket rows on the original stall. Archive deactivates the stall, records `archivedAt`, clears the contact, removes the stall scope, revokes sessions, and disables an exhibitor account that has no remaining scope. Ticket history is not deleted. The stall row is locked for these writes so a new ticket or a second exhibitor account cannot land in the middle of the move.
