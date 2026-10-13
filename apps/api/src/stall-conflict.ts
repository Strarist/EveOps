import { Prisma } from '@prisma/client';

/** Maps only the same-zone stall-code unique constraint. Other database errors stay untouched. */
export function stallCodeConflictMessage(error: unknown, stallCode: string): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return null;
  const target = error.meta?.target;
  const parts = Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : [];
  if (!parts.some((part) => part === 'stallCode' || part.includes('stallCode'))) return null;
  const code = stallCode.trim();
  if (!code) return null;
  return `Stall code ${code} is already used in this zone`;
}
