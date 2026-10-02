'use client';

import { ExhibitorShell } from './shell';
import { useConnection, useStallProfile, useStallTickets } from './data';
import { eventTime, progressText, serviceText } from './format';

export function ExhibitorHome() {
  const { connection, pulse } = useConnection();
  const { profile } = useStallProfile(connection + pulse);
  const timeZone = profile?.scopes.find((scope) => scope.event.timezone)?.event.timezone ?? 'UTC';
  const active = useStallTickets('view=active&limit=3&sort=recent', pulse);
  const recent = useStallTickets('view=closed&limit=3', pulse);
  return (
    <ExhibitorShell>
      <div className="exhibitor-home">
        <a className="request-help" href="/stall/request">Request help</a>
        <section aria-labelledby="active-preview">
          <div className="section-title">
            <h2 id="active-preview">Active requests</h2>
            <a href="/stall/requests?view=active">See all{active.total ? ` ${active.total}` : ''}</a>
          </div>
          {active.loading && !active.items.length ? <p className="empty-state">Loading your requests…</p> : null}
          {active.error ? <p className="form-error" role="alert">{active.error} <button type="button" onClick={() => void active.refresh()}>Try again</button></p> : null}
          {!active.loading && !active.error && !active.items.length ? <p className="empty-state">No active requests for this stall.</p> : null}
          <div className="exhibitor-list">
            {active.items.map((ticket) => (
              <a className="exhibitor-card" key={ticket.id} href={'/stall/ticket/' + ticket.id}>
                <span className={'status status-' + ticket.status.toLowerCase()}>{progressText(ticket)}</span>
                <strong>{ticket.publicNo}</strong>
                <span>{serviceText(ticket)}</span>
                <span>{ticket.description}</span>
              </a>
            ))}
          </div>
          {active.total > active.items.length ? <a className="text-link" href="/stall/requests?view=active">See every active request</a> : null}
        </section>
        <section aria-labelledby="recent-preview">
          <div className="section-title">
            <h2 id="recent-preview">Recent completions</h2>
            <a href="/stall/requests?view=completed">See all</a>
          </div>
          {recent.loading && !recent.items.length ? <p className="empty-state">Loading completed requests…</p> : null}
          {recent.error ? <p className="form-error" role="alert">{recent.error} <button type="button" onClick={() => void recent.refresh()}>Try again</button></p> : null}
          {!recent.loading && !recent.error && !recent.items.length ? <p className="empty-state">No completed requests yet.</p> : null}
          <div className="exhibitor-list">
            {recent.items.map((ticket) => (
              <a className="exhibitor-card" key={ticket.id} href={'/stall/ticket/' + ticket.id}>
                <span className="status status-closed">{progressText(ticket)}</span>
                <strong>{ticket.publicNo}</strong>
                <span>{serviceText(ticket)}</span>
                {ticket.status === 'CLOSED' && ticket.closedAt ? <span>Completed {eventTime(ticket.closedAt, timeZone)}</span> : null}
              </a>
            ))}
          </div>
        </section>
      </div>
    </ExhibitorShell>
  );
}
