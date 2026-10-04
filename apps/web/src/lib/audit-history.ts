'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { jitteredRetryMs, retryAfterMs } from '@eveops/ticket-timing';
import { apiFetch, AUTH_LOST_EVENT } from './api-client';

export type AuditRow = {
  id: string;
  kind?: string;
  eventType: string;
  createdAt: string;
  actor: { name: string; role?: string } | null;
  ticket: { publicNo: string };
};

type AuditPage = { items: AuditRow[]; nextCursor: string | null };

export function readAuditPage(body: unknown): AuditPage {
  if (!body || typeof body !== 'object') return { items: [], nextCursor: null };
  const record = body as { items?: unknown; nextCursor?: unknown };
  if (!Array.isArray(record.items)) return { items: [], nextCursor: null };
  return {
    items: record.items as AuditRow[],
    nextCursor: typeof record.nextCursor === 'string' ? record.nextCursor : null,
  };
}

function rowKey(row: AuditRow) {
  return `${row.kind ?? 'ticket'}:${row.id}`;
}

export function useAuditHistory(enabled: boolean, ticket: string, action: string) {
  const [items, setItems] = useState<AuditRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const clearRetry = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    const id = ++request.current;
    clearRetry();
    const parameters = new URLSearchParams();
    parameters.set('limit', '50');
    if (ticket.trim()) parameters.set('ticket', ticket.trim());
    if (action.trim()) parameters.set('action', action.trim());
    if (cursor) parameters.set('cursor', cursor);
    let response: Response;
    try {
      response = await apiFetch('/api/management/audit?' + parameters.toString(), { credentials: 'include', cache: 'no-store' });
    } catch {
      if (id !== request.current) return;
      setStale(itemsRef.current.length > 0);
      setError('Audit history could not be loaded. Showing the last loaded records.');
      setLoaded(true);
      return;
    }
    if (id !== request.current) return;
    if (response.status === 429) {
      const wait = jitteredRetryMs(retryAfterMs(response.headers.get('retry-after')), Math.random());
      setStale(true);
      setError('Audit history is busy right now. Showing the last loaded records.');
      setLoaded(true);
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null;
        void load(cursor, append);
      }, wait);
      return;
    }
    if (response.status === 401) {
      setStale(false);
      setError('Session expired');
      setLoaded(true);
      return;
    }
    if (response.status === 403) {
      setStale(false);
      setError('You no longer have access to this history.');
      setLoaded(true);
      return;
    }
    if (!response.ok) {
      setStale(itemsRef.current.length > 0);
      setError('Audit history could not be loaded. Showing the last loaded records.');
      setLoaded(true);
      return;
    }
    const page = readAuditPage(await response.json());
    if (id !== request.current) return;
    setItems((current) => {
      const combined = append ? [...current, ...page.items] : page.items;
      const seen = new Set<string>();
      return combined.filter((row) => {
        const key = rowKey(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
    setNextCursor(page.nextCursor);
    setStale(false);
    setError('');
    setLoaded(true);
  }, [action, clearRetry, ticket]);

  useEffect(() => {
    if (!enabled) return;
    setLoaded(false);
    const timer = setTimeout(() => { void load(null, false); }, 300);
    return () => {
      clearTimeout(timer);
      clearRetry();
      request.current += 1;
    };
  }, [enabled, ticket, action, load, clearRetry]);

  useEffect(() => {
    const reset = () => {
      clearRetry();
      setItems([]);
      setNextCursor(null);
      setStale(false);
      setError('Session expired');
      setLoaded(true);
    };
    window.addEventListener(AUTH_LOST_EVENT, reset);
    return () => window.removeEventListener(AUTH_LOST_EVENT, reset);
  }, [clearRetry]);

  return {
    items,
    nextCursor,
    loaded,
    stale,
    error,
    refresh: () => load(null, false),
    loadMore: () => nextCursor ? load(nextCursor, true) : Promise.resolve(),
  };
}
