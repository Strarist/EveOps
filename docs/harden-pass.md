# EveOps post-MVP harden notes

Date: 10 September 2026

## Applied in this harden pass

- Expanded `.gitignore` for Playwright artifacts, env variants, and OS junk
- Bootstrap always requires `OTP_ENCRYPTION_SECRET` (≥32 chars, distinct from `SESSION_SECRET`)
- Production also rejects placeholder secrets and short `SESSION_SECRET`
- `ValidationPipe` uses `forbidNonWhitelisted: true`
- Validated DTOs for OTP verify (`^\d{6}$`), ping, prioritize, and workforce reassign
- OTP workflow: Stall display-only / assigned Staff verify-only (see `docs/deep-runtime-audit.md`)
- Fixed `routingWarning` to a non-leaking client string
- Added `npm run db:deploy` (`prisma migrate deploy`)
- Ops UI `apiErrorMessage` sanitizes 5xx and workforce/ticket create errors
- Workforce UI prefers `employeeCode` / email over raw UUIDs; masters show timezone not event UUID
- Confirmed `.env` is not committed (`.env.example` only)

## Already solid

- Helmet, cookie httpOnly sessions, hashed tokens
- Role + object scope guards on ticket/management paths
- OTP stored as hash + AES-GCM ciphertext; plaintext only via stall present endpoint
- Throttles on login and OTP routes
- Composite hierarchy FKs and outbox dead-lettering

## Residual (accepted for MVP push)

- Some management bodies still use inline types (validated manually in service)
- Demo seed credentials documented in README for local only
- SMS/WhatsApp OTP delivery still out of MVP
- Temporary passwords still lack forced rotation (`mustChangePassword` / invite tokens)
