import { compareAuditDesc, decodeAuditCursor, encodeAuditCursor, mergeAuditPage } from './audit-page';

describe('audit page merge', () => {
  const row = (id: string, minute: number) => ({ id, createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)) });

  it('pages a static merge without gaps or duplicates', () => {
    const tickets = Array.from({ length: 30 }, (_, index) => row(`t${index}`, index));
    const audits = Array.from({ length: 12 }, (_, index) => row(`a${index}`, index * 2));
    const seen = new Set<string>();
    let cursor: { createdAt: Date; id: string } | null = null;
    const pages: string[][] = [];
    for (let guard = 0; guard < 10; guard += 1) {
      const older = (items: ReturnType<typeof row>[]) => items.filter((item) => {
        if (!cursor) return true;
        return compareAuditDesc(item, cursor) > 0;
      }).sort(compareAuditDesc);
      const page = mergeAuditPage(older(tickets).slice(0, 11), older(audits).slice(0, 11), 10);
      pages.push(page.items.map((item) => item.id));
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      if (!page.hasMore) break;
      cursor = page.items.at(-1) ?? null;
    }
    expect(seen.size).toBe(42);
    expect(pages[0]).toHaveLength(10);
    expect(new Set(pages.flat()).size).toBe(42);
  });

  it('keeps a newer row off an already issued older cursor', () => {
    const existing = [row('t3', 3), row('t2', 2), row('t1', 1)];
    const first = mergeAuditPage(existing, [], 2);
    const cursor = first.items.at(-1)!;
    const withNew = [row('t4', 4), ...existing];
    const older = withNew.filter((item) => compareAuditDesc(item, cursor) > 0);
    const next = mergeAuditPage(older, [], 2);
    expect(first.items.map((item) => item.id)).toEqual(['t3', 't2']);
    expect(next.items.map((item) => item.id)).toEqual(['t1']);
    expect(next.items.map((item) => item.id)).not.toContain('t4');
    const refreshed = mergeAuditPage(withNew, [], 2);
    expect(refreshed.items.map((item) => item.id)).toEqual(['t4', 't3']);
  });

  it('round-trips a cursor and rejects malformed input', () => {
    const cursor = { createdAt: new Date('2026-04-01T00:00:00.000Z'), id: 'hist-audit-1' };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
    expect(decodeAuditCursor(undefined)).toBeNull();
    expect(decodeAuditCursor('not-a-cursor')).toBeNull();
    const oversized = Buffer.from(JSON.stringify({ t: '2026-04-01T00:00:00.000Z', i: 'x'.repeat(129) }), 'utf8').toString('base64url');
    expect(decodeAuditCursor(oversized)).toBeNull();
  });
});
