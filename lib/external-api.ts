import { z } from "zod";
import { pool, type DB } from "./db";
import { today } from "./engine";
import { enrichmentDetails } from "./enrichment";
import { leadDict, leadQuery, LEAD_SELECT } from "./leads";
import { HttpError, filterSchema, stages, type Filters } from "./validation";
import type { Lead } from "./types";

const stageValues = ["", ...stages] as [string, ...string[]];
const cursorSchema = z.object({
  sort: z.enum(["score", "newest", "value"]),
  score: z.number().optional(),
  signal_date: z.string().optional(),
  value: z.number().nullable().optional(),
  id: z.number().int().positive(),
});
export type ExternalCursor = z.infer<typeof cursorSchema>;

export const externalLeadQuerySchema = z
  .object({
    state: z.enum(["CA", "SC", "TX", ""]).default(""),
    city: z.string().max(80).default(""),
    zip: z.string().regex(/^(\d{5})?$/).default(""),
    latitude: z.coerce.number().min(-90).max(90).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
    radius_miles: z.coerce
      .number()
      .refine((value) => [5, 10, 25, 50, 100].includes(value))
      .optional(),
    age_days: z.coerce.number().int().min(1).max(3650).default(7),
    trade: z.string().max(40).default(""),
    stage: z.enum(stageValues).default(""),
    minimum_score: z.coerce.number().int().min(0).max(100).default(0),
    sort: z.enum(["score", "newest", "value"]).default("score"),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(40),
  })
  .refine(
    (input) =>
      [input.latitude, input.longitude, input.radius_miles].filter(
        (value) => value !== undefined,
      ).length === 0 ||
      [input.latitude, input.longitude, input.radius_miles].every(
        (value) => value !== undefined,
      ),
    { message: "Provide latitude, longitude and radius_miles together" },
  );
export type ExternalLeadQuery = z.infer<typeof externalLeadQuerySchema>;

function dateForAge(ageDays: number) {
  const date = new Date(Date.parse(today()) - (ageDays - 1) * 86400000);
  return date.toISOString().slice(0, 10);
}

export function toExternalFilters(input: ExternalLeadQuery): Filters {
  return filterSchema.parse({
    scope: "external",
    state: input.state,
    city: input.city,
    zip: input.zip,
    center_lat: input.latitude,
    center_lon: input.longitude,
    radius_miles: input.radius_miles,
    since: dateForAge(input.age_days),
    trade: input.trade,
    stage: input.stage,
    min_score: input.minimum_score,
    sort: input.sort,
    limit: input.limit,
    offset: 0,
    q: "",
    territory: "all",
    status: "",
    kind: "",
    saved: "false",
    include_closed: "false",
  });
}

export function encodeCursor(cursor: ExternalCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string): ExternalCursor {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new HttpError(422, "Invalid cursor");
  }
}

type EnrichmentView = {
  review?: { reviewed?: boolean };
  contacts?: {
    candidates?: { email?: string; phone?: string }[];
  } | null;
};

export function normalizeExternalLead(lead: Lead, enrichment?: EnrichmentView) {
  const firstContact = enrichment?.contacts?.candidates?.[0];
  return {
    id: lead.id,
    version: `${lead.id}:${lead.updated_at}`,
    address: {
      line1: lead.address,
      city: lead.city,
      state: lead.state,
      postalCode: lead.zip,
      latitude: lead.latitude,
      longitude: lead.longitude,
    },
    permit: {
      number: lead.permit_number,
      jurisdiction: lead.jurisdiction,
      description: lead.description,
      signalDate: lead.signal_date,
      stage: lead.stage,
    },
    classification: {
      trade: lead.trade,
      score: lead.score,
      reasons: lead.focus_reasons,
    },
    owner: {
      name: lead.owner || null,
      confidence: null,
      reviewed: enrichment?.review?.reviewed === true,
    },
    contacts: {
      email: firstContact?.email || null,
      phone: firstContact?.phone || null,
      confidence: null,
      suppressed: false,
    },
    updatedAt: lead.updated_at,
  };
}

function orderFor(sort: ExternalLeadQuery["sort"]) {
  return {
    score: "computed_score DESC,signal_date DESC,id DESC",
    newest: "signal_date DESC,id DESC",
    value: "(payload->>'value')::double precision DESC NULLS LAST,id DESC",
  }[sort];
}

function cursorForRow(row: Record<string, any>, sort: ExternalLeadQuery["sort"]): ExternalCursor {
  const payload = row.payload as Record<string, unknown>;
  if (sort === "score")
    return {
      sort,
      score: Number(row.computed_score),
      signal_date: String(row.signal_date),
      id: Number(row.id),
    };
  if (sort === "newest")
    return { sort, signal_date: String(row.signal_date), id: Number(row.id) };
  const value = payload.value == null || payload.value === "" ? null : Number(payload.value);
  return { sort, value: Number.isFinite(value) ? value : null, id: Number(row.id) };
}

function cursorClause(
  cursor: ExternalCursor,
  sort: ExternalLeadQuery["sort"],
  start: number,
) {
  if (cursor.sort !== sort) throw new HttpError(422, "Cursor sort does not match sort parameter");
  if (sort === "score")
    return {
      sql: `(computed_score,signal_date,id)<($${start},$${start + 1},$${start + 2})`,
      args: [cursor.score, cursor.signal_date, cursor.id],
    };
  if (sort === "newest")
    return {
      sql: `(signal_date,id)<($${start},$${start + 1})`,
      args: [cursor.signal_date, cursor.id],
    };
  const value = "(payload->>'value')::double precision";
  if (cursor.value === null)
    return { sql: `${value} IS NULL AND id<$${start}`, args: [cursor.id] };
  return {
    sql: `(${value} IS NULL OR ${value}<$${start} OR (${value}=$${start} AND id<$${start + 1}))`,
    args: [cursor.value, cursor.id],
  };
}

export async function externalFindLeads(
  input: ExternalLeadQuery,
  db: DB = pool(),
) {
  const filters = toExternalFilters(input);
  const base = leadQuery(filters);
  const total = (
    await db.query(`SELECT count(*)::integer total FROM (${base.sql}) filtered`, base.args)
  ).rows[0].total as number;
  let sql = `SELECT * FROM (${base.sql}) filtered`;
  let args = [...base.args];
  if (input.cursor) {
    const cursor = cursorClause(decodeCursor(input.cursor), input.sort, args.length + 1);
    sql += ` WHERE ${cursor.sql}`;
    args = [...args, ...cursor.args];
  }
  const rows = (
    await db.query(
      `${sql} ORDER BY ${orderFor(input.sort)} LIMIT $${args.length + 1}`,
      [...args, input.limit + 1],
    )
  ).rows;
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  return {
    items: page.map((row) => normalizeExternalLead(leadDict(row))),
    next_cursor: hasMore ? encodeCursor(cursorForRow(page[page.length - 1], input.sort)) : null,
    has_more: hasMore,
    total,
    limit: input.limit,
  };
}

export async function externalLeadDetail(leadId: number, db: DB = pool()) {
  const row = (
    await db.query(`SELECT * FROM (${LEAD_SELECT}) lead_view WHERE id=$1`, [leadId])
  ).rows[0];
  if (!row) throw new HttpError(404, "Lead not found");
  const lead = leadDict(row);
  const enrichment = await enrichmentDetails(db, lead);
  return normalizeExternalLead(lead, enrichment);
}
