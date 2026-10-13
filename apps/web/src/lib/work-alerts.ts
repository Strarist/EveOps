import { claimTabPlayback, cuesToRing, enqueueCues, planAlertSetup, type AlertCue, type AudioChoice, type PermissionChoice } from '../../../../packages/operations/src/alert-session';
import { apiFetch } from './api-client';

const SETUP_KEY = 'eveops-alert-setup';
const CURSOR_KEY = 'eveops-alert-cursor';
const ACK_KEY = 'eveops-alert-ack';
const CLAIM_KEY = 'eveops-alert-claim';

export type WorkAlert = AlertCue & {
  summary: string;
  href: string;
  audience: string;
};

type Capability = {
  notification: PermissionChoice;
  audio: AudioChoice;
  push: 'registered' | 'failed' | 'skipped';
  recovery: string | null;
  ready: boolean;
};

let boundUser = '';
let tabId = '';
let channel: BroadcastChannel | null = null;
let context: AudioContext | null = null;
let playingId: string | null = null;
let queue: string[] = [];
let catalog = new Map<string, WorkAlert>();
let stopTimer: ReturnType<typeof setTimeout> | null = null;
let pulseTimer: ReturnType<typeof setInterval> | null = null;
let claimTimer: ReturnType<typeof setInterval> | null = null;
let listener: (() => void) | null = null;

function scoped(base: string) {
  return boundUser ? `${base}:${boundUser}` : '';
}

function readList(key: string) {
  if (!key || typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(key: string, values: string[]) {
  if (!key) return;
  sessionStorage.setItem(key, JSON.stringify(values.slice(-200)));
}

export function bindWorkAlerts(userId: string) {
  if (boundUser === userId) return;
  releaseWorkAlerts();
  boundUser = userId;
  tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  retireLegacySoundPrefs();
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(`eveops-alerts:${userId}`);
    channel.onmessage = (event: MessageEvent<{ type?: string; id?: string; tabId?: string }>) => {
      const message = event.data;
      if (!message?.id || message.tabId === tabId) return;
      if (message.type === 'playing' || message.type === 'ack') {
        queue = queue.filter((id) => id !== message.id);
        if (playingId === message.id && message.type === 'playing') stopPlayback();
        if (message.type === 'ack') rememberAck(message.id);
        listener?.();
      }
      if (message.type === 'release' && message.id) {
        const alert = catalog.get(message.id);
        const acknowledged = readList(scoped(ACK_KEY));
        if (alert?.actionable && !acknowledged.includes(message.id)) {
          queue = enqueueCues(queue, playingId, [message.id]);
        }
        void startNext();
      }
    };
  }
}

export function releaseWorkAlerts() {
  releaseClaim();
  stopPlayback();
  queue = [];
  catalog = new Map();
  channel?.close();
  channel = null;
  boundUser = '';
  if (typeof window !== 'undefined') window.removeEventListener('pagehide', releaseClaim);
}

export function onWorkAlertsChanged(next: () => void) {
  listener = next;
  return () => { if (listener === next) listener = null; };
}

export function currentRinging() {
  return playingId ? catalog.get(playingId) ?? null : null;
}

export function setupCompleted(userId: string) {
  return typeof window !== 'undefined' && window.localStorage.getItem(`${SETUP_KEY}:${userId}`) === 'done';
}

export function measureAlertCapability(): Capability {
  const notification = notificationChoice();
  const audio = audioChoice();
  const plan = planAlertSetup({
    notification,
    audio,
    pushConfigured: true,
    alreadyAsked: true,
    subscription: 'skipped',
  });
  return { notification, audio, push: 'skipped', recovery: plan.recovery, ready: audio === 'running' && (notification === 'granted' || notification === 'unsupported') };
}

export async function enableWorkAlerts(userId: string): Promise<Capability> {
  bindWorkAlerts(userId);
  const audio = await resumeAudio();
  const notification = await askNotification();
  let push: Capability['push'] = 'skipped';
  if (notification === 'granted') push = await registerPush();
  const plan = planAlertSetup({
    notification,
    audio,
    pushConfigured: true,
    alreadyAsked: true,
    subscription: push,
  });
  window.localStorage.setItem(`${SETUP_KEY}:${userId}`, 'done');
  window.addEventListener('pagehide', releaseClaim);
  return { notification, audio, push, recovery: plan.recovery, ready: plan.ready };
}

export function syncWorkAlerts(rows: WorkAlert[], now = new Date().toISOString()) {
  if (!boundUser) return;
  catalog = new Map(rows.map((row) => [row.id, row]));
  const cursorKey = scoped(CURSOR_KEY);
  const cursor = cursorKey ? sessionStorage.getItem(cursorKey) : null;
  const decided = cuesToRing({
    incoming: rows,
    cursor,
    acknowledged: readList(scoped(ACK_KEY)),
    played: [],
    now,
  });
  if (cursorKey) sessionStorage.setItem(cursorKey, decided.nextCursor);
  const closed = new Set(rows.filter((row) => !row.actionable).map((row) => row.id));
  queue = enqueueCues(queue.filter((id) => !closed.has(id)), playingId, decided.ring.map((row) => row.id));
  if (playingId && closed.has(playingId)) stopPlayback();
  void startNext();
  listener?.();
}

export function acknowledgeAlert(id: string) {
  rememberAck(id);
  queue = queue.filter((item) => item !== id);
  if (playingId === id) stopPlayback();
  channel?.postMessage({ type: 'ack', id, tabId });
  void startNext();
  listener?.();
  void apiFetch('/api/notifications/' + id + '/read', { method: 'PATCH', credentials: 'include' }).catch(() => undefined);
}

export function silenceCurrent() {
  if (!playingId) return;
  const id = playingId;
  queue = queue.filter((item) => item !== id);
  stopPlayback();
  channel?.postMessage({ type: 'playing', id, tabId });
  void startNext();
  listener?.();
}

function rememberAck(id: string) {
  const key = scoped(ACK_KEY);
  writeList(key, [...readList(key), id]);
}

function notificationChoice(): PermissionChoice {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied' || Notification.permission === 'default') {
    return Notification.permission;
  }
  return 'unsupported';
}

