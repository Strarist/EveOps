const SOUND_KEY = 'eveops-sound';
const PLAYED_KEY = 'eveops-played-alerts';
const SILENCED_KEY = 'eveops-silenced-alerts';

let activeUserId = '';

/** Staff alerts are stored per account so a later login does not inherit them. */
export function bindAlertUser(userId: string) {
  if (activeUserId !== userId) stopSound();
  activeUserId = userId;
}

function scopedKey(base: string) {
  return activeUserId ? `${base}:${activeUserId}` : null;
}

function readList(key: string) {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function soundEnabled() {
  const key = scopedKey(SOUND_KEY);
  return key !== null && typeof window !== 'undefined' && window.localStorage.getItem(key) === 'on';
}

export function setSoundEnabled(enabled: boolean) {
  const key = scopedKey(SOUND_KEY);
  if (!key || typeof window === 'undefined') return;
  window.localStorage.setItem(key, enabled ? 'on' : 'off');
}

export function soundStatus() {
  if (typeof window === 'undefined') return 'blocked';
  if (!soundEnabled()) return 'off';
  return 'on';
}

let context: AudioContext | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
let pulseTimer: ReturnType<typeof setInterval> | null = null;
let playingId: string | null = null;

function audioContext() {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!context) context = new Ctx();
  return context;
}

function tone(ctx: AudioContext, frequency: number, start: number, duration: number) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration);
}

export async function enableSound() {
  const ctx = audioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  setSoundEnabled(ctx.state === 'running');
  return ctx.state === 'running';
}

export async function testSound() {
  const ok = await enableSound();
  if (!ok || !context) return false;
  tone(context, 880, context.currentTime, 0.18);
  tone(context, 660, context.currentTime + 0.2, 0.22);
  return true;
}

export function stopSound() {
  if (stopTimer) clearTimeout(stopTimer);
  if (pulseTimer) clearInterval(pulseTimer);
  stopTimer = null;
  pulseTimer = null;
  playingId = null;
}

export function playedAlerts(): string[] {
  const key = scopedKey(PLAYED_KEY);
  if (!key || typeof window === 'undefined') return [];
  return readList(key);
}

export function rememberAlert(id: string) {
  const key = scopedKey(PLAYED_KEY);
  if (!key || typeof window === 'undefined') return;
  const next = [...new Set([...playedAlerts(), id])].slice(-200);
  sessionStorage.setItem(key, JSON.stringify(next));
}

export function silencedAlerts(): string[] {
  const key = scopedKey(SILENCED_KEY);
  if (!key || typeof window === 'undefined') return [];
  return readList(key);
}

export function silenceAlert(id: string) {
  stopSound();
  const key = scopedKey(SILENCED_KEY);
  if (!key || typeof window === 'undefined') return;
  const next = [...new Set([...silencedAlerts(), id])].slice(-200);
  sessionStorage.setItem(key, JSON.stringify(next));
}

export async function playRepeatAlert(id: string, durationMs = 20000) {
  if (!soundEnabled() || playingId) return false;
  if (playedAlerts().includes(id)) return false;
  const ctx = audioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => undefined);
  }
  if (ctx.state !== 'running') return false;
  playingId = id;
  rememberAlert(id);
  const pulse = () => {
    if (!context || playingId !== id) return;
    const start = context.currentTime;
    tone(context, 740, start, 0.16);
    tone(context, 988, start + 0.18, 0.18);
  };
  pulse();
  pulseTimer = setInterval(pulse, 1400);
  stopTimer = setTimeout(() => stopSound(), durationMs);
  return true;
}

export async function playOnce(id: string) {
  if (!soundEnabled() || playedAlerts().includes(id)) return false;
  const ctx = audioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  if (ctx.state !== 'running') return false;
  rememberAlert(id);
  tone(ctx, 880, ctx.currentTime, 0.16);
  return true;
}
