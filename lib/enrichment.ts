import { pool, transaction, enrichmentLock, type DB } from "./db";
import { addressKey, digest, text, number } from "./engine";
import { coordinates, locationKey } from "./geo";
import { HttpError, reviewUpdate } from "./validation";
import type { Permit } from "./types";
import type { z } from "zod";
const COUNTIES: Record<string, string> = {
  "los-angeles": "Los Angeles",
  pasadena: "Los Angeles",
  "san-francisco": "San Francisco",
  "san-diego": "San Diego",
  "san-jose": "Santa Clara",
  sacramento: "Sacramento",
  "west-sacramento": "Yolo",
};
export const cleanId = (v: unknown) =>
  text(v)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
const unitId = (v: unknown) =>
  cleanId(
    text(v).replace(
      /^(?:APARTMENT|APT|SUITE|STE|UNIT|FLOOR|FL|#)\s*/i,
      "",
    ),
  );
export function splitUnit(v: unknown): [string, string] {
  const s = addressKey(text(v)).replace(/ STE /g, " UNIT "),
    m = s.match(/\s+(?:(?:UNIT|FLOOR|FL)\s+|#\s*)(.+)$/);
  return m ? [s.slice(0, m.index).trim(), unitId(m[1])] : [s, ""];
}
export function sameStreet(a: string, b: string) {
  if (a === b) return true;
  const parts = (value: string) => value.split(" "),
    directions = (value: string) =>
      parts(value).filter((part) => /^(N|S|E|W)$/.test(part)),
    aDirections = directions(a),
    bDirections = directions(b);
  if (aDirections.length + bDirections.length !== 1) return false;
  const withoutDirection = (value: string) =>
    parts(value)
      .filter((part) => !/^(N|S|E|W)$/.test(part))
      .join(" ");
  return withoutDirection(a) === withoutDirection(b);
}
export function ownerType(name: string) {
  return /\b(TRUST|TRUSTEE|ESTATE|TRUSTEES|CITY OF|COUNTY OF)\b/i.test(name)
    ? "Trust/Other"
    : /\b(LLC|L L C|INC|CORP|CORPORATION|LTD|LP|LLP|COMPANY)\b/i.test(name)
      ? "Company"
      : "Unknown";
}
export function lookupKey(lead: Permit) {
  const county = text(lead.county) || COUNTIES[lead.jurisdiction] || "";
  return county && lead.apn
    ? "parcel:" +
        digest([
          lead.state,
          cleanId(county),
          cleanId(lead.apn),
          splitUnit(lead.address)[1],
        ])
    : "address:" + locationKey(lead);
}
export interface Owner {
  name: string;
  second_owner: string;
  owner_type: string;
  mailing_address: string;
  mailing_city: string;
  mailing_state: string;
  mailing_zip: string;
  parcel_id: string;
  realie_parcel_id: string;
  property_address: string;
  property_unit: string;
  year_built: unknown;
  building_sqft: number | null;
  latitude: number | null;
  longitude: number | null;
  provider: string;
  match_method: string;
  source_url: string;
  record_date: string;
  identity_hash: string;
  fetched_at?: string;
  expires_at?: string;
}
export interface Contacts {
  provider: string;
  owner_identity_hash: string;
  identity_hash: string;
  candidates: {
    identity_key?: string;
    name: string;
    role: string;
    phone: string;
    email: string;
  }[];
  result_codes: string[];
  match_status: string;
  source_url: string;
  owner_type: string;
  fetched_at?: string;
  expires_at?: string;
}
export interface Review {
  owner_type: string;
  reviewed: boolean;
  contacts_verified: boolean;
  suppressed: boolean;
  owner_hash?: string;
  contact_hash?: string;
}
export function providerConfig(provider: string) {
  const prefix = provider.toUpperCase(),
    env = (name: string) => process.env[prefix + "_" + name] || "";
  const expiry = Date.parse(env("TRIAL_EXPIRES")),
    valid =
      /(Z|[+-]\d\d:\d\d)$/i.test(env("TRIAL_EXPIRES")) &&
      Number.isFinite(expiry) &&
      expiry > Date.now();
  const integer = (name: string) =>
    /^\d+$/.test(env(name)) && Number.isSafeInteger(Number(env(name)))
      ? Number(env(name))
      : 0;
  const units = integer("FREE_UNITS"),
    cost = integer("MAX_UNITS_PER_REQUEST"),
    days = integer("CACHE_DAYS"),
    key = env("API_KEY"),
    trial = env("TRIAL_ID");
  const checks: Record<string, boolean> = {
    API_KEY: !!key.trim(),
    TRIAL_ID: !!trial.trim(),
    "TRIAL_EXPIRES (future date with timezone)": valid,
    "FREE_UNITS (>0)": units > 0,
    "MAX_UNITS_PER_REQUEST (>0)": cost > 0,
    "CACHE_DAYS (>0)": days > 0,
    "RIGHTS_CONFIRMED (=1)": env("RIGHTS_CONFIRMED") === "1",
    "NO_CHARGE_CONFIRMED (=1)": env("NO_CHARGE_CONFIRMED") === "1",
  };
  const missing = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => prefix + "_" + name);
  return {
    ready: !missing.length,
    missing,
    key,
    trial,
    units,
    cost,
    days,
    expiry,
  };
}
export async function providerStatus(db: DB, provider: string) {
  const cfg = providerConfig(provider),
    used =
      (
        await db.query(
          "SELECT units FROM trial_usage WHERE provider=$1 AND trial_id=$2",
          [provider, cfg.trial],
        )
      ).rows[0]?.units || 0,
    remaining = Math.max(0, cfg.units - used),
    available = cfg.ready && remaining >= cfg.cost;
  return {
    available,
    remaining_units: cfg.ready ? remaining : 0,
    message: available
      ? "Trial available · on request"
      : cfg.ready
        ? "Trial allowance exhausted"
        : "Not enabled · configure " + cfg.missing.join(", "),
  };
}
async function cached<T>(db: DB, key: string): Promise<T | null> {
  const row = (
    await db.query(
      "SELECT * FROM enrichment_results WHERE cache_key=$1 AND expires_at>now()",
      [key],
    )
  ).rows[0];
  return row
    ? { ...row.payload, fetched_at: row.fetched_at, expires_at: row.expires_at }
    : null;
}
async function ownerContext(db: DB, lead: Permit) {
  let key = lookupKey(lead);
  key =
    (
      await db.query(
        "SELECT owner_key FROM enrichment_aliases WHERE lookup_key=$1",
        [key],
      )
    ).rows[0]?.owner_key || key;
  return { key, owner: await cached<Owner>(db, key) };
}
const contactKey = (lead: Permit) => "contacts:address:" + locationKey(lead);
export async function enrichmentDetails(db: DB, lead: Permit) {
  const { key, owner } = await ownerContext(db, lead);
  const review: Review = (
    await db.query("SELECT * FROM enrichment_reviews WHERE owner_key=$1", [key])
  ).rows[0] || {
    owner_type: owner?.owner_type || "Unknown",
    reviewed: false,
    contacts_verified: false,
    suppressed: false,
  };
  if (!owner || review.owner_hash !== owner.identity_hash) {
    review.reviewed = false;
    review.contacts_verified = false;
  }
  if (
    owner &&
    (
      await db.query(
        "SELECT 1 FROM enrichment_reviews WHERE owner_hash=$1 AND suppressed LIMIT 1",
        [owner.identity_hash],
      )
    ).rowCount
  )
    review.suppressed = true;
  const contacts = await cached<Contacts>(db, contactKey(lead));
  review.contacts_verified = false;
  const keys = [lookupKey(lead), key, contactKey(lead)];
  const jobs = (
    await db.query(
      "SELECT id,kind,status,queued_at,finished_at,message FROM enrichment_jobs WHERE cache_key=ANY($1::text[]) ORDER BY id DESC LIMIT 6",
      [keys],
    )
  ).rows as {
    id: number;
    kind: string;
    status: string;
    queued_at: string;
    finished_at: string | null;
    message: string;
  }[];
  return {
    owner,
    contacts,
    review,
    jobs,
    providers: {
      realie: await providerStatus(db, "realie"),
      melissa: await providerStatus(db, "melissa"),
    },
    personator_search_enabled:
      process.env.MELISSA_PERSONATOR_SEARCH_CONFIRMED === "1",
  };
}
export type EnrichmentDetails = Awaited<ReturnType<typeof enrichmentDetails>>;
export async function reviewOwner(
  lead: Permit,
  update: z.infer<typeof reviewUpdate>,
) {
  return transaction(async (db) => {
    await enrichmentLock(db);
    const { key, owner } = await ownerContext(db, lead);
    if (!owner)
      throw new HttpError(
        409,
        "Find a uniquely matched owner before reviewing identity.",
      );
    const current = (await enrichmentDetails(db, lead)).review,
      selected = update.owner_type ?? current.owner_type;
    let reviewed = update.reviewed ?? current.reviewed,
      verified = update.contacts_verified ?? current.contacts_verified;
    if (selected !== current.owner_type) {
      reviewed = update.reviewed ?? false;
      verified = false;
    }
    if (verified)
      throw new HttpError(
        409,
        "Address-associated contacts cannot be verified as property owners.",
      );
    const suppressed = update.suppressed ?? current.suppressed;
    if (suppressed) verified = false;
    await db.query(
      `INSERT INTO enrichment_reviews(owner_key,owner_hash,owner_type,reviewed,contact_hash,contacts_verified,suppressed) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(owner_key) DO UPDATE SET owner_hash=excluded.owner_hash,owner_type=excluded.owner_type,reviewed=excluded.reviewed,contact_hash=excluded.contact_hash,contacts_verified=excluded.contacts_verified,suppressed=excluded.suppressed`,
      [
        key,
        owner.identity_hash,
        selected,
        reviewed,
        "",
        verified,
        suppressed,
      ],
    );
    if (update.suppressed !== undefined)
      await db.query(
        "UPDATE enrichment_reviews SET suppressed=$1,contacts_verified=CASE WHEN $1 THEN false ELSE contacts_verified END WHERE owner_hash=$2",
        [suppressed, owner.identity_hash],
      );
    return { ok: true };
  });
}
function requireContact(lead: Permit) {
  if (process.env.MELISSA_PERSONATOR_SEARCH_CONFIRMED !== "1")
    throw new HttpError(
      409,
      "Melissa Personator Search requires a separately confirmed trial entitlement.",
    );
  if (!lead.address || !lead.state || (!lead.zip && !lead.city))
    throw new HttpError(
      422,
      "A project address with ZIP or city/state is required for contact lookup.",
    );
}
export async function queueEnrichment(
  lead: Permit & { id: number },
  kind: "owner" | "contacts",
) {
  return transaction((db) => queueEnrichmentInTransaction(db, lead, kind));
}
export async function queueEnrichmentInTransaction(
  db: DB,
  lead: Permit & { id: number },
  kind: "owner" | "contacts",
) {
  await enrichmentLock(db);
  const ctx = await enrichmentDetails(db, lead);
  let key: string, provider: string;
  if (kind === "owner") {
    if (ctx.owner) return { status: "cached" };
    key = lookupKey(lead);
    provider = "realie";
  } else {
    requireContact(lead);
    if (ctx.contacts) return { status: "cached" };
    key = contactKey(lead);
    provider = "melissa";
  }
  const pending = (
    await db.query(
      "SELECT id,status FROM enrichment_jobs WHERE cache_key=$1 AND kind=$2 AND status IN ('queued','running')",
      [key, kind],
    )
  ).rows[0];
  if (pending) return pending;
  const state = await providerStatus(db, provider);
  if (!state.available) throw new HttpError(409, state.message);
  if (!lead.address)
    throw new HttpError(422, "A project address is required.");
  return (
    await db.query(
      "INSERT INTO enrichment_jobs(lead_id,cache_key,kind) VALUES($1,$2,$3) RETURNING id,status",
      [lead.id, key, kind],
    )
  ).rows[0];
}
// Provider payloads have variable nested schemas; every identity field is checked below.
type ProviderRecord = Record<string, any>;
class ProviderRejectedError extends Error {}
export function parseRealie(
  data: ProviderRecord,
  lead: Permit,
  county: string,
  parcelLookup: boolean,
): Owner {
  const p = data?.property;
  if (!p || typeof p !== "object" || Array.isArray(p) || !Object.keys(p).length)
    throw Error("No unique property record");
  const loc = p.propertyLocation || p,
    ident = p.propertyIdentification || {},
    owner = ident.currentOwner || p;
  const returnedAddress = text(loc.addressUnit || loc.address || p.address),
    [street, rawUnit] = splitUnit(returnedAddress),
    unit = cleanId(loc.unitNumberStripped || loc.unitNumber) || rawUnit,
    [expectedStreet, expectedUnit] = splitUnit(lead.address);
  if (
    text(loc.state || p.state).toUpperCase() !== lead.state.toUpperCase() ||
    unit !== expectedUnit
  )
    throw Error("Property state or unit mismatch");
  if (
    text(loc.city || p.city).toUpperCase() !== lead.city.toUpperCase() ||
    (lead.zip &&
      text(loc.zipCode || p.zipCode).slice(0, 5) !== lead.zip.slice(0, 5))
  )
    throw Error("Property city or ZIP mismatch");
  if (parcelLookup) {
    if (
      cleanId(p.parcelId || ident.parcelId) !== cleanId(lead.apn) ||
      cleanId(text(ident.county || p.county).replace(/ County$/, "")) !==
        cleanId(county.replace(/ County$/, ""))
    )
      throw Error("Parcel or county mismatch");
  } else if (street !== expectedStreet) throw Error("Property street mismatch");
  const name = text(owner.ownerName);
  if (!name) throw Error("Owner not published");
  const buildings = p.buildings || [],
    building =
      Array.isArray(buildings) && buildings.length === 1 ? buildings[0] : {},
    point = coordinates(p.latitude, p.longitude);
  const result: Owner = {
    name,
    second_owner: text(owner.ownerName2),
    owner_type: ownerType(name),
    mailing_address: text(
      owner.ownerStreet || owner.ownerAddressLine1 || owner.ownerAddress,
    ),
    mailing_city: text(owner.ownerCity),
    mailing_state: text(owner.ownerState),
    mailing_zip: text(owner.ownerZipCode || owner.ownerZip).slice(0, 5),
    parcel_id: text(p.parcelId || ident.parcelId),
    realie_parcel_id: text(p.realieParcelId),
    property_address: returnedAddress,
    property_unit: unit,
    year_built: building.actualYearBuilt || p.yearBuilt || null,
    building_sqft: number(building.buildingArea || p.buildingArea),
    latitude: point?.[0] ?? null,
    longitude: point?.[1] ?? null,
    provider: "Realie",
    match_method: parcelLookup
      ? "County + parcel + locality/unit"
      : "Street + locality + unit",
    source_url: "https://www.realie.ai/property-data",
    record_date: text(p.lastUpdated || p.updateDate),
    identity_hash: "",
  };
  result.identity_hash = digest(
    [
      result.name,
      result.second_owner,
      result.mailing_address,
      result.mailing_city,
      result.mailing_state,
      result.mailing_zip,
    ].map(addressKey),
  );
  return result;
}
export function parseContacts(
  data: ProviderRecord,
  lead: Permit,
): Contacts {
  const transmissionCodes: string[] = Array.from(
    text(data?.TransmissionResults).match(/[A-Z]{2}\d{2}/g) || [],
  );
  if (transmissionCodes.some((code) => /^(GE|SE)/.test(code)))
    throw new ProviderRejectedError(
      `Contact provider rejected the request (${transmissionCodes.join(", ")})`,
    );
  if (!transmissionCodes.some((code) => code === "US01" || code === "US02"))
    throw Error(
      `Personator Search returned ${transmissionCodes.join(", ") || "no match code"}`,
    );
  if (!Array.isArray(data?.Records) || !data.Records.length)
    throw Error("No people were returned for this address");
  const expected = splitUnit(lead.address);
  const matches = data.Records.filter((record: ProviderRecord) => {
    const r = record.CurrentAddress || {},
      name = text(record.FullName),
      [street, embeddedUnit] = splitUnit(r.AddressLine1),
      unit = unitId(r.AddressLine2 || r.Suite) || embeddedUnit,
      codes = text(record.Results).split(",");
    return (
      !!name &&
      sameStreet(street, expected[0]) &&
      (!expected[1] || unit === expected[1]) &&
      text(r.State).toUpperCase() === lead.state.toUpperCase() &&
      (!lead.zip ||
        text(r.PostalCode).slice(0, 5) === lead.zip.slice(0, 5)) &&
      (!lead.city || text(r.City).toUpperCase() === lead.city.toUpperCase()) &&
      !codes.includes("VS01") &&
      (!expected[1] || !codes.includes("VS02"))
    );
  });
  if (!matches.length)
    throw Error(
      `Contact address mismatch (${data.Records.length} returned, 0 matched)`,
    );
  const codes = new Set<string>(
      matches.flatMap((record: ProviderRecord) =>
        text(record.Results).split(",").filter(Boolean),
      ),
    );
  if ([...codes].some((code) => /^(GE|SE|AE|DE)/.test(code)))
    throw Error("Contact match unconfirmed");
  const identities = new Map<
    string,
    { name: string; phones: Set<string>; emails: Set<string> }
  >();
  for (const [index, record] of matches.entries()) {
    const key = text(record.MelissaIdentityKey) || `record-${index}`,
      identity = identities.get(key) || {
        name: text(record.FullName),
        phones: new Set<string>(),
        emails: new Set<string>(),
      };
    for (const phone of Array.isArray(record.PhoneRecords)
      ? record.PhoneRecords
      : []) {
      const value = text(
        phone.PhoneNumber || phone.phoneNumber || phone.Phone || phone.phone,
      );
      if (value) identity.phones.add(value);
    }
    for (const email of Array.isArray(record.EmailRecords)
      ? record.EmailRecords
      : []) {
      const value = text(
        email.EmailAddress || email.emailAddress || email.Email || email.email,
      );
      if (value) identity.emails.add(value);
    }
    identities.set(key, identity);
  }
  const candidates: Contacts["candidates"] = [];
  for (const [identityKey, identity] of identities) {
    const phones = [...identity.phones],
      emails = [...identity.emails],
      rows = Math.max(1, phones.length, emails.length);
    for (let i = 0; i < rows; i++)
      candidates.push({
        identity_key: identityKey.startsWith("record-") ? "" : identityKey,
        name: identity.name,
        role: "Person associated with address",
        phone: phones[i] || "",
        email: emails[i] || "",
      });
  }
  return {
    provider: "Melissa",
    owner_identity_hash: locationKey(lead),
    identity_hash: digest(candidates),
    candidates,
    result_codes: [...new Set([...transmissionCodes, ...codes])].sort(),
    match_status: codes.has("VS02")
      ? "Building address match · unit and ownership not verified"
      : "Address match · ownership not verified",
    source_url:
      "https://docs.melissa.com/cloud-api/personator-search/personator-search-index.html",
    owner_type: "Address",
  };
}
class ProviderHttpError extends Error {
  constructor(public code: number) {
    super("Provider HTTP " + code);
  }
}
class UnmatchedError extends Error {}
async function fetchOwner(
  lead: Permit,
  cfg: ReturnType<typeof providerConfig>,
) {
  const county = text(lead.county) || COUNTIES[lead.jurisdiction] || "",
    parcel = !!(county && lead.apn),
    [street, unit] = splitUnit(lead.address),
    params: Record<string, string> = { state: lead.state };
  if (parcel) Object.assign(params, { county, parcelId: lead.apn });
  else {
    params.address = street;
    if (unit) params.unitNumberStripped = unit;
    if (county) Object.assign(params, { county, city: lead.city });
  }
  const url =
    "https://app.realie.ai/api/public/property/" +
    (parcel ? "parcelId/" : "address/") +
    "?" +
    new URLSearchParams(params);
  const response = await fetch(url, {
    headers: { Authorization: cfg.key },
    signal: AbortSignal.timeout(20000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new ProviderHttpError(response.status);
  try {
    return parseRealie(await response.json(), lead, county, parcel);
  } catch {
    throw new UnmatchedError();
  }
}
async function fetchContacts(
  lead: Permit,
  cfg: ReturnType<typeof providerConfig>,
) {
  const url = new URL(
    "https://personatorsearch.melissadata.net/WEB/doPersonatorSearch",
  );
  url.search = new URLSearchParams({
    id: cfg.key,
    format: "JSON",
    t: "PermitAtlas",
    a1: lead.address,
    city: lead.city,
    state: lead.state,
    postal: lead.zip,
    cols: "Phone,Email,MelissaIdentityKey",
    opt: "SearchConditions:loose,SearchType:AddressSearch,ShowAllRecords,ReturnAllPages:true,MaxPhone:3,MaxEmail:3",
  }).toString();
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new ProviderHttpError(response.status);
  try {
    return parseContacts(await response.json(), lead);
  } catch (e) {
    if (e instanceof ProviderRejectedError) throw e;
    throw new UnmatchedError(
      e instanceof Error ? e.message : "No reliable match returned",
    );
  }
}
export async function runEnrichmentOne() {
  const work = await transaction(async (db) => {
    await enrichmentLock(db);
    await db.query("DELETE FROM enrichment_results WHERE expires_at<=now()");
    const job = (
      await db.query(
        "SELECT * FROM enrichment_jobs WHERE status='queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
      )
    ).rows[0];
    if (!job) return null;
    const provider = job.kind === "owner" ? "realie" : "melissa",
      cfg = providerConfig(provider),
      state = await providerStatus(db, provider);
    const block = async (message: string) => {
      await db.query(
        "UPDATE enrichment_jobs SET status='blocked',finished_at=now(),message=$1 WHERE id=$2",
        [message, job.id],
      );
      return { blocked: true as const };
    };
    if (!state.available) return block(state.message);
    const row = (
      await db.query("SELECT id,payload FROM leads WHERE id=$1", [job.lead_id])
    ).rows[0];
    if (!row) return block("Lead no longer exists.");
    const lead = { ...row.payload, id: row.id } as Permit & { id: number };
    if (job.kind === "contacts") {
      try {
        requireContact(lead);
        if (contactKey(lead) !== job.cache_key) throw Error();
      } catch {
        return block("Project address changed or contact lookup is unavailable.");
      }
    } else if (lookupKey(lead) !== job.cache_key)
      return block("Project address changed; request a new match.");
    await db.query(
      "INSERT INTO trial_usage(provider,trial_id,units) VALUES($1,$2,$3) ON CONFLICT(provider,trial_id) DO UPDATE SET units=trial_usage.units+excluded.units",
      [provider, cfg.trial, cfg.cost],
    );
    await db.query("UPDATE enrichment_jobs SET status='running' WHERE id=$1", [
      job.id,
    ]);
    return {
      blocked: false as const,
      job,
      provider,
      cfg,
      lead,
    };
  });
  if (!work) return false;
  if (work.blocked) return true;
  const { job, provider, cfg, lead } = work;
  try {
    const result =
      job.kind === "owner"
        ? await fetchOwner(lead, cfg)
        : await fetchContacts(lead, cfg);
    const expires = new Date(
      Math.min(Date.now() + cfg.days * 86400000, cfg.expiry),
    ).toISOString();
    await transaction(async (db) => {
      await enrichmentLock(db);
      if (job.kind === "contacts") {
        const row = (
          await db.query("SELECT payload FROM leads WHERE id=$1", [lead.id])
        ).rows[0];
        if (!row || contactKey(row.payload as Permit) !== job.cache_key) {
          await db.query(
            "UPDATE enrichment_jobs SET status='blocked',finished_at=now(),message='Project address changed during lookup; results discarded.' WHERE id=$1",
            [job.id],
          );
          return;
        }
      }
      let key = job.cache_key;
      if (job.kind === "owner" && (result as Owner).realie_parcel_id) {
        const o = result as Owner;
        key = "realie:" + digest([o.realie_parcel_id, o.property_unit]);
        await db.query(
          "INSERT INTO enrichment_aliases VALUES($1,$2) ON CONFLICT(lookup_key) DO UPDATE SET owner_key=excluded.owner_key",
          [job.cache_key, key],
        );
      }
      await db.query(
        "INSERT INTO enrichment_results(cache_key,kind,provider,payload,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at",
        [key, job.kind, provider, JSON.stringify(result), expires],
      );
      if (job.kind === "owner") {
        const o = result as Owner;
        if (coordinates(o.latitude, o.longitude))
          await db.query(
            "UPDATE lead_locations SET latitude=$1,longitude=$2,provider='Realie',match_method='Parcel centroid',matched_address=$3,fetched_at=now(),expires_at=$4,status='mapped' WHERE address_key=$5 AND provider<>'Municipal source'",
            [
              o.latitude,
              o.longitude,
              o.property_address,
              expires,
              locationKey(lead),
            ],
          );
      }
      await db.query(
        "UPDATE enrichment_jobs SET status='success',finished_at=now(),message='Lookup complete' WHERE id=$1",
        [job.id],
      );
    });
  } catch (e) {
    const status =
      e instanceof ProviderRejectedError
        ? "blocked"
        : e instanceof ProviderHttpError
        ? "failed"
        : e instanceof UnmatchedError
          ? "unmatched"
          : "uncertain";
    const message =
      e instanceof ProviderRejectedError
        ? `${e.message}; contact lookup is unavailable.`
        : e instanceof ProviderHttpError
        ? `Provider returned HTTP ${e.code}; no automatic retry.`
        : e instanceof UnmatchedError
          ? `${e.message}; address contact details were not guessed.`
          : "Provider request outcome uncertain; check trial usage before retrying.";
    await pool().query(
      "UPDATE enrichment_jobs SET status=$1,finished_at=now(),message=$2 WHERE id=$3",
      [status, message, job.id],
    );
  }
  return true;
}
