export const ROLES = ['STALL', 'STAFF', 'HALL_MANAGER', 'ADMIN', 'SUPER_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const TICKET_STATUSES = [
  'NEW', 'ASSIGNED', 'SNOOZED', 'QUEUED', 'ACCEPTED', 'IN_PROGRESS',
  'AWAITING_OTP', 'CLOSED', 'COMPLAINT_RAISED', 'REOPENED', 'ESCALATED', 'CANCELLED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const ACTIVE_TICKET_STATUSES: readonly TicketStatus[] = [
  'NEW', 'ASSIGNED', 'SNOOZED', 'QUEUED', 'ACCEPTED', 'IN_PROGRESS',
  'AWAITING_OTP', 'COMPLAINT_RAISED', 'REOPENED', 'ESCALATED',
];
export const TERMINAL_TICKET_STATUSES: readonly TicketStatus[] = ['CLOSED', 'CANCELLED'];
export const ASSIGNED_TICKET_STATUSES: readonly TicketStatus[] = ['ASSIGNED', 'SNOOZED', 'ACCEPTED', 'IN_PROGRESS', 'AWAITING_OTP'];

export type TicketPriority = 'NORMAL' | 'URGENT';
export const SERVICE_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type ServicePriority = (typeof SERVICE_PRIORITIES)[number];
export type ServiceCategory = 'ELECTRICAL' | 'HOUSE_HELP' | 'HALL_MANAGER';

type BuildEnv = {
  BUILD_SHA?: string;
  RENDER_GIT_COMMIT?: string;
  NODE_ENV?: string;
};

/** Identifies a running build. The placeholder "development" is not a production release id. */
export function publishedBuildIdentity(env: BuildEnv = process.env): string {
  const explicit = env.BUILD_SHA?.trim() ?? '';
  const labeled = explicit && explicit !== 'development' ? explicit : '';
  const renderCommit = env.RENDER_GIT_COMMIT?.trim() ?? '';
  const candidate = labeled || renderCommit;
  if (candidate) return candidate;
  if (env.NODE_ENV === 'production') return 'unlabeled';
  return 'development';
}

export interface AuthScope {
  userId: string;
  role: Role;
  eventIds: string[];
  hallIds: string[];
  stallId?: string;
  serviceTypes: string[];
  /** Present when session hydration includes credential state. */
  mustChangePassword?: boolean;
}

export interface TicketSummary {
  id: string;
  publicNo: string;
  stallCode: string;
  hallCode: string;
  category: ServiceCategory;
  subtype: string;
  priority: TicketPriority;
  status: TicketStatus;
  createdAt: string;
  assigneeName?: string;
}