function audioChoice(): AudioChoice {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return 'unsupported';
  if (!context) return 'suspended';
  if (context.state === 'running') return 'running';
  if (context.state === 'suspended') return 'suspended';
  return 'blocked';
}

async function resumeAudio(): Promise<AudioChoice> {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return 'unsupported';
  if (!context) context = new Ctx();
  if (context.state === 'suspended') await context.resume().catch(() => undefined);
  return audioChoice();
}

async function askNotification(): Promise<PermissionChoice> {
  const current = notificationChoice();
  if (current !== 'default') return current;
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted' || result === 'denied' || result === 'default') return result;
  } catch {
    return 'default';
  }
  return 'default';
}

async function registerPush(): Promise<Capability['push']> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'skipped';
  try {
    const config = await apiFetch('/api/notifications/push-config', { credentials: 'include', cache: 'no-store' });
    const body = await config.json() as { configured?: boolean; publicKey?: string | null };
    if (!config.ok || !body.configured || !body.publicKey) return 'skipped';
    const registration = await navigator.serviceWorker.register('/sw.js');
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(body.publicKey),
    });
    const json = subscription.toJSON();
    const saved = await apiFetch('/api/notifications/push-subscription', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth }),
    });
    if (json.endpoint) window.localStorage.setItem(`eveops-push-endpoint:${boundUser}`, json.endpoint);
    return saved.ok ? 'registered' : 'failed';
  } catch {
    return 'failed';
  }
}

function urlBase64ToBytes(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

async function startNext() {
  if (playingId || !queue.length || !boundUser) return;
  const id = queue[0];
  const alert = catalog.get(id);
  if (!alert?.actionable) {
    queue.shift();
    return startNext();
  }
  const audio = await resumeAudio();
  if (audio !== 'running') return;
  if (!await holdClaim(id)) return;
  queue.shift();
  playingId = id;
  channel?.postMessage({ type: 'playing', id, tabId });
  const pulseMs = alert.tone === 'operational' ? 1100 : 1400;
  const pulse = () => {
    if (!context || playingId !== id) return;
    const start = context.currentTime;
    if (alert.tone === 'assignment') {
      tone(context, 740, start, 0.16);
      tone(context, 988, start + 0.2, 0.18);
    } else {
      tone(context, 520, start, 0.18);
      tone(context, 780, start + 0.22, 0.2);
    }
  };
  pulse();
  pulseTimer = setInterval(pulse, pulseMs);
  stopTimer = setTimeout(() => {
    if (playingId === id) stopPlayback();
    void startNext();
    listener?.();
  }, 20000);
  claimTimer = setInterval(() => writeClaim(id), 2000);
  listener?.();
}

async function holdClaim(id: string) {
  const key = scoped(CLAIM_KEY);
  if (!key) return false;
  const raw = window.localStorage.getItem(key);
  let claim: { tabId: string; until: number } | null = null;
  if (raw) {
    try { claim = JSON.parse(raw) as { tabId: string; until: number }; } catch { claim = null; }
  }
  if (!claimTabPlayback({ tabId, claim, now: Date.now() })) return false;
  writeClaim(id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const confirmed = window.localStorage.getItem(key);
  return Boolean(confirmed && confirmed.includes(tabId));
}

function writeClaim(id: string) {
  const key = scoped(CLAIM_KEY);
  if (!key) return;
  window.localStorage.setItem(key, JSON.stringify({ tabId, until: Date.now() + 5000, id }));
}

function releaseClaim() {
  const key = scoped(CLAIM_KEY);
  if (!key) return;
  const raw = window.localStorage.getItem(key);
  if (raw?.includes(tabId)) {
    window.localStorage.removeItem(key);
    if (playingId) channel?.postMessage({ type: 'release', id: playingId, tabId });
  }
}

function stopPlayback() {
  if (stopTimer) clearTimeout(stopTimer);
  if (pulseTimer) clearInterval(pulseTimer);
  if (claimTimer) clearInterval(claimTimer);
  stopTimer = null;
  pulseTimer = null;
  claimTimer = null;
  playingId = null;
}

function tone(ctx: AudioContext, frequency: number, start: number, duration: number) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration);
}

function retireLegacySoundPrefs() {
  const stale: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith('eveops-sound')) stale.push(key);
  }
  for (const key of stale) window.localStorage.removeItem(key);
}

export async function clearPushForLogout() {
  const endpoint = boundUser ? window.localStorage.getItem(`eveops-push-endpoint:${boundUser}`) : window.localStorage.getItem('eveops-push-endpoint');
  if (endpoint) {
    await apiFetch('/api/notifications/push-subscription', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, p256dh: 'placeholder', auth: 'placeholder' }),
    }).catch(() => undefined);
    if (boundUser) window.localStorage.removeItem(`eveops-push-endpoint:${boundUser}`);
  }
}
