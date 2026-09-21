# Permit Atlas

A working local application for finding construction opportunities in **California and South Carolina**, with **partial jurisdiction coverage**. California feeds cover Los Angeles, San Diego, San Francisco, San José, Sacramento, West Sacramento and Pasadena; South Carolina feeds currently cover the City of Charleston. Existing Austin/Fort Worth records remain accessible through the Texas filter. FastAPI serves the dashboard/API, pandas processes CSVs, and a persistent background queue polls official sources. No paid data API or AI model is required.

**Complete statewide coverage has not been achieved.** See [COVERAGE.md](COVERAGE.md) for actual imports, source limitations, unavailable sources and the remaining data-access requirement. The dashboard defaults to CA + SC and exposes the same coverage facts at `/api/coverage`.

## Run

Requires Python 3.11+ on macOS or Linux.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Open **http://127.0.0.1:8000**. First launch queues a 30-day import. Records appear as batches finish; failures and retry status appear under **Data sources**. Leave the application running for scheduled polling. Do not start multiple Uvicorn workers against this database.

```sh
.venv/bin/python check.py     # deterministic regression check, no network
```

After changing the trade rules in `app/engine.py`, stop the server and run `.venv/bin/python -m app.manage reclassify` to update previously imported records without losing pipeline notes or saved status.

Settings are environment variables; `.env.example` documents them. Example: `AUTO_SYNC=0 .venv/bin/python -m uvicorn app.main:app` disables scheduled polling but retains manual sync. `INITIAL_LOOKBACK_DAYS` sets the coverage boundary **when each source is first registered**, not on subsequent starts. The SQLite database and raw evidence live under `data/` and are excluded from version control. Keep backups using SQLite's backup API, not a live copy of just the `.db` file.

## What works

- Live imports, persisted raw evidence and source provenance; searchable project addresses, scope, dates, permit status, valuation, parcel ID, and contacts where the source publishes them.
- Roofing and interior tile rules, plus HVAC, electrical, plumbing, solar, remodeling, new construction, windows and doors. Roof tiles are treated as roofing. Bathroom remodel/new-build tile opportunities are explicitly labeled **Adjacent**.
- Database-enforced permit and project/trade uniqueness; updates retain saved status, assignments, and notes. LA submitted/issued records and San Diego created/issued approvals converge on the same municipal permit.
- Search, trade, state, city, ZIP, date, stage, score, valuation, opportunity type, saved, and sales-status filters; CSV export with the same filters and spreadsheet formula escaping.
- Lead detail, raw evidence links, scoring breakdown, related-address signals, saved shortlist, and sales pipeline (New / Qualified / Contacted / Sold / Dismissed).
- On-demand **Los Angeles County property enrichment**, matched by exact AIN, with building year, square feet, use and assessed value. Results are cached for 30 days. This is an assessment, not a market valuation.
- Source enable/pause controls, ingestion logs, per-source retry, health, and OpenAPI documentation at `/docs`.

## Public sources

Endpoints and schemas verified September 19, 2026. City publication schedules are not freshness guarantees. The app displays the last successful poll separately from the newest permit activity it imported.

