import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate } from "../scripts/migrate";
import { pool } from "../lib/db";
import { ingestBatch, queueSource, refreshProject } from "../lib/ingest";
import { handleApi, leadDetail } from "../lib/api";
import { today, SOURCES, digest, normalize } from "../lib/engine";
import {
  queueEnrichment,
  runEnrichmentOne,
  reviewOwner,
  enrichmentDetails,
  lookupKey,
} from "../lib/enrichment";
import { geocodeOne } from "../lib/geo";
import { batches } from "../lib/sources";
import { recoverJobs, runSource } from "../scripts/worker";
const testUrl = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL migration and end-to-end workflows",
  { skip: !testUrl },
  async (t) => {
    const url = new URL(testUrl!);
    assert.ok(
      url.pathname.endsWith("_test"),
      "Use a disposable database ending in _test",
    );
    const originalFetch = globalThis.fetch,
      previous = { ...process.env };
    Object.assign(process.env, {
      DATABASE_URL: testUrl,
      NODE_ENV: "test",
      APP_USERNAME: "",
      APP_PASSWORD: "",
      ALLOWED_HOSTS: "localhost",
      AUTO_SYNC: "0",
      GEOCODING_ENABLED: "0",
      REALIE_API_KEY: "",
      MELISSA_API_KEY: "",
    });
    globalThis.fetch = async () => {
      throw Error("Unexpected external request in test");
    };
    const api = async (path: string, method = "GET", body?: unknown) =>
      handleApi(
        new Request("http://localhost/api/" + path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    const get = async (path: string) => {
      const response = await api(path);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const date = (days: number) =>
      new Date(Date.parse(today()) - days * 86400000)
        .toISOString()
        .slice(0, 10);
    const raw = (permit = "TEST-1", extra: Record<string, unknown> = {}) => ({
      permit_nbr: permit,
      primary_address: "123 Test Street",
      zip_code: "90001",
      apn: "1234567890",
      work_desc: "Replace roof shingles",
      submitted_date: today(),
      status_date: today(),
      status_desc: "Application Submitted",
      valuation: "18000",
      lat: 34,
      lon: -118,
      ...extra,
    });
    let leadId = 0;
    try {
      await migrate();
      await migrate();
      await pool().query(
        "TRUNCATE sources,projects,property_enrichment,geocode_cache,enrichment_results,enrichment_aliases,enrichment_reviews,trial_usage CASCADE",
      );
      await migrate();
      await t.test(
        "Fresh schema registers sources and returns empty dashboard",
        async () => {
          assert.equal(
            (await get("sources")).items.length,
            Object.keys(SOURCES).length,
          );
          assert.equal((await get("leads")).total, 0);
          assert.equal((await get("stats")).permits, 0);
          assert.equal((await get("coverage")).states.length, 3);
        },
      );
      await t.test(
        "Transactional ingestion deduplicates without losing sales workflow",
        async () => {
          const batch = await ingestBatch("la-submitted", [raw(), raw()]);
          assert.deepEqual(batch.counts, {
            fetched: 2,
            new_permits: 1,
            changed: 0,
            duplicates: 1,
            leads_created: 1,
          });
          const listing = await get("leads?trade=Roofing");
          assert.equal(listing.total, 1);
          assert.equal(listing.items[0].score, 100);
          leadId = listing.items[0].id;
          assert.equal(
            (
              await api("leads/" + leadId, "PATCH", {
                saved: true,
                status: "Qualified",
                notes: "=SUM(1,2)",
                assigned_to: "Alex",
              })
            ).status,
            200,
          );
          await ingestBatch("la-issued", [
            raw("TEST-1", { issue_date: today(), status_desc: "Issued" }),
          ]);
          await ingestBatch("la-submitted", [raw()]);
          const lead = await get("leads/" + leadId);
          assert.equal(lead.stage, "Issued");
          assert.equal(lead.status, "Qualified");
          assert.equal(lead.saved, true);
          assert.equal(lead.notes, "=SUM(1,2)");
          assert.equal(lead.permits.length, 1);
          assert.equal(lead.permits[0].evidence.length, 2);
          assert.equal(
            (
              await get(
                "leads?scope=history&saved=true&state=CA&zip=90001&min_value=17000",
              )
            ).total,
            1,
          );
          const exported = await (
            await api("leads/export?scope=history&saved=true")
          ).text();
          assert.match(exported, /'=SUM\(1,2\)/);
          assert.ok(!exported.includes("owner_identity_hash"));
          const before = (
            await pool().query("SELECT count(*)::integer n FROM permits")
          ).rows[0].n;
          await assert.rejects(
            ingestBatch("la-submitted", [raw("ROLLBACK"), {}]),
          );
          assert.equal(
            (await pool().query("SELECT count(*)::integer n FROM permits"))
              .rows[0].n,
            before,
          );
          await refreshProject(pool(), "los-angeles:permit:TEST-1");
          assert.equal((await leadDetail(leadId)).notes, "=SUM(1,2)");
        },
      );
      await t.test(
        "Prospecting, map, stats and CSV share filters and radius",
        async () => {
          await ingestBatch("la-submitted", [
            raw("FRESH"),
            raw("BOUNDARY", { submitted_date: date(6) }),
            raw("OLD", { submitted_date: date(7) }),
            raw("FUTURE", { status_date: date(-1) }),
            raw("MISSING", { lat: "", lon: "" }),
            raw("ADJACENT", { work_desc: "New construction of a dwelling" }),
          ]);
          const q = "trade=Roofing",
            list = await get("leads?" + q);
          assert.equal(list.total, 3);
          assert.ok(list.items.every((l: { in_focus: boolean }) => l.in_focus));
          assert.equal((await get("stats?" + q)).total, 3);
          const map = await get("leads/map?" + q + "&limit=1");
          assert.equal(map.mapped, 2);
          assert.equal(map.pending, 1);
          assert.equal(map.points.length, 2);
          const radius = "&center_lat=34&center_lon=-118&radius_miles=10";
          assert.equal((await get("leads?" + q + radius)).total, 2);
          assert.equal((await get("stats?" + q + radius)).total, 2);
          assert.equal(
            (await get("leads/map?" + q + radius)).excluded_unlocated,
            1,
          );
          assert.equal((await get("leads?q=%25")).total, 0);
          assert.equal((await get("leads?q=%27%20OR%201=1--")).total, 0);
          const distances = (
            await pool().query(
              "SELECT distance_miles(0,179.99,0,-179.99) dateline,distance_miles(89.99,0,89.99,180) polar",
            )
          ).rows[0];
          assert.ok(distances.dateline < 2);
          assert.ok(distances.polar < 2);
          const sd = {
            approval_id: "SD1",
            project_id: "PROJECT",
            gis_address: "10 Test Ave, San Diego, CA 92101",
            approval_scope: "Replace roof shingles",
            approval_status: "Created",
            approval_create_date: today(),
          };
          await ingestBatch("sd-created", [
            sd,
            {
              ...sd,
              approval_id: "SD2",
              approval_scope: "Grading only",
              approval_permit_holder: "Named party",
            },
          ]);
          assert.equal((await get("leads?city=San%20Diego")).total, 0);
          assert.ok(
            (
              await get("leads?scope=history&city=San%20Diego")
            ).items[0].focus_reasons.includes(
              "Contractor or permit holder listed on project",
            ),
          );
        },
      );
      await t.test(
        "API validation, source controls and atomic queue deduplication",
        async () => {
          assert.equal((await api("leads?center_lat=30")).status, 422);
          assert.equal(
            (await api("leads/" + leadId, "PATCH", { status: "Invented" }))
              .status,
            422,
          );
          assert.equal((await api("leads/999999")).status, 404);
          assert.equal(
            (await api("sync", "POST", { source_id: "unknown" })).status,
            404,
          );
          assert.equal(
            (await api("sources/la-submitted", "PATCH", { enabled: false }))
              .status,
            200,
          );
          const ids = await Promise.all(
            Array.from({ length: 12 }, () => queueSource("la-submitted")),
          );
          assert.equal(new Set(ids).size, 1);
        },
      );
      await t.test(
        "Source fetchers validate schemas, paginate and stream quoted CSV",
        async () => {
          const calls: URL[] = [];
          globalThis.fetch = async (input) => {
            const url = new URL(String(input));
            calls.push(url);
            return Response.json([{ permit_nbr: "NETWORK" }]);
          };
          const output = [];
          for await (const rows of batches("la-submitted", {
            coverage_since: date(30),
            last_success: today() + "T00:00:00Z",
          }))
            output.push(...rows);
          assert.equal(output.length, 1);
          assert.match(calls[0].searchParams.get("$where")!, /:updated_at/);
          assert.equal(calls[0].searchParams.get("$order"), ":id");
          let page = 0;
          globalThis.fetch = async () =>
            Response.json({
              features: [{ attributes: { Permit_No: "FW" + page } }],
              exceededTransferLimit: page++ === 0,
            });
          const arc = [];
          for await (const rows of batches("fort-worth", {
            coverage_since: date(30),
            last_success: null,
          }))
            arc.push(...rows);
          assert.equal(arc.length, 2);
          globalThis.fetch = async () =>
            new Response(
              'foldernumber,issuedate,finaldate,foldername\r\nSJCSV,09/20/2026,,"Roof repair, with shingles"\r\n',
            );
          const csv = [];
          for await (const rows of batches("sj-recent", {
            coverage_since: "2026-09-01",
            last_success: null,
          }))
            csv.push(...rows);
          assert.equal(csv[0].foldername, "Roof repair, with shingles");
          globalThis.fetch = async () => new Response("wrong,headers\n1,2\n");
          await assert.rejects(async () => {
            for await (const _ of batches("sj-recent", {
              coverage_since: "2026-09-01",
              last_success: null,
            })) {
            }
          }, /schema changed/);
          globalThis.fetch = async () =>
            Response.json({ error: { message: "failure" } });
          await assert.rejects(async () => {
            for await (const _ of batches("la-submitted", {
              coverage_since: date(30),
              last_success: null,
            })) {
            }
          }, /Upstream API/);
        },
      );
      await t.test(
        "Worker completes public jobs and does not advance failed watermarks",
        async () => {
          const runId = await queueSource("la-submitted");
          await pool().query("UPDATE runs SET status='running' WHERE id=$1", [
            runId,
          ]);
          globalThis.fetch = async () => Response.json([raw("WORKER")]);
          await runSource({ id: runId, source_id: "la-submitted" });
          let source = (
            await pool().query("SELECT * FROM sources WHERE id='la-submitted'")
          ).rows[0];
          assert.ok(source.last_success);
          const watermark = source.last_success;
          assert.equal(
            (await pool().query("SELECT status FROM runs WHERE id=$1", [runId]))
              .rows[0].status,
            "success",
          );
          const failed = await queueSource("la-submitted");
          globalThis.fetch = async () => Response.json([{}]);
          await runSource({ id: failed, source_id: "la-submitted" });
          source = (
            await pool().query("SELECT * FROM sources WHERE id='la-submitted'")
          ).rows[0];
          assert.equal(source.last_success, watermark);
          assert.ok(source.error);
        },
      );
      await t.test(
        "Geocoding persists a unique location for missing coordinates",
        async () => {
          globalThis.fetch = async () =>
            Response.json({
              result: {
                addressMatches: [
                  {
                    addressComponents: { state: "CA", zip: "90001" },
                    coordinates: { x: -118, y: 34 },
                    matchedAddress: "123 TEST ST",
                  },
                ],
              },
            });
          assert.equal(await geocodeOne(), true);
          assert.equal((await get("leads/map?trade=Roofing")).pending, 0);
        },
      );
      await t.test(
        "Enrichment enforces config, review, budgets and suppression",
        async () => {
          const lead = await leadDetail(leadId);
          await assert.rejects(queueEnrichment(lead, "owner"), /Not enabled/);
          for (const provider of ["REALIE", "MELISSA"])
            Object.assign(process.env, {
              [provider + "_API_KEY"]: "mock-key",
              [provider + "_TRIAL_ID"]: "mock-trial",
              [provider + "_TRIAL_EXPIRES"]: "2099-01-01T00:00:00Z",
              [provider + "_FREE_UNITS"]: "2",
              [provider + "_MAX_UNITS_PER_REQUEST"]: "1",
              [provider + "_CACHE_DAYS"]: "30",
              [provider + "_RIGHTS_CONFIRMED"]: "1",
              [provider + "_NO_CHARGE_CONFIRMED"]: "1",
            });
          const a = await queueEnrichment(lead, "owner"),
            b = await queueEnrichment(lead, "owner");
          assert.equal(a.id, b.id);
          globalThis.fetch = async () =>
            Response.json({
              property: {
                address: "123 Test Street",
                state: "CA",
                city: "Los Angeles",
                zipCode: "90001",
                parcelId: "1234567890",
                county: "Los Angeles",
                realieParcelId: "OWNER1",
                ownerName: "EXAMPLE LLC",
                ownerStreet: "10 Main St",
                ownerCity: "Los Angeles",
                ownerState: "CA",
                ownerZipCode: "90001",
              },
            });
          assert.equal(await runEnrichmentOne(), true);
          let ctx = await enrichmentDetails(pool(), lead);
          assert.equal(ctx.owner?.name, "EXAMPLE LLC");
          assert.equal(ctx.providers.realie.remaining_units, 1);
          await assert.rejects(
            queueEnrichment(lead, "contacts"),
            /Review the matched owner/,
          );
          await reviewOwner(lead, { owner_type: "Company", reviewed: true });
          await queueEnrichment(lead, "contacts");
          globalThis.fetch = async () =>
            Response.json({
              Records: [
                {
                  CurrentCompanyName: "EXAMPLE LLC",
                  AddressLine1: "10 Main Street",
                  State: "CA",
                  PostalCode: "90001",
                  Results: "FS01",
                  Phone: "555-0100",
                },
              ],
            });
          await runEnrichmentOne();
          ctx = await enrichmentDetails(pool(), lead);
          assert.equal(ctx.contacts?.candidates[0].phone, "555-0100");
          await reviewOwner(lead, { contacts_verified: true });
          assert.equal(
            (await enrichmentDetails(pool(), lead)).review.contacts_verified,
            true,
          );
          await reviewOwner(lead, { suppressed: true });
          assert.equal((await enrichmentDetails(pool(), lead)).contacts, null);
          await assert.rejects(queueEnrichment(lead, "contacts"), /suppressed/);
          await reviewOwner(lead, { suppressed: false });
          await pool().query("DELETE FROM enrichment_results WHERE kind=$1", [
            "contacts",
          ]);
          await queueEnrichment(lead, "contacts");
          globalThis.fetch = async () => {
            await reviewOwner(lead, { suppressed: true });
            return Response.json({
              Records: [
                {
                  CurrentCompanyName: "EXAMPLE LLC",
                  AddressLine1: "10 Main Street",
                  State: "CA",
                  PostalCode: "90001",
                  Results: "FS01",
                  Phone: "555-0100",
                },
              ],
            });
          };
          await runEnrichmentOne();
          ctx = await enrichmentDetails(pool(), lead);
          assert.equal(ctx.contacts, null);
          assert.equal(ctx.jobs[0].status, "blocked");
          assert.equal(ctx.providers.melissa.remaining_units, 0);
          await reviewOwner(lead, { suppressed: false });
          await assert.rejects(queueEnrichment(lead, "contacts"), /exhausted/);
        },
      );
      await t.test(
        "Unknown provider outcomes retain reservations and are never replayed",
        async () => {
          await pool().query("DELETE FROM enrichment_results WHERE kind=$1", [
            "owner",
          ]);
          const lead = await leadDetail(leadId);
          await queueEnrichment(lead, "owner");
          globalThis.fetch = async () => {
            throw Error("Network timeout with secret URL");
          };
          await runEnrichmentOne();
          const ctx = await enrichmentDetails(pool(), lead);
          assert.equal(ctx.jobs[0].status, "uncertain");
          assert.equal(ctx.providers.realie.remaining_units, 0);
          assert.ok(!ctx.jobs[0].message.includes("secret"));
          assert.equal(await runEnrichmentOne(), false);
          await pool().query(
            "INSERT INTO enrichment_jobs(lead_id,cache_key,kind,status) VALUES($1,'interrupted','owner','running')",
            [leadId],
          );
          const runId = await queueSource("la-issued");
          await pool().query("UPDATE runs SET status='running' WHERE id=$1", [
            runId,
          ]);
          await recoverJobs();
          assert.equal(
            (
              await pool().query(
                "SELECT status FROM enrichment_jobs WHERE cache_key='interrupted'",
              )
            ).rows[0].status,
            "uncertain",
          );
          assert.equal(
            (
              await pool().query(
                "SELECT count(*)::integer n FROM runs WHERE source_id='la-issued' AND status='queued'",
              )
            ).rows[0].n,
            1,
          );
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
      await pool().end();
      for (const k of Object.keys(process.env))
        if (!(k in previous)) delete process.env[k];
      Object.assign(process.env, previous);
    }
  },
);
