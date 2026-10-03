'use client';

import { jitteredRetryMs, retryAfterMs } from '@eveops/ticket-timing';
import { AUTH_LOST_EVENT, apiFetch } from './api-client';

export type SessionProfile = {
  id: string;
  name: string;
  role?: string;
  email?: string | null;
  phone?: string | null;
  mustChangePassword?: boolean;
  scopes: Array<{
    event: { id: string; name: string; timezone: string };
    hall: { id: string; code: string; name: string } | null;
    stall: { id?: string; stallCode: string; zone: { code: string } } | null;
    serviceType: string | null;
  }>;
};

type Snapshot = {
  profile: SessionProfile | null;
  error: string;
  stale: boolean;
  denied: boolean;
};

const listeners = new Set<() => void>();
let snapshot: Snapshot = { profile: null, error: '', stale: false, denied: false };
let pending: Promise<SessionProfile | null> | null = null;
let cooldownUntil = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  listeners.forEach((listener) => listener());
}

if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_LOST_EVENT, () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    cooldownUntil = 0;
    pending = null;
    snapshot = { profile: null, error: 'Session expired', stale: false, denied: false };
    emit();
  });
}

export function profileSnapshot() {
  return snapshot;
}

export function subscribeProfile(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function scheduleProfileRetry(waitMs: number) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void loadSessionProfile(true);
  }, waitMs);
}

export function loadSessionProfile(force = false): Promise<SessionProfile | null> {
  if (pending) return pending;
  if (!force && snapshot.profile && !snapshot.stale) return Promise.resolve(snapshot.profile);
  if (Date.now() < cooldownUntil) {
    if (!snapshot.profile && !snapshot.error) {
      snapshot = { ...snapshot, error: 'Account details are busy right now. Try again.' };
      emit();
    }
    return Promise.resolve(snapshot.profile);
  }
  pending = (async () => {
    const response = await apiFetch('/api/auth/profile', { credentials: 'include', cache: 'no-store' });
    if (response.status === 429) {
      const wait = jitteredRetryMs(retryAfterMs(response.headers.get('retry-after')), Math.random());
      cooldownUntil = Date.now() + wait;
      snapshot = {
        profile: snapshot.profile,
        error: snapshot.profile ? '' : 'Account details are busy right now. Try again.',
        stale: Boolean(snapshot.profile),
        denied: false,
      };
      emit();
      scheduleProfileRetry(wait);
      return snapshot.profile;
    }
    if (response.status === 401) {
      snapshot = { profile: null, error: 'Session expired', stale: false, denied: false };
      emit();
      return null;
    }
    if (response.status === 403) {
      snapshot = { profile: null, error: 'You no longer have access to this account.', stale: false, denied: true };
      emit();
      return null;
    }
    if (!response.ok) {
      snapshot = {
        profile: snapshot.profile,
        error: snapshot.profile ? '' : 'Account details could not be loaded',
        stale: Boolean(snapshot.profile),
        denied: false,
      };
      emit();
      return snapshot.profile;
    }
    const profile = await response.json() as SessionProfile;
    cooldownUntil = 0;
    snapshot = { profile, error: '', stale: false, denied: false };
    emit();
    return profile;
  })().finally(() => {
    pending = null;
  });
  return pending;
}
