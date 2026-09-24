import { createHash } from "node:crypto";
import sourceData from "./sources.json";
import rules from "./rules.json";
import type { Match, Permit, Raw, Source } from "./types";
export const SOURCES: Record<string, Source> = sourceData;
export const RULES = rules;
export const TERMINAL = new Set(["Completed", "Cancelled", "Expired"]);
export const today = () => new Date().toISOString().slice(0, 10);
export const text = (v: unknown): string =>
  v == null ||
  typeof v === "object" ||
  /^(nan|none|null|n\/a|na|not available)$/i.test(String(v).trim())
    ? ""
    : String(v).trim();
export function number(v: unknown): number | null {
  const s = text(v).replace(/[$,\s]/g, "");
  const n = Number(s);
  return s && Number.isFinite(n) && n >= 0 ? n : null;
}
export function day(v: unknown): string {
  if (!text(v)) return "";
  const s = String(v).trim();
  // Validate calendar parts before Date can silently roll February 30 into March.
  const m =
    typeof v === "string" &&
    (s.match(/^(\d{4})-(\d{2})-(\d{2})/) ||
      (() => {
        const x = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        return x && [x[0], x[3], x[1], x[2]];
      })());
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (
      d.getUTCFullYear() !== +m[1] ||
      d.getUTCMonth() !== +m[2] - 1 ||
      d.getUTCDate() !== +m[3]
    )
      return "";
    if (!/(Z|[+-]\d\d:?\d\d)$/i.test(s)) return d.toISOString().slice(0, 10);
  }
  const d = new Date(
    typeof v === "number"
      ? v
      : /^\d{4}-\d\d-\d\dT/.test(s) && !/(Z|[+-]\d\d:?\d\d)$/i.test(s)
        ? s + "Z"
        : s,
  );
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
}
export function addressKey(value: string): string {
  const words: Record<string, string> = {
    NORTH: "N",
    SOUTH: "S",
    EAST: "E",
    WEST: "W",
    MOUNT: "MT",
    STREET: "ST",
    AVENUE: "AVE",
    ROAD: "RD",
    DRIVE: "DR",
    BOULEVARD: "BLVD",
    LANE: "LN",
    COURT: "CT",
    APARTMENT: "UNIT",
    APT: "UNIT",
    SUITE: "UNIT",
  };
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9# /-]/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => words[w] || w)
    .join(" ");
}
export function stage(
  status: string,
  issued: string,
  closed: string,
  fallback: string,
): string {
  if (/cancel|withdraw|void|denied/i.test(status)) return "Cancelled";
  if (/expir/i.test(status)) return "Expired";
  if (closed || /\b(final(ed)?|closed|complete[d]?)\b/i.test(status))
    return "Completed";
  if (/inspect|work started|in progress/i.test(status)) return "In progress";
  if (issued || /issued|permit ready/i.test(status)) return "Issued";
  if (/review|plan\s*check|pending|approved/i.test(status)) return "In review";
  return fallback;
}
export function coordinate(v: unknown, limit: number): number | null {
  if (v == null || text(v) === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}
export function normalize(
  raw: Raw,
  sourceId: string,
  referenceDate = today(),
): Permit {
  const s = SOURCES[sourceId];
  if (!s) throw Error("Unknown source");
  const r = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k.toLowerCase().trim(), v]),
  );
  const get = (...names: string[]) =>
    names
      .map((n) => text(r[n]))
      .find((v, i) => v && v.toLowerCase() !== names[i]) || "";
  const join = (...names: string[]) =>
    names
      .map((n) => get(n))
      .filter(Boolean)
      .join(" · ");
  const date = (...names: string[]) => day(get(...names));
  const base = {
    permit_number: "",
    project_ref: "",
    address: "",
    zip: "",
    apn: "",
    description: "",
    permit_type: "",
    property_type: "",
    applied_date: "",
    issue_date: "",
    completed_date: "",
    activity_date: "",
    raw_status: "",
    contractor: "",
    contractor_phone: "",
    permit_holder: "",
    owner: "",
    latitude: null,
    longitude: null,
    source_id: sourceId,
    jurisdiction: s.jurisdiction,
    city: s.city,
    state: s.state,
    source_url: s.page,
    value: null,
    sqft: null,
  } as Permit;
  const set = (v: Partial<Permit>) => Object.assign(base, v);
  switch (s.jurisdiction) {
    case "los-angeles":
      set({
        permit_number: get("permit_nbr"),
        address: get("primary_address"),
        zip: get("zip_code").slice(0, 5),
        apn: get("apn"),
        description: get("work_desc"),
        permit_type: join("permit_type", "permit_sub_type"),
        property_type: get("use_desc"),
        applied_date: date("submitted_date"),
        issue_date: date("issue_date"),
        completed_date: date("cofo_date"),
        activity_date: date("status_date"),
        raw_status: get("status_desc"),
        value: number(get("valuation")),
        sqft: number(get("square_footage")),
        latitude: coordinate(get("lat"), 90),
        longitude: coordinate(get("lon"), 180),
      });
      break;
    case "austin":
      set({
        permit_number: get("permit_number"),
        project_ref: get("masterpermitnum") || get("project_id"),
        address: get("original_address1", "permit_location"),
        zip: get("original_zip").slice(0, 5),
        apn: get("tcad_id"),
        description: get("description"),
        permit_type: join("permit_type_desc", "work_class"),
        property_type: get("permit_class_mapped", "permit_class"),
        applied_date: date("applieddate"),
        issue_date: date("issue_date"),
        completed_date: date("completed_date"),
        activity_date: date("statusdate"),
        raw_status: get("status_current"),
        value: number(get("total_job_valuation")),
        sqft: number(get("total_existing_bldg_sqft")),
        contractor: get("contractor_company_name", "contractor_full_name"),
        contractor_phone: get("contractor_phone"),
        latitude: coordinate(get("latitude"), 90),
        longitude: coordinate(get("longitude"), 180),
      });
      break;
    case "fort-worth":
      set({
        permit_number: get("permit_no"),
        address:
          get("full_street_address") ||
          [
            "addr_no",
            "direction",
            "street_name",
            "street_suffix",
            "street_suffix_dir",
          ]
            .map((n) => get(n))
            .filter(Boolean)
            .join(" "),
        zip: get("zip_code").slice(0, 5),
        description: get("b1_work_desc", "b1_special_text"),
        permit_type: join("permit_type", "permit_subtype"),
        property_type: get("use_type", "permit_category"),
        applied_date: day(r.file_date),
        activity_date: day(r.status_date),
        raw_status: get("current_status"),
        value: number(get("jobvalue")),
        sqft: number(get("sqft")),
        owner: get("owner_full_name"),
      });
      if (/issued/i.test(base.raw_status)) base.issue_date = base.activity_date;
      break;
    case "san-diego":
      set({
        permit_number: get("approval_id"),
        project_ref: get("project_id"),
        address: get("gis_address").split(",")[0],
        zip: get("gis_address").match(/\bCA\s+(\d{5})/)?.[1] || "",
        apn: get("gis_apn"),
        description: get("approval_scope", "project_scope"),
        permit_type: get("approval_type"),
        property_type: get("job_bc_code_description"),
        applied_date: date("approval_create_date"),
        issue_date: date("approval_issue_date"),
        completed_date: date("approval_close_date"),
        raw_status: get("approval_status"),
        value: number(get("approval_valuation")),
        sqft: number(get("approval_floor_area")),
        permit_holder: get("approval_permit_holder"),
        latitude: coordinate(get("gis_latitude"), 90),
        longitude: coordinate(get("gis_longitude"), 180),
      });
      break;
    case "san-francisco": {
      const loc = r.location as { coordinates?: unknown[] } | undefined;
      const coords = loc?.coordinates || [];
      const unit =
        (get("unit") === "0" ? "" : get("unit")) + get("unit_suffix");
      set({
        permit_number: get("permit_number"),
        address:
          [
            "street_number",
            "street_number_suffix",
            "street_name",
            "street_suffix",
          ]
            .map((n) => get(n))
            .filter(Boolean)
            .join(" ") + (unit ? " Unit " + unit : ""),
        zip: get("zipcode").slice(0, 5),
        apn: ["block", "lot"]
          .map((n) => get(n))
          .filter(Boolean)
          .join("-"),
        description: get("description"),
        permit_type: get("permit_type_definition"),
        property_type: get("proposed_use", "existing_use"),
        applied_date: date("filed_date", "permit_creation_date"),
        issue_date: date("issued_date"),
        completed_date: date("completed_date"),
        activity_date: [date("status_date"), date("last_permit_activity_date")]
          .sort()
          .at(-1)!,
        raw_status: get("status"),
        value: number(get("revised_cost", "estimated_cost")),
        latitude: coordinate(coords[1], 90),
        longitude: coordinate(coords[0], 180),
      });
      break;
    }
    case "charleston":
      set({
        permit_number: get("permit_number"),
        address: get("permit_address_line1", "parceladdr_line1"),
        zip:
          get("zipcode").slice(0, 5) ||
          get("permit_address_line2", "parceladdr_line2").match(
            /\bSC\s+(\d{5})/,
          )?.[1] ||
          "",
        apn: get("main_parcel_number"),
        description: get("description"),
        permit_type: join("permit_type", "work_class"),
        applied_date: day(r.application_date),
        issue_date: day(r.issue_date),
        completed_date: day(r.finaled_date),
        activity_date: day(r.last_inspection_date),
        raw_status: get("permit_status"),
        value: number(get("valuation")),
        sqft: number(get("square_feet")),
      });
      break;
    case "sacramento":
      set({
        permit_number: get("application"),
        address: get("address"),
        zip: get("zip").slice(0, 5),
        apn: get("parcel_no"),
        description: get("work_desc"),
        permit_type: join("type", "sub_type"),
        property_type: get("category"),
        issue_date: date("status_date"),
        raw_status: get("current_status"),
        value: number(get("valuation")),
        sqft: number(get("project_sq_ft")),
        contractor: get("contractor"),
      });
      break;
    case "west-sacramento":
      set({
        permit_number: get("permit"),
        address: get("address").split(/\s+WEST SACRAMENTO\s+/i)[0],
        zip: get("address").match(/\bCA\s+(\d{5})/)?.[1] || "",
        apn: get("parcel"),
        permit_type: join("type", "subtype"),
        applied_date: day(r.dateapplied),
        activity_date: day(r.statusdate),
        raw_status: get("status"),
        value: number(get("jobvalue")),
      });
      if (/issued/i.test(base.raw_status)) base.issue_date = base.activity_date;
      break;
    case "pasadena":
      set({
        permit_number: get("case_number"),
        address: get("address"),
        apn: get("parcel_no", "land_parcel_no"),
        description: get("description"),
        activity_date: day(r.latest_activity),
        sqft: number(get("total_sqft")),
        raw_status: "Active (source layer)",
      });
      break;
    case "san-jose":
      set({
        permit_number: get("foldernumber"),
        address: get("gx_location").split(",")[0].trim(),
        zip: get("gx_location").match(/\bCA\s+(\d{5})/)?.[1] || "",
        apn: get("assessors_parcel_number"),
        description: get("foldername"),
        permit_type: join("folderdesc", "workdescription"),
        property_type: get("subtypedescription"),
        issue_date: date("issuedate"),
        completed_date: date("finaldate"),
        raw_status: sourceId === "sj-expired" ? "Expired" : get("status"),
        value: number(get("permitvaluation")),
        sqft: number(get("squarefootage")),
        contractor: get("contractor"),
        owner: get("ownername"),
      });
      break;
    default:
      throw Error("No normalizer for " + sourceId);
  }
  if (!base.permit_number)
    throw Error("Missing permit identifier; inspect " + sourceId + " schema");
  if (["0", "0.0"].includes(base.project_ref)) base.project_ref = "";
  base.stage = stage(
    base.raw_status,
    base.issue_date,
    base.completed_date,
    s.default_stage,
  );
  base.activity_date = [
    base.activity_date,
    base.issue_date,
    base.applied_date,
    base.completed_date,
  ]
    .sort()
    .at(-1)!;
  base.signal_date = base.issue_date || base.applied_date || base.activity_date;
  base.signal_date_kind = base.issue_date
    ? "Issued"
    : base.applied_date
      ? "Applied"
      : "Last activity";
  base.date_warning = base.activity_date > referenceDate;
  base.address_key = addressKey(base.address);
  base.project_key = `${s.jurisdiction}:${base.project_ref ? "project:" + base.project_ref : "permit:" + base.permit_number}`;
  return base;
}
export function classify(
  description: string,
  permitType = "",
): Record<string, Match> {
  const content = `${description} ${permitType}`
    .toLowerCase()
    .replace(
      /\b(?:no|not|without)\s+(?:new\s+)?(?:roof(?:ing)?|tile|plumbing|electrical)(?:\s+work)?/g,
      "",
    )
    .replace(/\b(?:roof[- ]?top|roof[- ]mounted|roof mount(?:ed)?)\b/g, "")
    .replace(/\broof\s+(?:deck|railing|hatch|access)\b/g, "deck");
  const matches: Record<string, Match> = {};
  for (const [name, pattern] of Object.entries(RULES)) {
    const m = (
      name === "Tile"
        ? content.replace(/\broof tiles?\b|\btile roofs?\b/g, "")
        : content
    ).match(new RegExp(pattern, "i"));
    if (m) matches[name] = { kind: "Direct", evidence: m[0], confidence: 90 };
  }
  if (
    !matches.Roofing &&
    /tear off\s*[-:]\s*yes.{0,100}\bsquares of (?:composite|shingle)/s.test(
      content,
    )
  )
    matches.Roofing = {
      kind: "Direct",
      evidence: "Tear off with roofing squares of composite/shingle",
      confidence: 90,
    };
  if (
    matches.Solar &&
    matches.Roofing &&
    !/re[- ]?roof|shingle|roof(?:ing)?\s+(?:repair|replac)|(?:repair|replace)\s+(?:the\s+)?roof/.test(
      content,
    )
  )
    delete matches.Roofing;
  if (
    matches.Roofing &&
    matches.Tile &&
    !/bath|kitchen|floor|backsplash|shower/.test(content)
  )
    delete matches.Tile;
  if (
    !matches.Tile &&
    /(?:kitchen|bathroom|shower).{0,30}(?:remodel|renovat)|(?:remodel|renovat).{0,30}(?:kitchen|bathroom|shower)/.test(
      content,
    )
  )
    matches.Tile = {
      kind: "Adjacent",
      evidence: "Kitchen / bath remodel; tile scope unconfirmed",
      confidence: 55,
    };
  if (matches["New construction"])
    for (const name of ["Roofing", "Tile"])
      matches[name] ??= {
        kind: "Adjacent",
        evidence: "New construction; trade package unconfirmed",
        confidence: 50,
      };
  return matches;
}
export function score(
  p: Permit,
  m: Match,
  date = today(),
): [number, Record<string, number>] {
  const age = (Date.parse(date) - Date.parse(p.signal_date)) / 86400000;
  const parts: Record<string, number> = {
    Recency:
      age >= 0 && age <= 3
        ? 30
        : age >= 0 && age <= 7
          ? 22
          : age >= 0 && age <= 30
            ? 14
            : age >= 0 && age <= 90
              ? 5
              : 0,
    Stage:
      (
        {
          Application: 25,
          "In review": 22,
          Issued: 12,
          "In progress": 5,
        } as Record<string, number>
      )[p.stage] || 0,
    "Trade evidence": m.kind === "Direct" ? 25 : 10,
    Address: p.address ? 10 : 0,
    Valuation: (p.value || 0) >= 10000 ? 10 : (p.value || 0) > 0 ? 5 : 0,
  };
  if (p.contractor) parts["Contractor already listed"] = -20;
  if (p.permit_holder) parts["Permit holder listed"] = -10;
  return [
    Math.max(
      0,
      Math.min(
        TERMINAL.has(p.stage) ? 10 : p.date_warning || age < 0 ? 25 : 100,
        Object.values(parts).reduce((a, b) => a + b, 0),
      ),
    ),
    parts,
  ];
}
export function digest(value: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, stable(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
