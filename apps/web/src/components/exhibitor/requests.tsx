'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ExhibitorShell } from './shell';
import { useConnection, useStallProfile, useStallTickets } from './data';
import { eventTime, progressText, serviceText } from './format';

const views = [
  { id: 'active', label: 'Active' },
  { id: 'completed', label: 'Completed' },
  { id: 'all', label: 'All' },
] as const;

export function ExhibitorRequests() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requested = searchParams.get('view');
  const view = requested === 'completed' || requested === 'all' ? requested : 'active';
  const q = searchParams.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const { connection, pulse } = useConnection();
  const { profile } = useStallProfile(connection + pulse);
  const timeZone = profile?.scopes.find((scope) => scope.event.timezone)?.event.timezone ?? 'UTC';
  const apiView = view === 'completed' ? 'closed' : view;
  const query = `view=${apiView}&limit=20${view === 'completed' ? '' : '&sort=recent'}${q.trim() ? '&search=' + encodeURIComponent(q.trim()) : ''}`;
  const list = useStallTickets(query, pulse);

  useEffect(() => { setDraft(q); }, [q]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (draft.trim() === q.trim()) return;
      const parameters = new URLSearchParams(searchParams.toString());
      if (draft.trim()) parameters.set('q', draft.trim());
      else parameters.delete('q');
      const next = parameters.toString();
      router.replace(next ? '/stall/requests?' + next : '/stall/requests');
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, q, router, searchParams]);

  function choose(nextView: string) {
    const parameters = new URLSearchParams(searchParams.toString());
    parameters.set('view', nextView);
    router.replace('/stall/requests?' + parameters.toString());
  }

  return (
    <ExhibitorShell>
      <section className="exhibitor-requests" aria-labelledby="my-requests">
        <div className="section-title">
          <div>
            <h2 id="my-requests">My requests</h2>
            <p>{list.loading && !list.items.length ? 'Loading your requests.' : `${list.total} in this list. Showing ${list.items.length}.`}</p>
          </div>
        </div>
        <div className="exhibitor-filters" role="group" aria-label="Request filter">
          {views.map((item) => (
            <button type="button" key={item.id} className={view === item.id ? 'is-selected' : ''} aria-pressed={view === item.id} onClick={() => choose(item.id)}>{item.label}</button>
          ))}
        </div>
        <label className="field">Search
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Request number or description" aria-label="Search requests" />
        </label>
        {list.loading && !list.items.length ? <p className="empty-state">Loading your requests…</p> : null}
        {list.error ? <p className="form-error" role="alert">{list.error} <button type="button" onClick={() => void list.refresh()}>Try again</button></p> : null}
        {!list.loading && !list.error && !list.items.length ? <p className="empty-state">{q.trim() ? 'No requests match this search.' : 'No requests in this list.'}</p> : null}
        <div className="exhibitor-list">
          {list.items.map((ticket) => (
            <a className="exhibitor-card" key={ticket.id} href={'/stall/ticket/' + ticket.id}>
              <span className={'status status-' + ticket.status.toLowerCase()}>{progressText(ticket)}</span>
              <strong>{ticket.publicNo}</strong>
              <span>{serviceText(ticket)}</span>
              <span>{ticket.description}</span>
              <span>Raised {eventTime(ticket.createdAt, timeZone)}</span>
              {ticket.status === 'CLOSED' && ticket.closedAt ? <span>Completed {eventTime(ticket.closedAt, timeZone)}</span> : null}
            </a>
          ))}
        </div>
        {list.nextCursor ? <button type="button" className="secondary-action" onClick={() => void list.loadMore()}>Load more</button> : null}
      </section>
    </ExhibitorShell>
  );
}
