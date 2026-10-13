'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, subscribeRealtime } from '@/lib/api-client';
import { noteServerTime } from '@/lib/server-clock';
import { loadSessionProfile, profileSnapshot, subscribeProfile } from '@/lib/session-profile';
import { jitteredRetryMs, retryAfterMs, shouldRefreshForTicketEvent } from '@eveops/ticket-timing';
import type { StallTicket } from './format';

export type StallProfile = {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  scopes: Array<{
    event: { id: string; name: string; timezone: string };
    hall: { id: string; code: string; name: string } | null;
    stall: { stallCode: string; zone: { code: string } } | null;
  }>;
};

type ListResponse = { items: StallTicket[]; total: number; nextCursor: string | null; serverTime?: string };

export function useStallProfile() {
  const [snapshot, setSnapshot] = useState(profileSnapshot);
  useEffect(() => {
    void loadSessionProfile();
    return subscribeProfile(() => setSnapshot({ ...profileSnapshot() }));
  }, []);
  return {
    profile: snapshot.profile as StallProfile | null,
    error: snapshot.error,
    stale: snapshot.stale,
    denied: snapshot.denied,
    reload: () => loadSessionProfile(true),
  };
}

export function useConnection() {
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    const seen = new Map<string, number>();
    return subscribeRealtime({
      onConnection: setConnection,
      onTicket: (event) => {
        try {
          const data = JSON.parse(event.data) as { ticketId?: string; version?: number };
          if (!shouldRefreshForTicketEvent(seen, data)) return;
        } catch {
          // Refresh on an unreadable event.
        }
        setPulse((value) => value + 1);
      },
    });
  }, []);
  return { connection, pulse };
}

export function useStallTickets(query: string, pulse: number) {
  const [items, setItems] = useState<StallTicket[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const cooldownUntil = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const depthRef = useRef(1);
  const queryRef = useRef(query);
  const seenQuery = useRef('');
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  if (queryRef.current !== query) {
    queryRef.current = query;
    depthRef.current = 1;
  }

  const refresh = useCallback(async (cursor?: string, append = false) => {
    if (Date.now() < cooldownUntil.current) return;
    const request = ++sequence.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    if (!append && seenQuery.current !== query) setLoading(true);
    try {
      const collected: StallTicket[] = [];
      let pageCursor = append ? cursor : undefined;
      let totalCount = 0;
      let next: string | null = null;
      const pages = append ? 1 : Math.max(1, depthRef.current);
      let fetched = 0;
      for (let page = 0; page < pages; page += 1) {
        const parameters = new URLSearchParams(query);
        if (pageCursor) parameters.set('cursor', pageCursor);
        const response = await apiFetch('/api/tickets?' + parameters.toString(), { credentials: 'include', cache: 'no-store', signal: abort.signal });
        if (response.status === 429) {
          const wait = jitteredRetryMs(retryAfterMs(response.headers.get('retry-after')), Math.random());
          cooldownUntil.current = Date.now() + wait;
          if (request !== sequence.current) return;
          setStale(true);
          setError('Requests are busy right now. Showing the last loaded list.');
          if (retryTimer.current) clearTimeout(retryTimer.current);
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            cooldownUntil.current = 0;
            void refresh();
          }, wait);
          return;
        }
        if (response.status === 401) {
          setError('Session expired');
          setStale(false);
          return;
        }
        if (response.status === 403) {
          setError('You no longer have access to these requests.');
          setStale(false);
          return;
        }
        if (!response.ok) throw new Error('Requests could not be loaded');
        const receivedAt = Date.now();
        const result = await response.json() as ListResponse;
        if (request !== sequence.current) return;
        if (result.serverTime) noteServerTime(result.serverTime, receivedAt);
        collected.push(...result.items);
        totalCount = result.total;
        next = result.nextCursor;
        fetched += 1;
        if (!next) break;
        pageCursor = next;
      }
      if (request !== sequence.current) return;
      setItems((current) => append ? [...current, ...collected] : collected);
      setTotal(totalCount);
      setNextCursor(next);
      depthRef.current = append ? depthRef.current + 1 : fetched;
      setError('');
      setStale(false);
      seenQuery.current = query;
    } catch (cause) {
      if (abort.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Requests could not be loaded');
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    if (Date.now() < cooldownUntil.current) return;
    const wait = pulse === 0 ? 0 : jitteredRetryMs(400, Math.random());
    const timer = window.setTimeout(() => { void refresh(); }, wait);
    return () => window.clearTimeout(timer);
  }, [refresh, pulse]);
  useEffect(() => () => {
    controller.current?.abort();
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  return {
    items,
    total,
    nextCursor,
    loading,
    error,
    stale,
    refresh,
    loadMore: () => nextCursor ? refresh(nextCursor, true) : Promise.resolve(),
  };
}

export type TicketLoadState = 'loading' | 'ready' | 'missing' | 'inaccessible' | 'error';

export function useStallTicket(id: string, pulse: number) {
  const [ticket, setTicket] = useState<StallTicket | null>(null);
  const [state, setState] = useState<TicketLoadState>('loading');
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const cooldownUntil = useRef(0);

  const load = useCallback(async () => {
    if (Date.now() < cooldownUntil.current) return;
    const request = ++sequence.current;
    setError('');
    try {
      const response = await apiFetch('/api/tickets/' + id, { credentials: 'include', cache: 'no-store' });
      if (request !== sequence.current) return;
      if (response.status === 403) {
        setTicket(null);
        setState('inaccessible');
        return;
      }
      if (response.status === 404 || response.status === 400) {
        const body = await response.json().catch(() => ({})) as { message?: string };
        const message = Array.isArray(body.message) ? body.message[0] : body.message;
        if (response.status === 404 || /not found/i.test(message ?? '')) {
          setTicket(null);
          setState('missing');
          return;
        }
        if (/outside your scope|not assigned|access/i.test(message ?? '')) {
          setTicket(null);
          setState('inaccessible');
          return;
        }
        setTicket(null);
        setState('error');
        setError(message || 'This request could not be loaded');
        return;
      }
      if (response.status === 429) {
        const wait = jitteredRetryMs(retryAfterMs(response.headers.get('retry-after')), Math.random());
        cooldownUntil.current = Date.now() + wait;
        setError('This request is busy right now. Showing the last loaded details.');
        setState((current) => current === 'ready' ? current : 'error');
        window.setTimeout(() => {
          cooldownUntil.current = 0;
          void load();
        }, wait);
        return;
      }
      if (response.status === 401) {
        setError('Session expired');
        setState('error');
        return;
      }
      if (!response.ok) throw new Error('This request could not be loaded');
      const receivedAt = Date.now();
      const body = await response.json() as StallTicket & { serverTime?: string };
      if (body.serverTime) noteServerTime(body.serverTime, receivedAt);
      setTicket(body);
      setState('ready');
    } catch (cause) {
      if (request !== sequence.current) return;
      const message = cause instanceof TypeError ? 'This request could not be loaded' : cause instanceof Error ? cause.message : 'This request could not be loaded';
      setError(message);
      setState((current) => current === 'ready' ? current : 'error');
    }
  }, [id]);

  useEffect(() => {
    setTicket(null);
    setState('loading');
  }, [id]);
  useEffect(() => {
    if (Date.now() < cooldownUntil.current) return;
    const wait = pulse === 0 ? 0 : jitteredRetryMs(400, Math.random());
    const timer = window.setTimeout(() => { void load(); }, wait);
    return () => window.clearTimeout(timer);
  }, [load, pulse]);

  return { ticket, state, error, reload: load };
}
