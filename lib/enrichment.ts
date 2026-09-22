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
export function splitUnit(v: unknown): [string, string] {
  const s = addressKey(text(v)).replace(/ STE /g, " UNIT "),
    m = s.match(/\s+(?:UNIT\s+|#\s*)(.+)$/);
  return m ? [s.slice(0, m.index).trim(), cleanId(m[1])] : [s, ""];
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
  candidates: { name: string; role: string; phone: string; email: string }[];
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
const contactKey = (owner: Owner, kind: string) =>
  "contacts:" + digest([owner.identity_hash, kind]);
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
  let contacts = owner
    ? await cached<Contacts>(db, contactKey(owner, review.owner_type))
    : null;
  if (!contacts || review.contact_hash !== contacts.identity_hash)
    review.contacts_verified = false;
  if (review.suppressed) contacts = null;
  const keys = [lookupKey(lead), key];
  if (owner) keys.push(contactKey(owner, review.owner_type));
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
    consumer_append_enabled:
      process.env.MELISSA_CONSUMER_APPEND_CONFIRMED === "1",
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
    const contacts = await cached<Contacts>(db, contactKey(owner, selected));
    if (verified && (!contacts?.candidates.length || !reviewed))
      throw new HttpError(
        409,
        "Review the owner and returned contact identity first.",
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
        contacts?.identity_hash || "",
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
function requireContact(owner: Owner | null, review: Review) {
  if (
    !owner ||
    !review.reviewed ||
    !["Person", "Company"].includes(review.owner_type)
  )
    throw new HttpError(
      409,
      "Review the matched owner and choose Person or Company first.",
    );
  if (review.suppressed)
    throw new HttpError(
      409,
      "This owner is suppressed; contact lookup is disabled.",
    );
  if (
    review.owner_type === "Person" &&
    process.env.MELISSA_CONSUMER_APPEND_CONFIRMED !== "1"
  )
    throw new HttpError(
      409,
      "Melissa consumer Append requires a separately confirmed trial entitlement.",
    );
  if (
    ![
      owner.name,
      owner.mailing_address,
      owner.mailing_city,
      owner.mailing_state,
      owner.mailing_zip,
    ].every(Boolean)
  )
    throw new HttpError(
      409,
      "A complete owner mailing address is required for contact matching.",
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
    requireContact(ctx.owner, ctx.review);
    if (ctx.contacts) return { status: "cached" };
    key = contactKey(ctx.owner!, ctx.review.owner_type);
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
  owner: Owner,
  kind: string,
): Contacts {
  if (
    text(data?.TransmissionResults) ||
    !Array.isArray(data?.Records) ||
    data.Records.length !== 1
  )
    throw Error("Contact provider could not resolve a unique identity");
  const r = data.Records[0],
    codes = new Set<string>(text(r.Results).split(",").filter(Boolean)),
    name = text(kind === "Company" ? r.CurrentCompanyName : r.NameFull);
  const tokens = (v: string) =>
    JSON.stringify(
      v
        .toUpperCase()
        .match(/[A-Z0-9]+/g)
        ?.sort() || [],
    );
  let [street, unit] = splitUnit(
    [text(r.AddressLine1), text(r.AddressLine2 || r.Suite)]
      .filter(Boolean)
      .join(" "),
  );
  if (kind === "Company" && r.Suite && !unit) {
    street = splitUnit(r.AddressLine1)[0];
    unit = cleanId(r.Suite);
  }
  const expected = splitUnit(owner.mailing_address);
  if (
    !name ||
    tokens(name) !== tokens(owner.name) ||
    street !== expected[0] ||
    unit !== expected[1]
  )
    throw Error("Contact identity mismatch");
  if (
    text(r.State).toUpperCase() !== owner.mailing_state.toUpperCase() ||
    text(r.PostalCode).slice(0, 5) !== owner.mailing_zip.slice(0, 5)
  )
    throw Error("Contact mailing location mismatch");
  if (
    [...codes].some((c) => /^(GE|SE|AE|DE)/.test(c)) ||
    (kind === "Company" && !codes.has("FS01"))
  )
    throw Error("Contact match unconfirmed");
  if (
    kind === "Person" &&
    (!codes.has("VR01") ||
      ["VS01", "VS02", "VS12", "VS13"].some((c) => codes.has(c)))
  )
    throw Error("Current complete address match required");
  let candidates: Contacts["candidates"] = [];
  if (kind === "Company") {
    if (text(r.Phone))
      candidates.push({
        name,
        role: "Business office",
        phone: text(r.Phone),
        email: "",
      });
    if (r.Contacts && !Array.isArray(r.Contacts))
      throw Error("Invalid contact records");
    for (const p of r.Contacts || [])
      candidates.push({
        name: [text(p.NameFirst), text(p.NameLast)].filter(Boolean).join(" "),
        role: text(p.Title) || "Business contact",
        phone: text(p.ContactPhone),
        email: text(p.Email),
      });
  } else
    candidates.push({
      name,
      role: "Owner candidate",
      phone: text(r.PhoneNumber),
      email: text(r.EmailAddress),
    });
  candidates = candidates.filter((c) => c.phone || c.email);
  return {
    provider: "Melissa",
    owner_identity_hash: owner.identity_hash,
    identity_hash: digest(candidates),
    candidates,
    result_codes: [...codes].sort(),
    match_status: "Candidate · identity verification needed",
    source_url: "https://www.melissa.com/",
    owner_type: kind,
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
  owner: Owner,
  kind: string,
  cfg: ReturnType<typeof providerConfig>,
) {
  const person = kind === "Person",
    url = person
      ? "https://personator.melissadata.net/v3/WEB/ContactVerify/doContactVerify"
      : "https://businesscoder.melissadata.net/WEB/BusinessCoder/doBusinessCoderUS";
  const body = person
    ? {
        CustomerID: cfg.key,
        Actions: "Check,Verify,Append",
        Options: "Append:blank,CentricHint:Address",
        Records: [
          {
            RecordID: "1",
            FullName: owner.name,
            AddressLine1: owner.mailing_address,
            City: owner.mailing_city,
            State: owner.mailing_state,
            PostalCode: owner.mailing_zip,
            Country: "US",
          },
        ],
      }
    : {
        id: cfg.key,
        cols: "Contacts,Phone",
        opt: "ReturnDominantBusiness:no,CentricHint:company,MaxContacts:3",
        Records: [
          {
            rec: "1",
            comp: owner.name,
            a1: owner.mailing_address,
            city: owner.mailing_city,
            state: owner.mailing_state,
            postal: owner.mailing_zip,
            ctry: "US",
          },
        ],
      };
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new ProviderHttpError(response.status);
  try {
    return parseContacts(await response.json(), owner, kind);
  } catch {
    throw new UnmatchedError();
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
    const lead = { ...row.payload, id: row.id } as Permit & { id: number },
      ctx = await enrichmentDetails(db, lead);
    if (job.kind === "contacts") {
      try {
        requireContact(ctx.owner, ctx.review);
        if (contactKey(ctx.owner!, ctx.review.owner_type) !== job.cache_key)
          throw Error();
      } catch {
        return block("Owner review changed or contact lookup is suppressed.");
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
      owner: ctx.owner,
      review: ctx.review,
    };
  });
  if (!work) return false;
  if (work.blocked) return true;
  const { job, provider, cfg, lead, owner, review } = work;
  try {
    const result =
      job.kind === "owner"
        ? await fetchOwner(lead, cfg)
        : await fetchContacts(owner!, review.owner_type, cfg);
    const expires = new Date(
      Math.min(
        Date.now() + cfg.days * 86400000,
        cfg.expiry,
        job.kind === "contacts" ? Date.parse(owner!.expires_at!) : Infinity,
      ),
    ).toISOString();
    await transaction(async (db) => {
      await enrichmentLock(db);
      if (job.kind === "contacts") {
        const latest = await enrichmentDetails(db, lead);
        if (
          latest.review.suppressed ||
          !latest.review.reviewed ||
          !latest.owner ||
          contactKey(latest.owner, latest.review.owner_type) !== job.cache_key
        ) {
          await db.query(
            "UPDATE enrichment_jobs SET status='blocked',finished_at=now(),message='Identity review changed during lookup; results discarded.' WHERE id=$1",
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
      e instanceof ProviderHttpError
        ? "failed"
        : e instanceof UnmatchedError
          ? "unmatched"
          : "uncertain";
    const message =
      e instanceof ProviderHttpError
        ? `Provider returned HTTP ${e.code}; no automatic retry.`
        : e instanceof UnmatchedError
          ? "No reliable match returned; owner/contact details were not guessed."
          : "Provider request outcome uncertain; check trial usage before retrying.";
    await pool().query(
      "UPDATE enrichment_jobs SET status=$1,finished_at=now(),message=$2 WHERE id=$3",
      [status, message, job.id],
    );
  }
  return true;
}
