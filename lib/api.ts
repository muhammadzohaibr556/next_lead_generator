import { z } from "zod";
import { pool, transaction, type DB } from "./db";
import { findLeads, leadQuery, leadDict, LEAD_SELECT, mapLeads } from "./leads";
import { SOURCES, RULES, number, digest } from "./engine";
import { queueSource } from "./ingest";
import {
  enrichmentDetails,
  queueEnrichment,
  queueEnrichmentInTransaction,
  reviewOwner,
} from "./enrichment";
import {
  filterSchema,
  leadUpdate,
  reviewUpdate,
  HttpError,
  id,
  type Filters,
} from "./validation";
import { jsonRequest, PARCEL } from "./sources";
import { externalSecurity, security } from "./security";
import {
  externalLeadDetail,
  externalFindLeads,
  externalLeadQuerySchema,
} from "./external-api";
export async function leadDetail(leadId: number, connection: DB = pool()) {
  const db = connection,
    row = (
      await db.query(`SELECT * FROM (${LEAD_SELECT}) lead_view WHERE id=$1`, [
        leadId,
      ])
    ).rows[0];
  if (!row) throw new HttpError(404, "Lead not found");
  const item = leadDict(row);
  const permits = (
    await db.query("SELECT * FROM permits WHERE project_key=$1", [
      row.project_key,
    ])
  ).rows;
  const evidence = (
    await db.query(
      "SELECT id,permit_id,source_id,fetched_at FROM raw_events WHERE permit_id=ANY($1::integer[]) ORDER BY id DESC",
      [permits.map((p) => p.id)],
    )
  ).rows;
  const property =
    item.jurisdiction === "los-angeles"
      ? (
          await db.query("SELECT * FROM property_enrichment WHERE apn=$1", [
            item.apn.replace(/\D/g, ""),
          ])
        ).rows[0]
      : null;
  const related = (
    await db.query(
      "SELECT id,trade,stage FROM leads WHERE id<>$1 AND active AND city=$2 AND state=$3 AND payload->>'address_key'=$4 AND payload->>'address_key'<>'' LIMIT 12",
      [leadId, item.city, item.state, item.address_key],
    )
  ).rows;
  return {
    ...item,
    permits: permits.map((p) => ({
      ...p.payload,
      first_seen: p.first_seen,
      last_seen: p.last_seen,
      evidence: evidence.filter((e) => e.permit_id === p.id),
    })),
    property: property
      ? { ...property.payload, fetched_at: property.fetched_at }
      : null,
    related,
    enrichment: await enrichmentDetails(db, item),
  };
}
export async function stats(f: Filters) {
  const db = pool(),
    q = leadQuery(f),
    tradesQuery = leadQuery({ ...f, trade: "" }),
    states = f.state
      ? [f.state]
      : f.territory === "target"
        ? ["CA", "SC"]
        : ["CA", "SC", "TX"];
  const values = (
    await db.query(
      `SELECT count(*)::integer total,count(*) FILTER(WHERE computed_score>=75)::integer high_priority,count(*) FILTER(WHERE signal_date BETWEEN (current_date-6)::text AND current_date::text)::integer recent FROM (${q.sql}) filtered`,
      q.args,
    )
  ).rows[0] as { total: number; high_priority: number; recent: number };
  const trades = (
    await db.query(
      `SELECT trade,count(*)::integer total FROM (${tradesQuery.sql}) filtered GROUP BY trade ORDER BY total DESC`,
      tradesQuery.args,
    )
  ).rows;
  const markets = (
    await db.query(
      `SELECT city,state,count(*)::integer total FROM (${q.sql}) filtered GROUP BY city,state ORDER BY total DESC`,
      q.args,
    )
  ).rows as { city: string; state: string; total: number }[];
  const saved = (
    await db.query(
      "SELECT count(*)::integer n FROM leads WHERE saved AND state=ANY($1::text[])",
      [states],
    )
  ).rows[0].n;
  const permits = (
    await db.query(
      "SELECT count(*)::integer n FROM permits WHERE payload->>'state'=ANY($1::text[])",
      [states],
    )
  ).rows[0].n;
  const last_sync = (
    await db.query("SELECT max(last_success) value FROM sources")
  ).rows[0].value;
  return {
    ...values,
    roofing: trades.find((t) => t.trade === "Roofing")?.total || 0,
    tile: trades.find((t) => t.trade === "Tile")?.total || 0,
    permits,
    saved,
    markets,
    trades,
    trend: [],
    last_sync,
    categories: Object.keys(RULES),
    scope: f.scope,
  };
}
export async function sourceStatus() {
  const db = pool(),
    states = (await db.query("SELECT * FROM sources")).rows;
  return {
    items: Object.entries(SOURCES).map(([id, source]) => ({
      ...source,
      ...states.find((s) => s.id === id),
      id,
    })),
    runs: (await db.query("SELECT * FROM runs ORDER BY id DESC LIMIT 30")).rows,
    automatic_sync: process.env.AUTO_SYNC !== "0",
  };
}
export async function coverage() {
  const db = pool(),
    states = (await db.query("SELECT * FROM sources")).rows,
    counts = (
      await db.query(
        "SELECT jurisdiction,count(*)::integer total FROM permits GROUP BY jurisdiction",
      )
    ).rows;
  return {
    states: [
      ["CA", "California"],
      ["SC", "South Carolina"],
      ["TX", "Texas"],
    ].map(([state, name]) => {
      const jurisdictions = [
        ...new Set(
          Object.values(SOURCES)
            .filter((s) => s.state === state)
            .map((s) => s.jurisdiction),
        ),
      ].map((jurisdiction) => {
        const sources = Object.entries(SOURCES).filter(
          ([, s]) => s.jurisdiction === jurisdiction,
        );
        return {
          name: sources[0][1].city,
          permits:
            counts.find((c) => c.jurisdiction === jurisdiction)?.total || 0,
          feeds: sources.map(([id]) => {
            const s = states.find((s) => s.id === id);
            return {
              id,
              last_success: s?.last_success || null,
              error: s?.error || null,
              newest_record: s?.newest_record || null,
            };
          }),
        };
      });
      return {
        state,
        name,
        complete: false,
        jurisdictions,
        permits: jurisdictions.reduce((n, j) => n + j.permits, 0),
      };
    }),
    message:
      "Partial jurisdiction coverage. Other cities and unincorporated county areas are unconnected. A statewide filter is not proof of complete coverage.",
  };
}
export const csvSafe = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /^[=+\-@\t\r\n]/.test(s.trimStart()) || /^[\t\r\n]/.test(s)
    ? "'" + s
    : s;
};
async function exportLeads(f: Filters) {
  const data = await findLeads(f, 10001, 0);
  if (data.total > 10000)
    throw new HttpError(
      422,
      "Narrow your filters to 10,000 leads or fewer before exporting",
    );
  const fields = [
    "id",
    "trade",
    "score",
    "address",
    "city",
    "state",
    "zip",
    "apn",
    "description",
    "stage",
    "signal_date",
    "value",
    "contractor",
    "contractor_phone",
    "permit_holder",
    "owner",
    "status",
    "assigned_to",
    "notes",
    "source_url",
  ] as const;
  const cell = (v: unknown) => '"' + csvSafe(v).replace(/"/g, '""') + '"';
  return new Response(
    "\ufeff" +
      [
        fields.join(","),
        ...data.items.map((row) => fields.map((k) => cell(row[k])).join(",")),
      ].join("\r\n") +
      "\r\n",
    {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="permit-atlas-leads.csv"',
      },
    },
  );
}
async function enrichProperty(leadId: number) {
  const lead = await leadDetail(leadId),
    apn = lead.apn.replace(/\D/g, "");
  if (lead.jurisdiction !== "los-angeles" || apn.length !== 10)
    throw new HttpError(
      422,
      "Exact parcel enrichment supports Los Angeles permits with a 10-digit APN",
    );
  if (
    lead.property &&
    Date.now() - Date.parse(lead.property.fetched_at) < 30 * 86400000
  )
    return lead.property;
  try {
    const data = await jsonRequest(PARCEL + "/query", {
      f: "json",
      where: `AIN='${apn}'`,
      outFields:
        "AIN,APN,SitusFullAddress,UseType,UseDescription,YearBuilt1,SQFTmain1,Units1,Bedrooms1,Bathrooms1,Roll_Year,Roll_LandValue,Roll_ImpValue",
      returnGeometry: false,
      resultRecordCount: 2,
    });
    if (!Array.isArray(data.features) || data.features.length !== 1)
      throw new HttpError(
        404,
        "No unique parcel match; property details were not guessed",
      );
    const p = data.features[0].attributes;
    if (String(p.AIN).replace(/\D/g, "") !== apn)
      throw new HttpError(404, "Parcel identifier mismatch");
    const land = number(p.Roll_LandValue),
      improvement = number(p.Roll_ImpValue);
    const result = {
      apn: p.AIN,
      address: p.SitusFullAddress,
      use: p.UseDescription || p.UseType,
      year_built: p.YearBuilt1,
      building_sqft: p.SQFTmain1,
      units: p.Units1,
      bedrooms: p.Bedrooms1,
      bathrooms: p.Bathrooms1,
      roll_year: p.Roll_Year,
      assessed_value:
        land !== null && improvement !== null ? land + improvement : null,
      source_url: PARCEL,
      match_method: "Exact county AIN",
      owner_contact: "Not provided by this parcel API",
    };
    const row = (
      await pool().query(
        "INSERT INTO property_enrichment(apn,payload) VALUES($1,$2) ON CONFLICT(apn) DO UPDATE SET fetched_at=now(),payload=excluded.payload RETURNING fetched_at",
        [apn, JSON.stringify(result)],
      )
    ).rows[0];
    return { ...result, fetched_at: row.fetched_at };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, "County parcel service unavailable");
  }
}
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "JSON body required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) {
        await reader.cancel();
        throw new HttpError(413, "Request body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
function externalError(e: unknown) {
  if (e instanceof z.ZodError)
    return Response.json(
      {
        code: "INVALID_REQUEST",
        detail: e.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  if (e instanceof HttpError)
    return Response.json(
      { code: e.status === 404 ? "NOT_FOUND" : "INVALID_REQUEST", detail: e.message },
      { status: e.status, headers: { "Cache-Control": "no-store" } },
    );
  console.error("External API operation failed:", e instanceof Error ? e.name : "Error");
  return Response.json(
    { code: "SERVICE_UNAVAILABLE", detail: "The external API could not complete this request." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
async function handleExternalApi(
  request: Request,
  url: URL,
  path: string[],
) {
  const denied = externalSecurity(request);
  if (denied) return denied;
  try {
    if (request.method === "GET" && path.length === 2 && path[1] === "health") {
      await pool().query("SELECT 1");
      return Response.json(
        { status: "ok", api_version: "v1" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (request.method === "GET" && path.length === 2 && path[1] === "coverage")
      return Response.json(await coverage(), { headers: { "Cache-Control": "no-store" } });
    if (request.method === "GET" && path.length === 2 && path[1] === "leads") {
      const input = externalLeadQuerySchema.parse(
        Object.fromEntries([...url.searchParams].filter(([, value]) => value !== "")),
      );
      return Response.json(await externalFindLeads(input), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (request.method === "GET" && path.length === 3 && path[1] === "leads") {
      const leadId = id(path[2]);
      return Response.json(await externalLeadDetail(leadId), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (
      request.method === "GET" &&
      path.length === 4 &&
      path[1] === "leads" &&
      path[3] === "enrichment"
    ) {
      const lead = await leadDetail(id(path[2]));
      const enrichment = lead.enrichment;
      return Response.json(
        {
          lead_id: lead.id,
          owner: {
            available: Boolean(enrichment.owner),
            reviewed: enrichment.review.reviewed,
            type: enrichment.review.owner_type,
          },
          contacts: {
            available: Boolean(enrichment.contacts),
            verified: enrichment.review.contacts_verified,
            suppressed: enrichment.review.suppressed,
          },
          jobs: enrichment.jobs,
          providers: enrichment.providers,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (
      request.method === "POST" &&
      path.length === 4 &&
      path[1] === "leads" &&
      path[3] === "enrich"
    ) {
      const key = request.headers.get("idempotency-key")?.trim() || "";
      if (!key || key.length > 200)
        throw new HttpError(422, "Idempotency-Key header is required");
      const input = z
        .object({ kind: z.enum(["owner", "contacts"]) })
        .strict()
        .parse(await body(request));
      const leadId = id(path[2]);
      const result = await transaction(async (db) => {
        const requestHash = digest({ endpoint: request.url, input });
        const existing = (
          await db.query(
            "SELECT request_hash,response_status,response FROM external_api_idempotency WHERE idempotency_key=$1 FOR UPDATE",
            [key],
          )
        ).rows[0];
        if (existing) {
          if (existing.request_hash !== requestHash)
            throw new HttpError(409, "Idempotency-Key was already used for another request");
          return {
            body: existing.response || { status: "pending", idempotency_key: key },
            status: existing.response_status || 202,
          };
        }
        await db.query(
          "INSERT INTO external_api_idempotency(idempotency_key,request_hash) VALUES($1,$2)",
          [key, requestHash],
        );
        const lead = await leadDetail(leadId, db);
        const queued = await queueEnrichmentInTransaction(db, lead, input.kind);
        const response = { ...queued, idempotency_key: key };
        const status = ["queued", "running"].includes(queued.status) ? 202 : 200;
        await db.query(
          "UPDATE external_api_idempotency SET response_status=$1,response=$2 WHERE idempotency_key=$3",
          [status, JSON.stringify(response), key],
        );
        return { body: response, status };
      });
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (
      request.method === "GET" &&
      path.length === 3 &&
      path[1] === "enrichment-jobs"
    ) {
      const job = (
        await pool().query(
          "SELECT id,lead_id,kind,status,queued_at,finished_at,message FROM enrichment_jobs WHERE id=$1",
          [id(path[2])],
        )
      ).rows[0];
      if (!job) throw new HttpError(404, "Enrichment job not found");
      return Response.json(job, { headers: { "Cache-Control": "no-store" } });
    }
    throw new HttpError(404, "Endpoint not found");
  } catch (e) {
    return externalError(e);
  }
}
export async function handleApi(request: Request) {
  const url = new URL(request.url),
    path = url.pathname
      .replace(/^\/api\/?/, "")
      .split("/")
      .filter(Boolean);
  if (path[0] === "v1") return handleExternalApi(request, url, path);
  const denied = security(request);
  if (denied) return denied;
  try {
    const method = request.method;
    const filters = () =>
      filterSchema.parse(
        Object.fromEntries([...url.searchParams].filter(([, v]) => v !== "")),
      );
    let result: unknown;
    let status = 200;
    if (method === "GET" && path.length === 1) {
      switch (path[0]) {
        case "health":
          await pool().query("SELECT 1");
          result = {
            status: "ok",
            automatic_sync: process.env.AUTO_SYNC !== "0",
          };
          break;
        case "leads":
          result = await findLeads(filters());
          break;
        case "stats":
          result = await stats(filters());
          break;
        case "sources":
          result = await sourceStatus();
          break;
        case "coverage":
          result = await coverage();
          break;
      }
    }
    if (path[0] === "leads") {
      if (method === "GET" && path.length === 2) {
        if (path[1] === "map") result = await mapLeads(filters());
        else if (path[1] === "export") return await exportLeads(filters());
        else result = await leadDetail(id(path[1]));
      }
      if (method === "PATCH" && path.length === 2) {
        const leadId = id(path[1]),
          changes = leadUpdate.parse(await body(request));
        if (
          !(await pool().query("SELECT 1 FROM leads WHERE id=$1", [leadId]))
            .rowCount
        )
          throw new HttpError(404, "Lead not found");
        const entries = Object.entries(changes);
        if (entries.length)
          await pool().query(
            "UPDATE leads SET " +
              entries.map(([k], i) => `${k}=$${i + 1}`).join(",") +
              ` WHERE id=$${entries.length + 1}`,
            [...entries.map(([, v]) => v), leadId],
          );
        result = { ok: true };
      }
      if (method === "POST" && path.length === 3 && path[2] === "enrich") {
        const kind = z
          .enum(["property", "owner", "contacts"])
          .parse(url.searchParams.get("kind") || "property");
        z.object({})
          .strict()
          .parse(await body(request));
        if (kind === "property") result = await enrichProperty(id(path[1]));
        else {
          const queued = await queueEnrichment(
            await leadDetail(id(path[1])),
            kind,
          );
          status = ["queued", "running"].includes(queued.status) ? 202 : 200;
          result = queued;
        }
      }
      if (
        method === "PATCH" &&
        path.length === 3 &&
        path[2] === "enrichment-review"
      )
        result = await reviewOwner(
          await leadDetail(id(path[1])),
          reviewUpdate.parse(await body(request)),
        );
    }
    if (method === "GET" && path[0] === "evidence" && path.length === 2) {
      result = (
        await pool().query("SELECT * FROM raw_events WHERE id=$1", [
          id(path[1]),
        ])
      ).rows[0];
      if (!result) throw new HttpError(404, "Evidence not found");
    }
    if (method === "PATCH" && path[0] === "sources" && path.length === 2) {
      if (!SOURCES[path[1]]) throw new HttpError(404, "Unknown source");
      const update = z
        .object({ enabled: z.boolean() })
        .strict()
        .parse(await body(request));
      await pool().query("UPDATE sources SET enabled=$1 WHERE id=$2", [
        update.enabled,
        path[1],
      ]);
      result = { ok: true };
    }
    if (method === "POST" && path[0] === "sync" && path.length === 1) {
      const input = z
        .object({ source_id: z.string().optional() })
        .strict()
        .parse(await body(request));
      if (input.source_id && !SOURCES[input.source_id])
        throw new HttpError(404, "Unknown source");
      const ids = input.source_id
        ? [input.source_id]
        : (await pool().query("SELECT id FROM sources WHERE enabled")).rows.map(
            (s) => s.id,
          );
      const runs = [];
      for (const source of ids) runs.push(await queueSource(source));
      result = { run_ids: runs, message: "Sync queued" };
      status = 202;
    }
    if (result === undefined) throw new HttpError(404, "Endpoint not found");
    return Response.json(result, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    if (e instanceof z.ZodError)
      return Response.json(
        {
          detail: e.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        { status: 422 },
      );
    if (e instanceof HttpError)
      return Response.json({ detail: e.message }, { status: e.status });
    // Do not expose SQL, connection URLs, credentials, or upstream personal data.
    console.error(
      "API operation failed:",
      e instanceof Error ? e.name : "Error",
    );
    return Response.json(
      {
        detail:
          "The server could not complete this request. Check database configuration and migrations.",
      },
      { status: 503 },
    );
  }
}
