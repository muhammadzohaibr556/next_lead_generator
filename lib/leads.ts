import { pool, type DB } from "./db";
import { score, today, TERMINAL } from "./engine";
import type { Lead, LeadPayload } from "./types";
import type { Filters } from "./validation";
export const SCORE_SQL = `least(CASE WHEN l.stage IN ('Completed','Cancelled','Expired') THEN 10 WHEN (l.payload->>'date_warning')::boolean OR l.signal_date>current_date::text THEN 25 ELSE 100 END,
 greatest(0,(l.payload->>'score_base')::integer + CASE
 WHEN current_date-nullif(l.signal_date,'')::date BETWEEN 0 AND 3 THEN 30
 WHEN current_date-nullif(l.signal_date,'')::date BETWEEN 0 AND 7 THEN 22
 WHEN current_date-nullif(l.signal_date,'')::date BETWEEN 0 AND 30 THEN 14
 WHEN current_date-nullif(l.signal_date,'')::date BETWEEN 0 AND 90 THEN 5 ELSE 0 END))`;
export const LEAD_SELECT = `SELECT l.*,${SCORE_SQL} computed_score,
 CASE WHEN g.expires_at IS NULL OR g.expires_at>now() THEN g.latitude END latitude,
 CASE WHEN g.expires_at IS NULL OR g.expires_at>now() THEN g.longitude END longitude,
 g.provider location_provider,g.match_method location_method,g.fetched_at location_fetched_at,
 CASE WHEN g.expires_at<=now() THEN 'pending' ELSE coalesce(g.status,'pending') END location_status,
 EXISTS(SELECT 1 FROM permits p WHERE p.project_key=l.project_key AND
 (trim(coalesce(p.payload->>'contractor',''))<>'' OR trim(coalesce(p.payload->>'permit_holder',''))<>'')) has_party
 FROM leads l LEFT JOIN lead_locations g ON g.lead_id=l.id`;
export const FOCUS_SQL = `active AND stage IN ('Application','In review') AND signal_date BETWEEN (current_date-6)::text AND current_date::text
 AND payload->'match'->>'kind'='Direct' AND trim(coalesce(payload->>'address',''))<>''
 AND NOT coalesce((payload->>'date_warning')::boolean,false) AND NOT has_party AND status NOT IN ('Sold','Dismissed')`;
