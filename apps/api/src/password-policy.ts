import { compare } from 'bcryptjs';
import { Matches, MaxLength, MinLength, registerDecorator, type ValidationOptions } from 'class-validator';
import { NEW_PASSWORD_MESSAGE, NEW_PASSWORD_PATTERN, PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from '@eveops/contracts';

/** Cost-12 hash used so an unknown account still pays for one password compare. */
const UNKNOWN_ACCOUNT_HASH = '$2b$12$oMgi.0eby3bvSL6zNnDbf.f3FJUtOVNkNDxnvDUtCqkUH9atGrQhe';

export function passwordByteLength(value: string) {
  return Buffer.byteLength(value);
}

function IsPasswordByteLimit(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: 'isPasswordByteLimit',
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && passwordByteLength(value) <= PASSWORD_MAX_BYTES;
        },
        defaultMessage: () => `password must be at most ${PASSWORD_MAX_BYTES} bytes`,
      },
    });
  };
}

function applyDecorators(decorators: PropertyDecorator[]): PropertyDecorator {
  return (target, key) => {
    for (const decorator of decorators) decorator(target, key);
  };
}

/** Length bounds for a password that is being presented, including an existing one. */
export function IsAcceptedPassword(): PropertyDecorator {
  return applyDecorators([
    MinLength(PASSWORD_MIN_LENGTH),
    MaxLength(PASSWORD_MAX_BYTES),
    IsPasswordByteLimit(),
  ]);
}

/** Length bounds plus a letter and a number, for a password being chosen. */
export function IsNewPassword(): PropertyDecorator {
  return applyDecorators([
    IsAcceptedPassword(),
    Matches(NEW_PASSWORD_PATTERN, { message: NEW_PASSWORD_MESSAGE }),
  ]);
}

/**
 * Compare a presented password with the stored hash.
 * A missing or unusable hash is compared against a fixed hash so the failure
 * does not return before a bcrypt compare.
 */
export async function passwordMatches(password: string, passwordHash: string | null | undefined): Promise<boolean> {
  if (passwordByteLength(password) > PASSWORD_MAX_BYTES) return false;
  const stored = typeof passwordHash === 'string' && passwordHash.startsWith('$2') ? passwordHash : UNKNOWN_ACCOUNT_HASH;
  try {
    const matches = await compare(password, stored);
    return stored === passwordHash && matches;
  } catch {
    return false;
  }
}
