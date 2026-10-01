import { Prisma } from '@prisma/client';
import { stallCodeConflictMessage } from './stall-conflict';

function uniqueError(target: string[] | string | undefined) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.12.0',
    meta: target === undefined ? { modelName: 'Stall' } : { modelName: 'Stall', target },
  });
}

describe('stall code conflicts', () => {
  it('names the conflicting stall code for the zone constraint', () => {
    expect(stallCodeConflictMessage(uniqueError(['zoneId', 'stallCode']), ' H1-01 ')).toBe('Stall code H1-01 is already used in this zone');
    expect(stallCodeConflictMessage(uniqueError('Stall_zoneId_stallCode_key'), 'H1-01')).toBe('Stall code H1-01 is already used in this zone');
  });

  it('does not mask a different unique constraint or a missing target', () => {
    expect(stallCodeConflictMessage(uniqueError(['email']), 'H1-01')).toBeNull();
    expect(stallCodeConflictMessage(uniqueError(undefined), 'H1-01')).toBeNull();
    expect(stallCodeConflictMessage(new Error('connection reset'), 'H1-01')).toBeNull();
    expect(stallCodeConflictMessage(uniqueError(['stallCode']), '  ')).toBeNull();
  });
});
