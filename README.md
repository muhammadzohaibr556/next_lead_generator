# Permit Atlas

Construction opportunity research for connected jurisdictions in California, South Carolina and Texas. The application now runs on **Next.js 16, React 19, TypeScript and PostgreSQL**. A Node.js worker runs imports, Census geocoding and requested enrichment from the same repository. Python is not required for the new runtime.

This is a single shared workspace. Statewide coverage remains partial. The data sources screen shows current database counts and source health. A permit signal does not establish buying intent, job availability, or permission to contact someone.

## Run locally

Requires Node.js 22.13+ and PostgreSQL 17+. Install dependencies with `npm ci`.

Run PostgreSQL separately from the application. The local app connects to `permit_atlas` on **localhost:5432**. Set the connection in `.env.local`:

```sh
DATABASE_URL=postgresql://postgres@localhost:5432/permit_atlas
```

On a different machine, create an empty PostgreSQL database and put its `DATABASE_URL` in `.env.local` (see `.env.example`). Use authenticated PostgreSQL connections for deployment. Apply migrations before starting the web app and worker.

```sh
npm run db:migrate
npm run dev
```

Open **http://127.0.0.1:3000**. In a second terminal:

```sh
npm run worker
```

The dashboard queues work; the worker must be running for imports and requested enrichment to finish. `AUTO_SYNC=1` polls enabled sources and initially imports the last 30 days. Use `AUTO_SYNC=0 npm run worker` for manual Sync only. `INITIAL_LOOKBACK_DAYS` applies when each source is first registered. `GEOCODING_ENABLED=0` disables Census lookups.

Environment precedence: shell environment, `.env.local`, then `.env`. Restart both processes after changing settings. `.env` and `.env.local` are ignored by Git. Existing provider credentials remain server-side.

**This migration uses a fresh PostgreSQL database. No SQLite data was imported.** The old Python backend, legacy frontend, checks, dependencies, setup instructions, and SQLite database files have been removed. Next.js serves the current frontend assets from `public/static/`.

## What is implemented

- React dashboard, prospecting feed, saved leads, pipeline status/assignments/notes, and source management.
- Search, trade, territory/state/city/ZIP, date, stage, value, score and evidence filters; pagination and protected CSV export.
- Leaflet clustered maps, shared radius filters, Census geocoding, and explicit location provenance.
- All 15 existing municipal feeds across 10 jurisdictions: Socrata, ArcGIS, San Diego annual CSVs and San José CSVs.
- Canonical permit/project identity, versioned raw evidence, conservative trade classification and scores that decay at read time.
- LA County exact-parcel lookup, optional Realie owner matching and independent Melissa address-contact search, with caching and trial-budget controls.
- Next.js JSON endpoints under `/api/*`; endpoint and filter documentation at `/docs`.

## Database and jobs

`migrations/001_initial.sql` creates the PostgreSQL schema, JSONB payloads, generated filter columns, indexes and unique constraints. `npm run db:migrate` applies ordered SQL migrations transactionally, checks applied-file hashes, and registers sources idempotently. Future changes belong in new numbered SQL files; do not edit an applied migration. Database migrations run explicitly, not on every web request.

The worker holds a PostgreSQL advisory lock, allowing **one worker per database**. Its persistent queue deduplicates active source runs. Raw evidence, canonical permit changes and lead updates commit in one batch transaction. Failed runs do not advance the successful watermark. Interrupted municipal imports are replayed safely; interrupted paid lookups become `uncertain` and are not automatically retried. Losing the worker lock stops the process immediately.

After changing trade rules, stop the worker and run:

```sh
npm run reclassify
```

This preserves saved status, notes and assignments. Radius queries use a latitude bound and an exact great-circle distance calculation in SQL; PostGIS is not required for this migration. Add spatial indexing if measured query volume requires it.

## Enrichment configuration

Public permit imports and Census lookups need no paid account. `SOCRATA_APP_TOKEN` is optional and sent only to Socrata.

Owner/contact lookups require all provider settings in `.env.example`: credentials, licensed use rights, confirmed no-charge entitlement, a timezone-qualified expiry, a trial identifier, remaining units exclusively allocated to this app, worst-case units per request, and permitted cache days. Contact lookup uses Personator Search with the permit address and requires its separate entitlement flag. It does not use Realie or claim that returned people own the property. No provider request is made until a user requests it.

The fresh database has no old trial-usage ledger. The local setup therefore overrides `REALIE_NO_CHARGE_CONFIRMED=0` and `MELISSA_NO_CHARGE_CONFIRMED=0` in `.env.local`. Before enabling these, allocate the actual remaining allowance for this fresh workspace; do not reuse the original allowance as if previous requests never happened. Replacing a database does not reset a provider account's usage.

Matching rejects wrong units, parcels and localities. Melissa results are labeled as people associated with the address because the address search does not establish ownership. Costs are reserved before dispatch and retained after failures or uncertain outcomes. Expired results are removed by the worker; provider contact fields never appear in CSV exports.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:smoke
```

`npm run test:smoke` starts a temporary production web process on loopback, uses temporary credentials, and checks actual HTTP authentication, CSP, CSRF, request limits and endpoints against the configured database. It does not enqueue imports or enrichment.

`npm test` runs deterministic normalization/scoring, validation, identity parsing and security checks. The normalization fixtures capture the Python implementation's expected behavior for every source; Python is not needed to run them.

For PostgreSQL integration checks, create a **disposable database with a name ending in `_test`**:

```sh
createdb permit_atlas_test
TEST_DATABASE_URL=postgresql://localhost/permit_atlas_test npm test
```

The integration check resets that test database's app tables and mocks all external HTTP requests. It verifies migration idempotency, import transactions and deduplication, note preservation, map/radius/filter parity, CSV protection, queue concurrency, source parsers, worker recovery, geocoding, suppression races and trial-budget reservations. It cannot spend provider credits. Without `TEST_DATABASE_URL`, that integration group is explicitly skipped.

## Production

```sh
npm ci
npm run db:migrate
npm run build
npm start
# Separate supervised process, same environment/database:
npm run worker
```

Set **both** `APP_USERNAME` and `APP_PASSWORD`; production fails closed without them. Set `ALLOWED_HOSTS` to the deployment hostname. Keep the web process behind a TLS reverse proxy; `npm start` binds to loopback by default. For an isolated container deployment, bind to its interface explicitly using `npm start -- --hostname 0.0.0.0` and restrict access through the authenticated proxy. Apply migrations once before starting web and worker processes. Do not put the persistent worker inside a serverless request handler.

The app preserves same-origin JSON writes, constant-time credential checks, no-store API responses and a nonce-based content security policy. Customer accounts, tenant isolation and billing have not been added by this framework migration.

Live third-party provider accuracy and current municipal uptime are not established by mocked tests. [COVERAGE.md](COVERAGE.md) retains the prior source research and limitations; imported counts there refer to the old dataset, not this fresh database.
