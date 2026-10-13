export type AlertCue = {
  id: string;
  sentAt: string;
  actionable: boolean;
  tone: 'assignment' | 'operational';
};

/** Unread history stays listed. Ringing starts only for alerts that arrived after the last sync. */
export function cuesToRing(input: {
  incoming: AlertCue[];
  cursor: string | null;
  acknowledged: string[];
  played: string[];
  now: string;
}) {
  const seen = new Set([...input.acknowledged, ...input.played]);
  const cursorMs = input.cursor ? Date.parse(input.cursor) : Number.NaN;
  const ring = input.cursor
    ? input.incoming.filter((cue) => {
      if (!cue.actionable || seen.has(cue.id)) return false;
      const sent = Date.parse(cue.sentAt);
      return Number.isFinite(sent) && sent > cursorMs;
    })
    : [];
  const newest = input.incoming.reduce((max, cue) => cue.sentAt > max ? cue.sentAt : max, input.cursor ?? input.now);
  return { ring, nextCursor: newest > (input.cursor ?? '') ? newest : (input.cursor ?? input.now) };
}

/** One sound at a time. Every distinct event stays queued; a repeated id does not stack. */
export function enqueueCues(queue: string[], playingId: string | null, incoming: string[]) {
  const next = [...queue];
  const present = new Set(playingId ? [playingId, ...queue] : queue);
  for (const id of incoming) {
    if (present.has(id)) continue;
    present.add(id);
    next.push(id);
  }
  return next;
}

export function claimTabPlayback(input: {
  tabId: string;
  claim: { tabId: string; until: number } | null;
  now: number;
}) {
  if (!input.claim || input.claim.until <= input.now) return true;
  return input.claim.tabId === input.tabId;
}

export type PermissionChoice = 'granted' | 'denied' | 'default' | 'unsupported';
export type AudioChoice = 'running' | 'suspended' | 'blocked' | 'unsupported';

export function planAlertSetup(input: {
  notification: PermissionChoice;
  audio: AudioChoice;
  pushConfigured: boolean;
  alreadyAsked: boolean;
  subscription: 'registered' | 'failed' | 'skipped';
}) {
  const requestPermission = input.notification === 'default' && !input.alreadyAsked;
  const registerPush = input.notification === 'granted' && input.pushConfigured && input.subscription !== 'registered';
  const audioReady = input.audio === 'running';
  const notificationReady = input.notification === 'granted' || input.notification === 'unsupported';
  const pushReady = input.subscription === 'registered' || input.subscription === 'skipped' || !input.pushConfigured || input.notification !== 'granted';
  let recovery: string | null = null;
  if (input.audio === 'blocked' || input.audio === 'suspended') recovery = 'Tap to hear work alerts. Visual alerts stay on.';
  else if (input.notification === 'denied') recovery = 'Alerts stay on this screen. Browser notifications are off.';
  else if (input.notification === 'default') recovery = 'Alerts stay on this screen. Browser notifications were not allowed.';
  else if (input.subscription === 'failed') recovery = 'On-screen alerts are on. This browser could not register for background alerts.';
  else if (input.notification === 'unsupported' && input.audio === 'unsupported') recovery = 'This browser can show alerts on screen only.';
  return {
    requestPermission,
    registerPush,
    recovery,
    ready: audioReady && notificationReady && pushReady && !recovery,
  };
}
