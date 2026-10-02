import type { TicketStatus } from '@eveops/contracts';
import { serviceLabel } from '@/lib/activity-copy';

export type StallTicket = {
  id: string;
  publicNo: string;
  category: string;
  subtype: string;
  status: TicketStatus;
  description: string;
  priority?: 'NORMAL' | 'URGENT';
  createdAt: string;
  closedAt?: string | null;
  cancelledAt?: string | null;
  complaintRaisedAt?: string | null;
  completionRequestedAt?: string | null;
  firstStartedAt?: string | null;
  reopenCount?: number;
  progressLabel?: string;
  hall?: { code?: string; name?: string };
  zone?: { code?: string };
  stall?: { stallCode?: string };
  event?: { id?: string; name?: string; timezone?: string };
};

const progressLabels: Record<string, string> = {
  NEW: 'Request received',
  QUEUED: 'Waiting for assistance',
  ASSIGNED: 'Staff assigned',
  SNOOZED: 'Staff assigned',
  ACCEPTED: 'Request accepted',
  IN_PROGRESS: 'Work in progress',
  AWAITING_OTP: 'Check the work and share your completion code',
  CLOSED: 'Completed',
  COMPLAINT_RAISED: 'Problem reported',
  REOPENED: 'Request reopened',
  ESCALATED: 'Manager reviewing your request',
  CANCELLED: 'Cancelled',
};

export function progressText(ticket: { status: string; progressLabel?: string }) {
  return ticket.progressLabel || progressLabels[ticket.status] || 'Update';
}

export function serviceText(ticket: { category: string; subtype: string }) {
  const service = serviceLabel(ticket.category);
  return ticket.subtype ? `${service} · ${ticket.subtype}` : service;
}

export function stallPlace(ticket: StallTicket) {
  const hall = ticket.hall?.name || ticket.hall?.code || '';
  const zone = ticket.zone?.code ? `Zone ${ticket.zone.code}` : '';
  const stall = ticket.stall?.stallCode ? `Stall ${ticket.stall.stallCode}` : '';
  return [hall, zone, stall].filter(Boolean).join(' / ');
}

export function eventTime(value: string | null | undefined, timeZone: string) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function countdownLabel(expiresAt: string | undefined, nowMs: number) {
  if (!expiresAt) return '';
  const remaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - nowMs) / 1000));
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function complaintAllowed(status: string) {
  return status === 'AWAITING_OTP' || status === 'CLOSED';
}
