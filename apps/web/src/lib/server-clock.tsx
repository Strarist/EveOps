'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { operationalNow, serverClockOffset } from '@eveops/ticket-timing';

const ServerClockContext = createContext<number | null>(null);
let offsetMs: number | null = null;
const listeners = new Set<(now: number | null) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function publish() {
  const now = offsetMs == null ? null : operationalNow(Date.now(), offsetMs);
  listeners.forEach((listener) => listener(now));
}

export function noteServerTime(serverTime: string, receivedAtMs: number) {
  const next = serverClockOffset(serverTime, receivedAtMs);
  if (next == null) return;
  offsetMs = next;
  publish();
}

export function ServerClockProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState<number | null>(() => (offsetMs == null ? null : operationalNow(Date.now(), offsetMs)));
  useEffect(() => {
    listeners.add(setNow);
    if (!timer) timer = setInterval(publish, 1000);
    publish();
    return () => {
      listeners.delete(setNow);
      if (!listeners.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return <ServerClockContext.Provider value={now}>{children}</ServerClockContext.Provider>;
}

export function useOperationalNow() {
  return useContext(ServerClockContext);
}
