import { test } from "node:test";
import assert from "node:assert/strict";
import { migrate } from "../scripts/migrate";
import { pool } from "../lib/db";
import { handleApi, leadDetail } from "../lib/api";
import { lookupKey } from "../lib/enrichment";
import { today } from "../lib/engine";

const testUrl = process.env.EXTERNAL_TEST_DATABASE_URL;

test(
  "external v1 API exposes authenticated lead contract and idempotent enrichment",
  { skip: !testUrl },
  async () => {
    const previous = { ...process.env };
    Object.assign(process.env, {
      DATABASE_URL: testUrl,
      NODE_ENV: "test",
      ALLOWED_HOSTS: "localhost",
      APP_USERNAME: "",
      APP_PASSWORD: "",
      PERMIT_ATLAS_API_KEY: "external-test-key",
      AUTO_SYNC: "0",
      REALIE_API_KEY: "",
      MELISSA_API_KEY: "",
    });
    const request = async (
      path: string,
      method = "GET",
      input?: unknown,
      headers: Record<string, string> = {},
    ) =>
      handleApi(
        new Request("http://localhost/api/v1/" + path, {
          method,
          headers: {
            authorization: "Bearer external-test-key",
            "content-type": "application/json",
            ...headers,
          },
          body: input === undefined ? undefined : JSON.stringify(input),
        }),
      );
    try {
      await migrate();
      await pool().query(
        "TRUNCATE external_api_idempotency,sources,projects,property_enrichment,geocode_cache,enrichment_results,enrichment_aliases,enrichment_reviews,trial_usage CASCADE",
      );
      await migrate();
      const payload = (address: string, signalDate: string) => ({
        permit_number: "P-1",
        project_ref: "P-1",
        project_key: address,
        address,
        address_key: address.toUpperCase(),
        zip: "90001",
        apn: "1234567890",
        description: "Replace roof shingles",
        permit_type: "Roofing",
        property_type: "Residential",
        applied_date: signalDate,
        issue_date: "",
        completed_date: "",
        activity_date: signalDate,
        signal_date: signalDate,
        signal_date_kind: "submitted",
        date_warning: false,
        raw_status: "Application Submitted",
        stage: "Application",
        contractor: "",
        contractor_phone: "",
        permit_holder: "",
        owner: "Example Owner",
        latitude: 34.05,
        longitude: -118.25,
        source_id: "la-submitted",
        jurisdiction: "los-angeles",
        city: "Los Angeles",
        state: "CA",
        source_url: "https://example.test/permit",
        value: 18000,
        sqft: 2000,
        match: { kind: "Direct", evidence: "roof", confidence: 1 },
        permit_count: 1,
        trade_permit_count: 1,
        score_base: 70,
        grouping: "project",
      });
      await pool().query("INSERT INTO projects(project_key) VALUES($1),($2)", ["123 Main Street", "125 Main Street"]);
      const inserted = await pool().query(
        "INSERT INTO leads(project_key,trade,payload) VALUES($1,'Roofing',$2),($3,'Roofing',$4) RETURNING id",
        ["123 Main Street", JSON.stringify(payload("123 Main Street", today())), "125 Main Street", JSON.stringify(payload("125 Main Street", today()))],
      );
      const leadId = inserted.rows[0].id as number;
      const lead = await leadDetail(leadId);
      await pool().query(
        "INSERT INTO enrichment_results(cache_key,kind,provider,payload,expires_at) VALUES($1,'owner','fixture',$2,now()+interval '1 day')",
        [lookupKey(lead), JSON.stringify({ name: "Example Owner", identity_hash: "owner-1", owner_type: "Person" })],
      );

      assert.equal(
        (await handleApi(new Request("http://localhost/api/v1/health"))).status,
        401,
      );
      const health = await request("health");
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "ok", api_version: "v1" });

      const first = await request("leads?state=CA&trade=Roofing&age_days=30&limit=1");
      assert.equal(first.status, 200);
      const firstBody = await first.json();
      assert.equal(firstBody.items.length, 1);
      assert.equal(firstBody.items[0].permit.number, "P-1");
      assert.equal(firstBody.has_more, true);
      assert.equal(typeof firstBody.next_cursor, "string");

      const second = await request(
        "leads?state=CA&trade=Roofing&age_days=30&limit=1&cursor=" + encodeURIComponent(firstBody.next_cursor),
      );
      assert.equal(second.status, 200);
      assert.equal((await second.json()).items.length, 1);

      const detail = await request("leads/" + leadId);
      assert.equal(detail.status, 200);
      assert.equal((await detail.json()).address.line1, "123 Main Street");

      const firstEnrichment = await request("leads/" + leadId + "/enrich", "POST", { kind: "owner" }, { "idempotency-key": "demo-owner-1" });
      assert.equal(firstEnrichment.status, 200);
      const firstEnrichmentBody = await firstEnrichment.json();
      const replay = await request("leads/" + leadId + "/enrich", "POST", { kind: "owner" }, { "idempotency-key": "demo-owner-1" });
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), firstEnrichmentBody);
    } finally {
      for (const key of Object.keys(process.env))
        if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  },
);
