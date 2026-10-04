export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 100;

export type AuditCursor = { createdAt: Date; id: string };

export function encodeAuditCursor(cursor: AuditCursor) {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.toISOString(), i: cursor.id }), 'utf8').toString('base64url');
}

export function decodeAuditCursor(value: string | undefined): AuditCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { t?: unknown; i?: unknown };
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string' || parsed.i.length < 1 || parsed.i.length > 128) return null;
    const createdAt = new Date(parsed.t);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.i };
  } catch {
    return null;
  }
}

/** Rows strictly older than the cursor in (createdAt desc, id desc) order. */
export function auditOlderThan(cursor: AuditCursor | null) {
  if (!cursor) return {};
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] },
    ],
  };
}

export function compareAuditDesc(left: { createdAt: Date; id: string }, right: { createdAt: Date; id: string }) {
  const time = right.createdAt.getTime() - left.createdAt.getTime();
  if (time !== 0) return time;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

/**
 * The next page of a merge of two descending streams is contained in the first
 * `limit + 1` rows of each stream. Callers fetch that many, already ordered.
 */
export function mergeAuditPage<T extends { createdAt: Date; id: string }, U extends { createdAt: Date; id: string }>(left: T[], right: U[], limit: number) {
  const merged = [...left, ...right].sort(compareAuditDesc);
  const hasMore = merged.length > limit;
  return { items: merged.slice(0, limit), hasMore };
}
