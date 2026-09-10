import { UnauthorizedException } from '@nestjs/common';
import { assertValidScopeShape } from './auth';

const activeHall = { active: true };
const activeStall = { active: true };

describe('authentication scope shape', () => {
  it('accepts one active bound stall in the user organization', () => {
    expect(() => assertValidScopeShape({
      organizationId: 'org-1',
      role: 'STALL',
      scopes: [{
        event: { organizationId: 'org-1' },
        hallId: 'hall-1',
        hall: activeHall,
        stallId: 'stall-1',
        stall: activeStall,
        serviceType: null,
      }],
    })).not.toThrow();
  });

  it('rejects a stall account without a stall binding', () => {
    expect(() => assertValidScopeShape({
      organizationId: 'org-1',
      role: 'STALL',
      scopes: [{
        event: { organizationId: 'org-1' },
        hallId: 'hall-1',
        hall: activeHall,
        stallId: null,
        stall: null,
        serviceType: null,
      }],
    })).toThrow(UnauthorizedException);
  });

  it('rejects cross-organization scope assignment', () => {
    expect(() => assertValidScopeShape({
      organizationId: 'org-1',
      role: 'ADMIN',
      scopes: [{
        event: { organizationId: 'org-2' },
        hallId: null,
        hall: null,
        stallId: null,
        stall: null,
        serviceType: null,
      }],
    })).toThrow(UnauthorizedException);
  });

  it('rejects staff without hall and service bindings', () => {
    expect(() => assertValidScopeShape({
      organizationId: 'org-1',
      role: 'STAFF',
      scopes: [{
        event: { organizationId: 'org-1' },
        hallId: null,
        hall: null,
        stallId: null,
        stall: null,
        serviceType: null,
      }],
    })).toThrow(UnauthorizedException);
  });
});
