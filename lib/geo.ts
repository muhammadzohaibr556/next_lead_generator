import { addressKey, digest, text, coordinate } from "./engine";
import { pool, type DB } from "./db";
import { leadQuery } from "./leads";
import { sleep } from "./sources";
import type { Permit } from "./types";
export const locationKey = (
  lead: Pick<Permit, "address" | "city" | "state" | "zip">,
) =>
  digest(
    [lead.address, lead.city, lead.state, lead.zip].map((v) =>
      addressKey(text(v)),
    ),
  );
export function coordinates(
  lat: unknown,
  lon: unknown,
): [number, number] | null {
  const a = coordinate(lat, 90),
    b = coordinate(lon, 180);
  return a === null || b === null ? null : [a, b];
}
export async function syncLocation(db: DB, id: number, lead: Permit) {
  const key = locationKey(lead);
  let point = coordinates(lead.latitude, lead.longitude),
    provider = "",
    method = "",
    matched = "",
    fetched: string | null = null,
    expires: string | null = null,
    status = "pending";
  if (point) {
    provider = "Municipal source";
    method = "Published coordinates";
    matched = lead.address;
    fetched = new Date().toISOString();
    status = "mapped";
  } else {
    const previous = (
      await db.query(
        "SELECT * FROM lead_locations WHERE lead_id=$1 AND address_key=$2 AND provider='Realie' AND expires_at>now()",
        [id, key],
      )
    ).rows[0];
    const cached =
      previous ||
      (
        await db.query(
          "SELECT * FROM geocode_cache WHERE address_key=$1 AND expires_at>now()",
          [key],
        )
      ).rows[0];
    if (cached) {
      status = cached.status;
      point = coordinates(cached.latitude, cached.longitude);
      provider = previous ? "Realie" : "Census";
      method = previous
        ? "Parcel centroid"
        : "Approximate · Census address match";
      matched = cached.matched_address;
      fetched = cached.fetched_at;
      expires = cached.expires_at;
    }
    if (!text(lead.address)) status = "unmatched";
  }
  await db.query(
    `INSERT INTO lead_locations(lead_id,address_key,latitude,longitude,provider,match_method,matched_address,fetched_at,expires_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
 ON CONFLICT(lead_id) DO UPDATE SET address_key=excluded.address_key,latitude=excluded.latitude,longitude=excluded.longitude,provider=excluded.provider,match_method=excluded.match_method,matched_address=excluded.matched_address,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at,status=excluded.status`,
    [
      id,
      key,
      point?.[0] ?? null,
      point?.[1] ?? null,
      provider,
      method,
      matched,
      fetched,
      expires,
      status,
    ],
  );
}
export function censusMatch(
  data: unknown,
  lead: Permit,
): [number, number, string] | null {
  const matches = (
    data as {
      result?: {
        addressMatches?: {
          addressComponents?: { state?: string; zip?: string };
          coordinates?: { x?: number; y?: number };
          matchedAddress?: string;
        }[];
      };
    }
  )?.result?.addressMatches;
  if (!Array.isArray(matches) || matches.length !== 1) return null;
  const m = matches[0],
    c = m.addressComponents || {};
  if (
    c.state?.toUpperCase() !== lead.state.toUpperCase() ||
    (lead.zip && String(c.zip || "").slice(0, 5) !== lead.zip.slice(0, 5))
  )
    return null;
  const point = coordinates(m.coordinates?.y, m.coordinates?.x);
  return point ? [...point, text(m.matchedAddress)] : null;
}
let lastRequest = 0;
export async function geocodeOne() {
  const base = leadQuery({ scope: "prospecting", territory: "all" }),
    db = pool();
  const row = (
    await db.query(
      `SELECT l.id,l.payload,c.attempts,c.status FROM leads l JOIN lead_locations g ON g.lead_id=l.id LEFT JOIN geocode_cache c ON c.address_key=g.address_key
 WHERE l.id IN (SELECT id FROM (${base.sql}) focus) AND (g.latitude IS NULL OR g.expires_at<=now())
 AND (c.address_key IS NULL OR c.expires_at<=now() OR (c.status='pending' AND c.retry_at<=now())) ORDER BY l.signal_date DESC,l.id LIMIT 1`,
      base.args,
    )
  ).rows[0];
  if (!row) return false;
  const lead = row.payload as Permit,
    key = locationKey(lead),
    attempts = row.status === "pending" ? row.attempts : 0;
  await sleep(Math.max(0, 1000 - (Date.now() - lastRequest)));
  lastRequest = Date.now();
  let point: [number, number, string] | null = null,
    status = "unmatched",
    retry: string | null = null;
  try {
    const url = new URL(
      "https://geocoding.geo.census.gov/geocoder/locations/address",
    );
    url.search = new URLSearchParams({
      street: lead.address,
      city: lead.city,
      state: lead.state,
      zip: lead.zip,
      benchmark: "Public_AR_Current",
      format: "json",
    }).toString();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      redirect: "error",
    });
    if (!response.ok) throw Error("Geocoder unavailable");
    point = censusMatch(await response.json(), lead);
    if (point) status = "mapped";
  } catch {
    status = attempts < 2 ? "pending" : "failed";
    retry = new Date(Date.now() + 2 ** attempts * 60000).toISOString();
  }
  const expires =
    status === "pending"
      ? null
      : new Date(Date.now() + (point ? 180 : 30) * 86400000).toISOString();
  await db.query(
    `INSERT INTO geocode_cache(address_key,address,status,latitude,longitude,matched_address,fetched_at,expires_at,attempts,retry_at) VALUES($1,$2,$3,$4,$5,$6,now(),$7,$8,$9)
 ON CONFLICT(address_key) DO UPDATE SET status=excluded.status,latitude=excluded.latitude,longitude=excluded.longitude,matched_address=excluded.matched_address,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at,attempts=excluded.attempts,retry_at=excluded.retry_at`,
    [
      key,
      JSON.stringify({
        address: lead.address,
        city: lead.city,
        state: lead.state,
        zip: lead.zip,
      }),
      status,
      point?.[0] ?? null,
      point?.[1] ?? null,
      point?.[2] || "",
      expires,
      attempts + 1,
      retry,
    ],
  );
  await db.query(
    "UPDATE lead_locations SET latitude=$1,longitude=$2,provider='Census',match_method='Approximate · Census address match',matched_address=$3,fetched_at=now(),expires_at=$4,status=$5 WHERE address_key=$6 AND (provider NOT IN ('Municipal source','Realie') OR expires_at<=now())",
    [
      point?.[0] ?? null,
      point?.[1] ?? null,
      point?.[2] || "",
      expires,
      status,
      key,
    ],
  );
  return true;
}
