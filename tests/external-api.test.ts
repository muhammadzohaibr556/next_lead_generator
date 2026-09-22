import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCursor,
  encodeCursor,
  externalLeadQuerySchema,
  normalizeExternalLead,
  toExternalFilters,
} from "../lib/external-api";
import { externalSecurity } from "../lib/security";

test("external lead filters translate age and location into the internal query contract", () => {
  const input = externalLeadQuerySchema.parse({
    city: "Los Angeles",
    latitude: "34.05",
    longitude: "-118.25",
    radius_miles: "10",
    age_days: "14",
    trade: "Roofing",
    limit: "5",
  });

  assert.deepEqual(toExternalFilters(input), {
    scope: "external",
    city: "Los Angeles",
    center_lat: 34.05,
    center_lon: -118.25,
    radius_miles: 10,
    trade: "Roofing",
    since: "2026-09-09",
    limit: 5,
    sort: "score",
    offset: 0,
    q: "",
    state: "",
    territory: "all",
    zip: "",
    stage: "",
    status: "",
    kind: "",
    saved: false,
    include_closed: false,
    min_score: 0,
  });
});

test("cursor encoding round trips an opaque cursor", () => {
  const cursor = { sort: "score", score: 92, signal_date: "2026-09-21", id: 17 } as const;

  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
});

test("normalized lead responses omit suppressed contact details", () => {
  const lead = {
    id: 17,
    updated_at: "2026-09-22T12:00:00.000Z",
    trade: "Roofing",
    score: 92,
    focus_reasons: [],
    permit_number: "P-17",
    jurisdiction: "los-angeles",
    description: "Replace roof shingles",
    signal_date: "2026-09-21",
    stage: "Application",
    address: "17 Main Street",
    city: "Los Angeles",
    state: "CA",
    zip: "90001",
    latitude: 34.05,
    longitude: -118.25,
    owner: "Example Owner",
  } as never;

  assert.deepEqual(
    normalizeExternalLead(lead, {
      review: { reviewed: true, suppressed: true },
      contacts: {
        candidates: [{ name: "Example Owner", email: "owner@example.test", phone: "555-0100" }],
      },
    } as never),
    {
      id: 17,
      version: "17:2026-09-22T12:00:00.000Z",
      address: {
        line1: "17 Main Street",
        city: "Los Angeles",
        state: "CA",
        postalCode: "90001",
        latitude: 34.05,
        longitude: -118.25,
      },
      permit: {
        number: "P-17",
        jurisdiction: "los-angeles",
        description: "Replace roof shingles",
        signalDate: "2026-09-21",
        stage: "Application",
      },
      classification: {
        trade: "Roofing",
        score: 92,
        reasons: [],
      },
      owner: { name: "Example Owner", confidence: null, reviewed: true },
      contacts: { email: null, phone: null, confidence: null, suppressed: true },
      updatedAt: "2026-09-22T12:00:00.000Z",
    },
  );
});

test("external security rejects a missing bearer token", () => {
  const previous = process.env.PERMIT_ATLAS_API_KEY;
  process.env.PERMIT_ATLAS_API_KEY = "api-secret";
  try {
    assert.equal(
      externalSecurity(
        new Request("http://localhost/api/v1/health", {
          headers: { host: "localhost" },
        }),
      )?.status,
      401,
    );
  } finally {
    if (previous === undefined) delete process.env.PERMIT_ATLAS_API_KEY;
    else process.env.PERMIT_ATLAS_API_KEY = previous;
  }
});

test("external security accepts the configured bearer token", () => {
  const previous = process.env.PERMIT_ATLAS_API_KEY;
  process.env.PERMIT_ATLAS_API_KEY = "api-secret";
  try {
    assert.equal(
      externalSecurity(
        new Request("http://localhost/api/v1/health", {
          headers: { host: "localhost", authorization: "Bearer api-secret" },
        }),
      ),
      null,
    );
  } finally {
    if (previous === undefined) delete process.env.PERMIT_ATLAS_API_KEY;
    else process.env.PERMIT_ATLAS_API_KEY = previous;
  }
});
