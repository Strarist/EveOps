import type { Prisma, PrismaClient } from '@prisma/client';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const ATTEMPT_LIMIT = 5;
const DELIVERY_WINDOW_MS = 60 * 60 * 1000;

type PushDb = PrismaClient;

export type PushSubscriptionTarget = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushSend = (subscription: PushSubscriptionTarget, body: string) => Promise<void>;

type ScopeRow = { eventId: string; hallId: string | null; stallId: string | null; serviceType: string | null };

type LoadedNotification = Prisma.NotificationGetPayload<{
  include: {
    recipient: {
      select: {
        id: true;
        role: true;
        status: true;
        approvalStatus: true;
        scopes: { select: { eventId: true; hallId: true; stallId: true; serviceType: true } };
        pushSubscriptions: { select: { id: true; userId: true; endpoint: true; p256dh: true; auth: true } };
      };
    };
    ticket: {
      select: {
        id: true;
        eventId: true;
        hallId: true;
        stallId: true;
        category: true;
        stall: { select: { active: true; archivedAt: true } };
        assignments: { select: { staffId: true } };
      };
    };
  };
}>;

export type PushDecision = {
  notificationId: string;
  recipientId: string;
  authorized: boolean;
  /** The account itself can no longer receive pushes. Subscriptions are removed. */
  revokeSubscriptions: boolean;
  subscriptions: PushSubscriptionTarget[];
  body: string;
};

const notificationInclude = {
  recipient: {
    select: {
      id: true,
      role: true,
      status: true,
      approvalStatus: true,
      scopes: { select: { eventId: true, hallId: true, stallId: true, serviceType: true } },
      pushSubscriptions: { select: { id: true, userId: true, endpoint: true, p256dh: true, auth: true } },
    },
  },
  ticket: {
    select: {
      id: true,
      eventId: true,
      hallId: true,
      stallId: true,
      category: true,
      stall: { select: { active: true, archivedAt: true } },
      assignments: {
        where: { status: { in: ['ACTIVE', 'ACCEPTED'] as const } },
        select: { staffId: true },
      },
    },
  },
} satisfies Prisma.NotificationInclude;

export async function loadPushDecision(db: PushDb, notificationId: string): Promise<PushDecision | null> {
  const notification = await db.notification.findUnique({
    where: { id: notificationId },
    include: notificationInclude,
  }) as LoadedNotification | null;
  if (!notification || notification.pushedAt) return null;
  const recipient = notification.recipient;
  const accountRevoked = recipient.status !== 'ACTIVE' || recipient.approvalStatus !== 'APPROVED';
  const authorized = !accountRevoked && recipientStillAuthorized(notification, recipient.scopes);
  const payload = notification.payload && typeof notification.payload === 'object' && !Array.isArray(notification.payload)
    ? notification.payload as Record<string, unknown>
    : {};
  const summary = typeof payload.summary === 'string' && payload.summary.trim()
    ? payload.summary.trim().slice(0, 180)
    : 'You have an update';
  return {
    notificationId: notification.id,
    recipientId: recipient.id,
    authorized,
    revokeSubscriptions: accountRevoked,
    subscriptions: recipient.pushSubscriptions,
    body: JSON.stringify({
      title: 'EveOps',
      body: summary,
      url: notificationUrl(recipient.role, notification.ticketId),
      tag: notification.id,
    }),
  };
}

function recipientStillAuthorized(notification: LoadedNotification, scopes: ScopeRow[]): boolean {
  if (!notification.ticket) {
    return scopes.some((scope) => scope.eventId === notification.eventId);
  }
  const ticket = notification.ticket;
  if (ticket.eventId !== notification.eventId) return false;
  const role = notification.recipient.role;
  if (role === 'STALL') {
    return ticket.stall.active
      && !ticket.stall.archivedAt
      && scopes.some((scope) => scope.eventId === ticket.eventId && scope.stallId === ticket.stallId);
  }
  if (role === 'HALL_MANAGER') {
    return scopes.some((scope) => scope.eventId === ticket.eventId && scope.hallId === ticket.hallId);
  }
  if (role === 'STAFF') {
    const assigned = ticket.assignments.some((assignment) => assignment.staffId === notification.recipient.id);
    return assigned && scopes.some((scope) =>
      scope.eventId === ticket.eventId
      && scope.hallId === ticket.hallId
      && scope.serviceType === ticket.category);
  }
  if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
    return scopes.some((scope) => scope.eventId === ticket.eventId);
  }
  return false;
}

function notificationUrl(role: string, ticketId: string | null) {
  const ticketPath = ticketId && /^[A-Za-z0-9_-]{1,80}$/.test(ticketId) ? ticketId : null;
  const target = role === 'STAFF' && ticketPath
    ? `/staff/task/${ticketPath}`
    : role === 'STALL' && ticketPath
      ? `/stall/ticket/${ticketPath}`
      : role === 'HALL_MANAGER'
        ? '/hall-manager'
        : '/';
  return target.startsWith('/') && !target.startsWith('//') ? target : '/';
}

