# EveOps post-MVP harden notes

Date: 10 September 2026

## Applied in this harden pass

- Expanded `.gitignore` for Playwright artifacts, env variants, and OS junk
- Production bootstrap refuses placeholder/short `SESSION_SECRET` / `OTP_ENCRYPTION_SECRET`
- Validated DTOs for OTP verify (`^\d{6}$`), ping, prioritize, and workforce reassign
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
