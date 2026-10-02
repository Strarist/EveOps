import { UnauthorizedException } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { validate } from 'class-validator';
import { ChangePasswordDto, LoginDto, assertValidScopeShape } from './auth';
import { passwordMatches } from './password-policy';

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

  it('accepts a 4 character sign-in password and rejects one outside 4 to 72 bytes', async () => {
    const accepted = Object.assign(new LoginDto(), { email: 'stall@eveops.test', password: 'ab12' });
    const tooShort = Object.assign(new LoginDto(), { email: 'stall@eveops.test', password: 'ab1' });
    const tooLong = Object.assign(new LoginDto(), { email: 'stall@eveops.test', password: `a1${'x'.repeat(80)}` });
    expect(await validate(accepted)).toHaveLength(0);
    expect(await validate(tooShort)).not.toHaveLength(0);
    expect(await validate(tooLong)).not.toHaveLength(0);
  });

  it('requires a letter and a number when a password is chosen', async () => {
    const digitsOnly = Object.assign(new ChangePasswordDto(), { currentPassword: 'ab12', newPassword: '1234' });
    const mixed = Object.assign(new ChangePasswordDto(), { currentPassword: 'ab12', newPassword: 'ab12' });
    expect(await validate(digitsOnly)).not.toHaveLength(0);
    expect(await validate(mixed)).toHaveLength(0);
  });

  it('compares a real password and rejects a missing or unusable hash', async () => {
    const encoded = await hash('ab12', 4);
    await expect(passwordMatches('ab12', encoded)).resolves.toBe(true);
    await expect(passwordMatches('nope1', encoded)).resolves.toBe(false);
    await expect(passwordMatches('ab12', null)).resolves.toBe(false);
    await expect(passwordMatches('ab12', 'not-used')).resolves.toBe(false);
    await expect(passwordMatches('x'.repeat(80), encoded)).resolves.toBe(false);
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