const blockedAddresses = new BlockList();
blockedAddresses.addSubnet('0.0.0.0', 8, 'ipv4');
blockedAddresses.addSubnet('10.0.0.0', 8, 'ipv4');
blockedAddresses.addSubnet('100.64.0.0', 10, 'ipv4');
blockedAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
blockedAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
blockedAddresses.addSubnet('172.16.0.0', 12, 'ipv4');
blockedAddresses.addSubnet('192.168.0.0', 16, 'ipv4');
blockedAddresses.addSubnet('224.0.0.0', 3, 'ipv4');
blockedAddresses.addAddress('::', 'ipv6');
blockedAddresses.addAddress('::1', 'ipv6');
blockedAddresses.addSubnet('fc00::', 7, 'ipv6');
blockedAddresses.addSubnet('fe80::', 10, 'ipv6');

export type PushEndpointVerdict = 'allow' | 'refuse' | 'retry';
type AddressRecord = { address: string; family: number };
type ResolveHost = (hostname: string) => Promise<AddressRecord[]>;

function addressBlocked(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return addressBlocked(mapped[1]);
  const version = isIP(address);
  if (version === 4) return blockedAddresses.check(address, 'ipv4');
  if (version === 6) return blockedAddresses.check(address, 'ipv6');
  return true;
}

/** HTTPS hostname only. Raw IPs, credentials, and local names never leave this process. */
export function pushEndpointShapeAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || isIP(host)) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.localdomain') || host.endsWith('.internal')) {
    return false;
  }
  return true;
}

async function resolveHost(hostname: string): Promise<AddressRecord[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family }));
}

/**
 * Confirms a stored push endpoint is a public HTTPS host.
 * `refuse` drops the subscription. `retry` is a temporary lookup failure.
 */
export async function classifyPushEndpoint(endpoint: string, resolve: ResolveHost = resolveHost): Promise<PushEndpointVerdict> {
  if (!pushEndpointShapeAllowed(endpoint)) return 'refuse';
  const host = new URL(endpoint).hostname.toLowerCase();
  try {
    const records = await resolve(host);
    if (!records.length) return 'retry';
    return records.some((record) => addressBlocked(record.address)) ? 'refuse' : 'allow';
  } catch {
    return 'retry';
  }
}

function statusCode(error: unknown) {
  if (typeof error === 'object' && error && 'statusCode' in error) {
    const status = Number((error as { statusCode?: number }).statusCode);
    return Number.isFinite(status) ? status : undefined;
  }
  return undefined;
}

/** Selects recipients again immediately before each send. Does not delete notification rows. */
export async function deliverPendingPushes(db: PushDb, send: PushSend): Promise<void> {
  const pending = await db.notification.findMany({
    where: {
      pushedAt: null,
      pushAttempts: { lt: ATTEMPT_LIMIT },
      sentAt: { gt: new Date(Date.now() - DELIVERY_WINDOW_MS) },
    },
    orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    take: 25,
    select: { id: true },
  });
  for (const item of pending) {
    await deliverNotificationPush(db, item.id, send);
  }
}

export async function deliverNotificationPush(db: PushDb, notificationId: string, send: PushSend): Promise<void> {
  const decision = await loadPushDecision(db, notificationId);
  if (!decision) return;
  if (!decision.authorized) {
    await suppressPush(db, decision);
    return;
  }
  if (!decision.subscriptions.length) {
    await db.notification.updateMany({
      where: { id: notificationId, pushedAt: null },
      data: { pushedAt: new Date(), pushAttempts: { increment: 1 } },
    });
    return;
  }
  let failed = false;
  for (const subscription of decision.subscriptions) {
    const fresh = await loadPushDecision(db, notificationId);
    if (!fresh?.authorized) {
      if (fresh) await suppressPush(db, fresh);
      return;
    }
    const current = await db.pushSubscription.findUnique({ where: { id: subscription.id } });
    if (!current || current.userId !== fresh.recipientId) continue;
    if (!pushEndpointShapeAllowed(current.endpoint)) {
      await db.pushSubscription.delete({ where: { id: current.id } }).catch(() => undefined);
      continue;
    }
    try {
      await send(current, fresh.body);
    } catch (error) {
      const status = statusCode(error);
      if (status === 404 || status === 410) {
        await db.pushSubscription.delete({ where: { id: current.id } }).catch(() => undefined);
      } else {
        failed = true;
      }
    }
  }
  await db.notification.updateMany({
    where: { id: notificationId, pushedAt: null },
    data: failed
      ? { pushAttempts: { increment: 1 } }
      : { pushedAt: new Date(), pushAttempts: { increment: 1 } },
  });
}

async function suppressPush(db: PushDb, decision: PushDecision) {
  if (decision.revokeSubscriptions) {
    await db.pushSubscription.deleteMany({ where: { userId: decision.recipientId } });
  }
  await db.notification.updateMany({
    where: { id: decision.notificationId, pushedAt: null },
    data: { pushAttempts: ATTEMPT_LIMIT },
  });
}
