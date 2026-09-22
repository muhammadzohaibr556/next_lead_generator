import { test } from "node:test";
import assert from "node:assert/strict";
import fixtures from "./parity.json";
import {
  normalize,
  classify,
  day,
  number,
  addressKey,
  score,
  digest,
} from "../lib/engine";
import { filterSchema } from "../lib/validation";
import { csvSafe } from "../lib/api";
import {
  parseRealie,
  parseContacts,
  splitUnit,
  ownerType,
  providerConfig,
} from "../lib/enrichment";
import { security } from "../lib/security";
for (const f of fixtures.normalization)
  test("Python normalization parity: " + f.source, () =>
    assert.deepEqual(normalize(f.raw, f.source, "2026-09-22"), f.expected),
  );
for (const f of fixtures.classification)
  test("Trade rules: " + f.description, () =>
    assert.deepEqual(classify(f.description), f.expected),
  );
test("Dates, numeric values, stable hashes and address units", () => {
  assert.equal(day(0), "1970-01-01");
  assert.equal(day("2026-02-30"), "");
  assert.equal(day("2026-09-20T23:00:00-05:00"), "2026-09-21");
  assert.equal(day("9/1/2026 12:00:00 AM"), "2026-09-01");
  assert.equal(number("$14,300"), 14300);
  assert.equal(number(""), null);
  assert.equal(number("Infinity"), null);
  assert.equal(number(-1), null);
  assert.equal(
    addressKey("123 N. Test Street"),
    addressKey("123 North Test St"),
  );
  assert.notEqual(
    addressKey("10 Test St Unit 1"),
    addressKey("10 Test St Unit 2"),
  );
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
});
test("Scoring ages and terminal/future caps", () => {
  const p = normalize(
      fixtures.normalization[0].raw,
      "la-submitted",
      "2026-09-22",
    ),
    match = classify(p.description).Roofing;
  assert.equal(score(p, match, "2026-09-22")[0], 100);
  assert.equal(score({ ...p, stage: "Completed" }, match, "2026-09-22")[0], 10);
  assert.equal(score({ ...p, date_warning: true }, match, "2026-09-22")[0], 25);
  assert.equal(score(p, match, "2027-09-22")[1].Recency, 0);
});
test("Query validation rejects incomplete radius and bad values", () => {
  for (const input of [
    { center_lat: "30" },
    { radius_miles: "20", center_lat: "30", center_lon: "-90" },
    { center_lat: "NaN" },
    { min_score: "101" },
    { since: "2026-02-30" },
    { limit: "0" },
    { sort: "invalid" },
    { saved: "maybe" },
  ])
    assert.equal(
      filterSchema.safeParse(input).success,
      false,
      JSON.stringify(input),
    );
  assert.equal(filterSchema.parse({ saved: "false" }).saved, false);
  assert.equal(
    filterSchema.parse({ center_lat: "0", center_lon: "0", radius_miles: "5" })
      .center_lat,
    0,
  );
  for (const input of ["=SUM(1,2)", "  +CMD", "\ttext", "\ntext", "@x", "-3"])
    assert.ok(csvSafe(input).startsWith("'"));
  assert.equal(csvSafe("123 Test St"), "123 Test St");
});
test("Identity parsers require exact owner, unit and provider confirmation", () => {
  const lead = normalize(
    { ...fixtures.normalization[0].raw, primary_address: "123 Test St Unit 2" },
    "la-submitted",
  );
  const payload = {
    property: {
      propertyLocation: {
        address: "123 Test St Unit 2",
        state: "CA",
        city: "Los Angeles",
        zipCode: "90001",
      },
      propertyIdentification: {
        county: "Los Angeles",
        parcelId: "1234567890",
        currentOwner: {
          ownerName: "EXAMPLE LLC",
          ownerStreet: "10 Main St",
          ownerCity: "Los Angeles",
          ownerState: "CA",
          ownerZipCode: "90001",
        },
      },
      realieParcelId: "R-1",
    },
  };
  const owner = parseRealie(payload, lead, "Los Angeles", true);
  assert.equal(owner.owner_type, "Company");
  assert.throws(() =>
    parseRealie(
      payload,
      { ...lead, address: "123 Test St Unit 3" },
      "Los Angeles",
      true,
    ),
  );
  assert.throws(() => parseRealie(payload, lead, "Orange", true));
  assert.deepEqual(splitUnit("10 Main Street Apt 2"), ["10 MAIN ST", "2"]);
  assert.equal(ownerType("Jane Smith"), "Unknown");
  const record = {
    CurrentCompanyName: "EXAMPLE LLC",
    AddressLine1: "10 Main Street",
    State: "CA",
    PostalCode: "90001",
    Results: "FS01",
    Phone: "555-0100",
  };
  assert.equal(
    parseContacts({ Records: [record] }, owner, "Company").candidates.length,
    1,
  );
  assert.throws(() =>
    parseContacts(
      { Records: [{ ...record, CurrentCompanyName: "OTHER LLC" }] },
      owner,
      "Company",
    ),
  );
  assert.throws(() =>
    parseContacts(
      { Records: [{ ...record, Results: "GE01" }] },
      owner,
      "Company",
    ),
  );
  assert.throws(() =>
    parseContacts({ Records: [record, record] }, owner, "Company"),
  );
});
test("Workspace security and provider configuration fail closed", () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, {
      NODE_ENV: "production",
      APP_USERNAME: "",
      APP_PASSWORD: "",
      ALLOWED_HOSTS: "localhost",
    });
    assert.equal(security(new Request("http://localhost/"))?.status, 503);
    Object.assign(process.env, {
      APP_USERNAME: "test",
      APP_PASSWORD: "secret",
    });
    assert.equal(security(new Request("http://localhost/"))?.status, 401);
    const headers = {
      authorization: "Basic " + Buffer.from("test:secret").toString("base64"),
      "Content-Type": "application/json",
    };
    assert.equal(security(new Request("http://localhost/", { headers })), null);
    assert.equal(
      security(new Request("http://evil.example/", { headers }))?.status,
      400,
    );
    assert.equal(
      security(
        new Request("http://localhost/api/sync", {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.example" },
        }),
      )?.status,
      403,
    );
    Object.assign(process.env, {
      REALIE_API_KEY: "test",
      REALIE_TRIAL_ID: "test",
      REALIE_TRIAL_EXPIRES: "2099-01-01T00:00:00Z",
      REALIE_FREE_UNITS: "10",
      REALIE_MAX_UNITS_PER_REQUEST: "1",
      REALIE_CACHE_DAYS: "30",
      REALIE_RIGHTS_CONFIRMED: "0",
      REALIE_NO_CHARGE_CONFIRMED: "0",
    });
    assert.equal(providerConfig("realie").ready, false);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
