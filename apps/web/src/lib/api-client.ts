export const AUTH_LOST_EVENT = 'eveops:auth-lost';
export const ACCESS_DENIED_EVENT = 'eveops:access-denied';

let authLost = false;
type RealtimeSubscriber = {
  onTicket: (event: MessageEvent<string>) => void;
  onConnection: (state: 'live' | 'reconnecting') => void;
};
const realtimeSubscribers = new Set<RealtimeSubscriber>();
let eventSource: EventSource | null = null;
let lastAuthProbeAt = 0;

function notifyRealtimeSubscribers(event: MessageEvent<string>) {
  realtimeSubscribers.forEach((item) => item.onTicket(event));
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  if (authLost) throw new Error('Authentication expired');
  const method = (init?.method ?? 'GET').toUpperCase();
  let response: Response;
  try {
    response = await globalThis.fetch(input, { credentials: 'include', ...init });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (method !== 'GET') throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    response = await globalThis.fetch(input, { credentials: 'include', ...init });
  }
  if (method === 'GET' && [502, 503, 504].includes(response.status)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    response = await globalThis.fetch(input, { credentials: 'include', ...init });
  }
  if (response.status === 401) {
    authLost = true;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(AUTH_LOST_EVENT));
      const governance = window.location.pathname.startsWith('/super-admin');
      window.location.replace(governance ? '/governance-access' : '/login');
    }
  } else if (response.status === 403 && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(ACCESS_DENIED_EVENT));
  }
  return response;
}

/** Map Nest/API failures to safe operational copy for field UIs. */
export async function apiErrorMessage(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({})) as { message?: string | string[]; correlationId?: string; requestId?: string };
  const raw = Array.isArray(payload.message) ? payload.message[0] : payload.message;
  const reference = payload.correlationId ?? payload.requestId;
  if (response.status >= 500) {
    return reference ? `Something went wrong. Please try again. Reference: ${reference}` : 'Something went wrong. Please try again.';
  }
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (normalized.includes('invalid otp')) return 'Incorrect code. Check with the stall and try again.';
  if (normalized.includes('otp expired') || normalized.includes('unavailable or expired')) {
    return 'This code has expired. Ask the stall to generate a new code.';
  }
  if (normalized.includes('already') && normalized.includes('closed')) return 'This ticket has already been completed.';
  if (normalized.includes('not assigned') || normalized.includes('access')) return 'You no longer have access to this ticket.';
  if (normalized.includes('prisma') || normalized.includes('database') || normalized.includes('econn') || normalized.includes('stack')) {
    return fallback;
  }
  if (raw.length > 180) return fallback;
  return raw;
}

export function subscribeRealtime(subscriber: RealtimeSubscriber) {
  realtimeSubscribers.add(subscriber);
  if (!eventSource && !authLost) {
    eventSource = new EventSource('/api/tickets/stream/live', { withCredentials: true });
    eventSource.onopen = () => realtimeSubscribers.forEach((item) => item.onConnection('live'));
    eventSource.onerror = () => {
      realtimeSubscribers.forEach((item) => item.onConnection('reconnecting'));
      if (Date.now() - lastAuthProbeAt > 30000) {
        lastAuthProbeAt = Date.now();
        void apiFetch('/api/auth/me', { cache: 'no-store' });
      }
    };
    eventSource.addEventListener('ticket.updated', (event) => {
      notifyRealtimeSubscribers(event as MessageEvent<string>);
    });
    eventSource.addEventListener('workforce.updated', (event) => {
      notifyRealtimeSubscribers(event as MessageEvent<string>);
    });
  }
  const closeOnAuthLoss = () => {
    eventSource?.close();
    eventSource = null;
  };
  window.addEventListener(AUTH_LOST_EVENT, closeOnAuthLoss, { once: true });
  return () => {
    realtimeSubscribers.delete(subscriber);
    window.removeEventListener(AUTH_LOST_EVENT, closeOnAuthLoss);
    if (!realtimeSubscribers.size) {
      eventSource?.close();
      eventSource = null;
    }
  };
}
