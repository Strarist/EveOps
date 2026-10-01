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

The shared password is `REGRESSION_FIXTURE_PASSWORD`, supplied in the environment. The fixture refuses to run when it is missing, updates the synthetic account hashes to that value, and does not print it. Do not commit the password, and do not put it in tracked source, screenshots, or reports. Emails use `@volume.lab`.

## Isolated browser stack

`npm run dev` loads `.env`, which points at the application database. Do not use it for regression.

Start the regression stack only through `scripts/dev-regression.sh`. That script:

- Sets `DATABASE_URL` to local `eveops_regression` after reading `.env`, so an inherited application database URL cannot remain in effect.
- Sets `ALLOW_DEMO_SEED=false`. API startup also skips demo seed when the connected database is `eveops_regression`.
- Sets `EVEOPS_REQUIRE_DATABASE=eveops_regression`. API and worker startup query `current_database()` once and refuse to continue if it does not match. The startup log shows the database name and not the connection string. `GET /api/system/health` stays a process check and includes `databaseName` only while that guard is set; it does not query the database again.
- Uses ports 3100 (web) and 4100 (API) unless `REGRESSION_WEB_PORT` and `REGRESSION_API_PORT` are set.
- Points `API_URL`, `NEXT_PUBLIC_API_URL`, `WEB_ORIGIN`, and `E2E_BASE_URL` at that stack.
- Sets `COOKIE_SECURE=false` for local HTTP cookies.
- Runs migrations and the fixture seed against `eveops_regression` only.

```bash
export REGRESSION_FIXTURE_PASSWORD='your-local-password'
bash scripts/dev-regression.sh
```

Confirm health before opening the browser:

```bash
curl -s http://localhost:4100/api/system/health
```

The JSON `databaseName` must be `eveops_regression`.

Playwright for this stack is `npx playwright test -c playwright.regression.config.ts`. It does not start `npm run dev`. Start the regression script first, or let that config start it. The browser base URL is `E2E_BASE_URL`.

## Tests

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