| Market / feed | Official endpoint | Polling | Notes |
|---|---|---|---|
| Austin | [Socrata `3syk-w9eu`](https://data.austintexas.gov/resource/3syk-w9eu.json) | 4 hours | Daily publication; includes contractor details when supplied. |
| Los Angeles applications | [Socrata `gwh9-jnip`](https://data.lacity.org/resource/gwh9-jnip.json) | 6 hours | Submitted records; publication cadence varies. |
| Los Angeles issued | [Socrata `pi9x-tg5x`](https://data.lacity.org/resource/pi9x-tg5x.json) | 6 hours | Shares municipal permit numbers with submitted records. These feeds do not publish contractor contact fields. |
| Fort Worth | [Development Permits FeatureServer](https://services5.arcgis.com/3ddLCBXe1bRt7mzj/arcgis/rest/services/CFW_Open_Data_Development_Permits_View/FeatureServer/0) | 1 hour | [City metadata](https://www.arcgis.com/home/item.html?id=d2740f4d746b4bfaa03e25de0376238b) describes hourly updates during business hours. Includes an owner field; no contractor phone in this table. |
| San Diego created + issued | [Official annual CSV downloads](https://data.sandiego.gov/datasets/development-permits/) | 6 hours | Daily publication. Current and previous years within coverage are read; permit holder is kept separate from contractor. |
| San Francisco | [DataSF building permits](https://data.sf.gov/d/i98e-djp9) | Daily | Primary permit address only; filed/issued/status/activity dates; block-lot parcel identifier. |
| San José recent, active + expired | [City CKAN catalog](https://data.sanjoseca.gov/dataset/active-building-permits) | Daily | Three CSVs reconciled by folder number; contractor when published; issue/final dates. Approval checklist completion is not permit completion. |
| Sacramento | [Current-year issued permits](https://services5.arcgis.com/54falWtcpty3V47Z/arcgis/rest/services/BldgPermitIssued_CurrentYear/FeatureServer/0) | Daily | Published monthly; MM/DD/YYYY dates parsed before filtering. Current-year snapshot does not preserve prior-year updates after rollover. |
| West Sacramento | [City permit table](https://gis.cityofwestsacramento.org/server/rest/services/building_permits/FeatureServer/0) | Daily | Applied/status dates and type/subtype; business-name field is not assumed to be a contractor. |
| Pasadena | [Active permit layer](https://services2.arcgis.com/zNjnZafDYCAJAbN0/ArcGIS/rest/services/Permit_Activity/FeatureServer/0) | Daily | Latest activity only; application/issue dates and stage are not invented. |
| Charleston active + issued | [City active permits](https://gis.charleston-sc.gov/arcgis2/rest/services/External/Applications/MapServer/20) / [issued permits](https://gis.charleston-sc.gov/arcgis2/rest/services/External/Applications/MapServer/1134) | Daily | **City**, not Charleston County or statewide; deduplicated by permit number; free-text project names are not grouping IDs. |
| LA County parcels | [Official parcel FeatureServer](https://cache.gis.lacounty.gov/cache/rest/services/LACounty_Cache/LACounty_Parcel/FeatureServer/0) | On demand | Exact AIN only; 30-day cache; assessment roll year shown. No homeowner phone/email. |

Socrata supports an optional `SOCRATA_APP_TOKEN` for [higher throttling limits](https://dev.socrata.com/docs/app-tokens). It is sent as a header only to Socrata feeds. The current 2.1 endpoints work without a token; an upstream policy change may require one.

## Data flow and identity

`Official feeds → raw evidence → canonical permits → official project grouping → trade opportunities → dashboard/API`

The canonical permit key is `(jurisdiction, permit_number)`, so submitted/issued feeds cannot create two copies of the same permit. Raw evidence retains distinct payload versions by source. Related permits group by the official master/project identifier where available (Austin, San Diego); the lead key is `(project_key, trade)`.

**The app does not automatically merge separate permits just because an address matches.** Without an official project reference, it shows other opportunities at that address for human review. This deliberately avoids combining separate jobs or units, but those opportunities may still describe the same underlying project. Review them before selling an exclusive lead. Address normalization is conservative and preserves unit tokens; it is not USPS verification. The app records source property fields and does not claim a nationwide property-resolution service.

The initial date boundary defines a monitored cohort. Socrata queries use that boundary plus a 72-hour overlap on [row update timestamps](https://dev.socrata.com/docs/system-fields.html), with deterministic pagination. This detects corrections to that cohort even if a provider republishes its whole snapshot. Fort Worth does not expose a per-row modified timestamp, so the worker reconciles its full monitored cohort on each poll. San Diego annual files are streamed to disk and parsed in pandas chunks, avoiding an all-history download and large in-memory CSVs. Year rollover includes all annual files back to the coverage year.

A record outside the initial coverage boundary can be missed if a source publishes it late without a qualifying issue/application/status date. Source deletion is not treated as permit cancellation; cancellation must be present in a source record. Municipal page reads are not transactional snapshots; overlap and idempotent replays handle subsequent updates, not a guarantee of point-in-time completeness.

Each batch commits raw records, normalized permits and lead updates together. Failed runs retain completed batches but **do not advance the successful watermark**. Replays deduplicate them. A unique pending/running job constraint prevents overlapping syncs; an OS lock enforces one ingestion process. Interrupted running jobs are replayed on restart. Network failures, rate limits and API error objects are surfaced. Failed sources retry after 15 minutes.

## Scoring and commercial meaning

The score is explainable and recalculates recency at read time: recency (0–30), stage (0–25), direct/adjacent evidence (25/10), address (0/10), and reported value (0/5/10). A named contractor subtracts 20; a permit holder subtracts 10. Closed, expired and cancelled records are capped at 10 and hidden from the default feed. Future activity dates are preserved with a data-quality flag and a score capped at 25; they do not inflate source freshness or recent-signal counts. Rule confidence is a fixed heuristic (not calibrated statistical probability).

An issued permit often means a contractor is already engaged. Missing contact fields do not establish availability. The application supports qualification and assignment; it does not manufacture homeowner phone/email, contact people, sell leads automatically, or label public records as consent to outreach. No claim of “millions tracked” or guaranteed monthly volume is built into the dashboard: every count comes from this database.

## API examples

```sh
curl 'http://127.0.0.1:8000/api/leads?trade=Roofing&state=CA&min_score=60'
curl 'http://127.0.0.1:8000/api/leads?trade=Tile&kind=Adjacent&sort=newest'
curl -X POST http://127.0.0.1:8000/api/sync \
  -H 'Content-Type: application/json' -d '{"source_id":"austin"}'
curl -X PATCH http://127.0.0.1:8000/api/leads/1 \
  -H 'Content-Type: application/json' -d '{"status":"Qualified","saved":true}'
```

`/api/leads/export` accepts the same filters, exports up to 10,000 results, and asks you to narrow filters above that limit. `/api/leads/{id}` returns associated permits, timeline dates, contacts, evidence and optional parcel details. `/api/sources` exposes schedules and recent ingestion runs. `/api/coverage` reports connected jurisdictions and actual imported permit counts; both states explicitly have `complete: false`. Leads default to CA + SC; use `state=TX` or `territory=all` to include the previous territory. Dashboard overview metrics always describe CA + SC.

## Deployment scope

This is a **single-workspace application**, not a multi-tenant lead marketplace. It runs without a database server, Redis, a JS build system, or paid enrichment. SQLite WAL and indexed filters are appropriate for validating municipal coverage and the sales workflow. A broader rollout with multiple worker hosts needs PostgreSQL and a distributed queue; customer accounts, billing, lead exclusivity and contact enrichment need separate product decisions.

By default bind only to `127.0.0.1`. Remote clients are rejected unless both `APP_USERNAME` and `APP_PASSWORD` are configured. For remote deployment use a TLS reverse proxy, set `ALLOWED_HOSTS` to your domain, and configure those credentials; Basic authentication alone does not encrypt traffic. Do not expose this single shared account as a customer portal. Cross-origin writes are rejected, mutable endpoints require JSON, remote strings are escaped in the UI, queries are parameterized, and API ingestion is restricted to the built-in endpoints. Nothing is deployed publicly by this repository.

## Files

- `app/sources.py`: public-source registry, pagination and chunked downloads.
- `app/engine.py`: normalization, stage detection and trade rules.
- `app/db.py`: schema, canonical upserts, project grouping and filtered queries.
- `app/ingest.py`: durable queue worker and run accounting.
- `app/main.py`: FastAPI, access controls, CSV export and parcel lookup.
- `app/static/`: responsive frontend, with no external scripts or fonts.
- `check.py`: focused end-to-end regression checks using an isolated database and mocked public APIs.