export function leadQuery(f: Partial<Filters>, radius = true) {
  const args: unknown[] = [],
    clauses: string[] = [];
  const arg = (v: unknown) => {
    args.push(v);
    return "$" + args.length;
  };
  if ((f.scope || "prospecting") === "prospecting") clauses.push(FOCUS_SQL);
  if (!f.state && f.territory === "target")
    clauses.push("state IN ('CA','SC')");
  for (const key of ["trade", "state", "city", "stage", "status"] as const)
    if (f[key]) clauses.push(`${key}=${arg(f[key])}`);
  if (f.scope === "history" && !f.stage && !f.include_closed)
    clauses.push("stage NOT IN ('Completed','Cancelled','Expired')");
  if (f.saved) clauses.push("saved");
  if (f.q) {
    const p = arg("%" + f.q.replace(/[\\%_]/g, "\\$&") + "%");
    clauses.push(
      "(" +
        ["address", "description", "contractor", "permit_number"]
          .map((k) => `payload->>'${k}' ILIKE ${p}`)
          .join(" OR ") +
        ")",
    );
  }
  for (const [key, exp] of [
    ["zip", "payload->>'zip'="],
    ["since", "signal_date>="],
    ["min_value", "(payload->>'value')::double precision>="],
    ["min_score", "computed_score>="],
  ] as const)
    if (f[key] !== undefined && f[key] !== "") clauses.push(exp + arg(f[key]));
  if (f.kind) clauses.push("payload->'match'->>'kind'=" + arg(f.kind));
  if (radius && f.radius_miles !== undefined) {
    const lat = f.center_lat!,
      lon = f.center_lon!,
      miles = f.radius_miles,
      delta = ((miles / 3958.7613) * 180) / Math.PI;
    clauses.push(
      `latitude BETWEEN ${arg(Math.max(-90, lat - delta))} AND ${arg(Math.min(90, lat + delta))}`,
    );
    clauses.push(
      `distance_miles(latitude,longitude,${arg(lat)},${arg(lon)})<=${arg(miles)}`,
    );
  }
  return {
    sql: `SELECT * FROM (${LEAD_SELECT}) lead_view WHERE ${clauses.join(" AND ") || "true"}`,
    args,
  };
}
export function leadDict(row: Record<string, unknown>): Lead {
  const { payload, ...fields } = row;
  const p = payload as LeadPayload;
  const result = { ...p, ...fields } as unknown as Lead;
  [result.score, result.score_breakdown] = score(p, p.match);
  const reasons: string[] = [],
    date = today(),
    since = new Date(Date.parse(date) - 6 * 86400000)
      .toISOString()
      .slice(0, 10);
  if (!result.active) reasons.push("No longer an active trade match");
  if (!["Application", "In review"].includes(result.stage))
    reasons.push("Outside early permit stages");
  if (!(result.signal_date >= since && result.signal_date <= date))
    reasons.push("Outside the last 7 days");
  if (p.match.kind !== "Direct") reasons.push("Adjacent trade evidence");
  if (!p.address.trim()) reasons.push("Address not published");
  if (p.date_warning) reasons.push("Future source date");
  if (result.has_party)
    reasons.push("Contractor or permit holder listed on project");
  if (["Sold", "Dismissed"].includes(result.status))
    reasons.push("Sold or dismissed");
  result.focus_reasons = reasons;
  result.in_focus = !reasons.length;
  result.availability = result.in_focus
    ? "Potentially available · verification needed"
    : "Outside prospecting focus";
  return result;
}
export async function findLeads(
  f: Partial<Filters>,
  limit = f.limit || 40,
  offset = f.offset || 0,
  db: DB = pool(),
) {
  const { sql, args } = leadQuery(f);
  const order = {
    score: "computed_score DESC,signal_date DESC,id DESC",
    newest: "signal_date DESC,id DESC",
    value: "(payload->>'value')::double precision DESC NULLS LAST,id DESC",
  }[f.sort || "score"];
  const total = (
    await db.query(
      `SELECT count(*)::integer total FROM (${sql}) filtered`,
      args,
    )
  ).rows[0].total;
  const rows = (
    await db.query(
      `${sql} ORDER BY ${order} LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, limit, offset],
    )
  ).rows;
  return { items: rows.map(leadDict), total, limit, offset };
}
export async function mapLeads(f: Partial<Filters>) {
  const { sql, args } = leadQuery(f),
    before = leadQuery(f, false),
    db = pool();
  const counts = (
    await db.query(
      `SELECT count(*)::integer total,count(*) FILTER(WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::integer mapped,
 count(*) FILTER(WHERE latitude IS NULL AND location_status='pending')::integer pending,
 count(*) FILTER(WHERE latitude IS NULL AND location_status<>'pending')::integer unmapped FROM (${sql}) filtered`,
      args,
    )
  ).rows[0];
  const missing = f.radius_miles
    ? (
        await db.query(
          `SELECT count(*)::integer n FROM (${before.sql}) filtered WHERE latitude IS NULL OR longitude IS NULL`,
          before.args,
        )
      ).rows[0].n
    : 0;
  const points = (
    await db.query(
      `SELECT id,latitude,longitude,trade,stage,signal_date,computed_score score,payload->>'address' address,city,state,location_method FROM (${sql}) filtered WHERE latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY computed_score DESC,signal_date DESC,id DESC LIMIT 5000`,
      args,
    )
  ).rows;
  return {
    ...counts,
    points,
    excluded_unlocated: missing,
    truncated: counts.mapped > 5000,
  };
}
