# 40-user regression fixture

Synthetic lab data for access, scheduling, and lifecycle checks. It is idempotent: reruns update the same accounts and do not delete unrelated rows.

## Database

Use a localhost database named `eveops_regression`. The fixture refuses any other name, including the local application database `eveops`, and refuses a remote host.

Create it once, then apply migrations:

```bash
PGPASSWORD=eveops psql -h localhost -p 55432 -U eveops -d postgres -c "CREATE DATABASE eveops_regression;"
DATABASE_URL="postgresql://eveops:eveops@localhost:55432/eveops_regression?schema=public" npx prisma migrate deploy
```

The host, port, and role match `docker-compose.yml`. Do not point this URL at a production database.

## Seed

```bash
DATABASE_URL="postgresql://eveops:eveops@localhost:55432/eveops_regression?schema=public" ALLOW_DEMO_SEED=false npm run db:fixture:regression
```

The command runs through the API test runner so Nest decorators load. `ALLOW_DEMO_SEED=false` keeps the documented pilot accounts out of this database. Running it again updates the same rows.

The shared password is the `REGRESSION_FIXTURE_PASSWORD` constant in `apps/api/src/regression-fixture.ts`. It is not printed by the seed command. Emails use `@volume.lab`.

| Role | Count | Email pattern |
| --- | ---: | --- |
| Admin | 1 | `regression.admin@volume.lab` |
| Super Admin | 1 | `regression.super@volume.lab` |
| Hall managers | 4 | `regression.manager.h1@volume.lab` through `h4` |
| Stall exhibitors | 18 | `regression.stall.h1-01@volume.lab` and so on |
| Electricians | 8 | `regression.elec.h1.1@volume.lab` and `hN.2` |
| House help | 8 | `regression.help.h1.1@volume.lab` and `hN.2` |

Layout:

- Organization `Volume Lab Exhibitions`, event `Volume Lab Expo`, halls H1–H4, stalls 5 / 5 / 4 / 4.
- Service priority is 6 HIGH, 6 MEDIUM, and 6 LOW. H4 also has vacant stall `H4-VACANT` with no login.
- Two electricians and two house-help staff per hall. Availability includes on-duty, paused, off-duty, and two on-duty workers who already hold one active task created through ticket routing.
- Admin is scoped to the main event only. Super Admin is also scoped to `Volume Lab Boundary`. Neither account can see the unscoped event or the foreign organization. No second admin is created.

## Tests

```bash
DATABASE_URL="postgresql://eveops:eveops@localhost:55432/eveops_regression?schema=public" ALLOW_DEMO_SEED=false npm run test:regression
```

If `DATABASE_URL` is not `eveops_regression`, the suite is skipped so the application database is left alone. Case rows created by the suite use a `case-` prefix and are removed afterward. Fixture accounts and their busy examples stay.
