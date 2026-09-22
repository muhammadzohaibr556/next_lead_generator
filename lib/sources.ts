import { Readable, Transform } from "node:stream";
import { parse } from "csv-parse";
import { SOURCES, day } from "./engine";
import type { Raw } from "./types";
export const PARCEL =
  "https://cache.gis.lacounty.gov/cache/rest/services/LACounty_Cache/LACounty_Parcel/FeatureServer/0";
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export async function publicRequest(
  url: string,
  params: Record<string, string | number | boolean> = {},
  socrata = false,
): Promise<Response> {
  const target = new URL(url);
  for (const [k, v] of Object.entries(params))
    target.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const headers: Record<string, string> = {
        "User-Agent": "PermitAtlas/2.0 (municipal public-data research)",
      };
      if (socrata && process.env.SOCRATA_APP_TOKEN)
        headers["X-App-Token"] = process.env.SOCRATA_APP_TOKEN;
      const response = await fetch(target, {
        headers,
        signal: AbortSignal.timeout(60000),
        cache: "no-store",
        redirect: socrata ? "error" : "follow",
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel();
        const delay = response.headers.get("retry-after") || "";
        await sleep(
          /^\d+$/.test(delay)
            ? Math.min(+delay, 30) * 1000
            : 2 ** attempt * 1000,
        );
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw Error("Public source HTTP " + response.status);
      }
      return response;
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(2 ** attempt * 1000);
    }
  }
  throw Error("Public source unavailable");
}
export async function jsonRequest(
  url: string,
  params: Record<string, string | number | boolean> = {},
  socrata = false,
) {
  const data = await (await publicRequest(url, params, socrata)).json();
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (data.error || data.errorCode)
  )
    throw Error("Upstream API returned an error");
  return data;
}
export function filterDates(
  rows: Raw[],
  columns: string[],
  coverage: string,
): Raw[] {
  return rows.filter((row) => {
    const r = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k.toLowerCase().trim(), v]),
    );
    if (columns.some((c) => !(c in r)))
      throw Error("Date columns missing; inspect source schema");
    return columns.some((c) => day(r[c]) >= coverage);
  });
}
export async function* batches(
  sourceId: string,
  state: { coverage_since: string; last_success: string | null },
): AsyncGenerator<Raw[]> {
  const s = SOURCES[sourceId],
    coverage = state.coverage_since.slice(0, 10);
  if (s.kind === "socrata") {
    let where =
      "(" +
      s.dates!.map((c) => `${c} >= '${coverage}T00:00:00'`).join(" OR ") +
      ")";
    if (s.where) where += " AND (" + s.where + ")";
    if (state.last_success)
      where += ` AND :updated_at >= '${new Date(Date.parse(state.last_success) - 72 * 3600000).toISOString().replace(".000", "")}'`;
    for (let offset = 0; ;) {
      const rows = await jsonRequest(
        s.url,
        {
          $select: "*, :id, :updated_at",
          $where: where,
          $order: ":id",
          $limit: 1000,
          $offset: offset,
        },
        true,
      );
      if (!Array.isArray(rows)) throw Error("Expected a Socrata list");
      if (!rows.length) break;
      yield rows;
      offset += rows.length;
      if (rows.length < 1000) break;
    }
  } else if (s.kind === "arcgis") {
    const where =
      s.dates
        ?.map((c) => `${c} >= TIMESTAMP '${coverage} 00:00:00'`)
        .join(" OR ") || "1=1";
    for (let offset = 0; ;) {
      const data = await jsonRequest(s.url, {
        f: "json",
        where,
        outFields: "*",
        returnGeometry: false,
        orderByFields: (s.object_id || "OBJECTID") + " ASC",
        resultOffset: offset,
        resultRecordCount: 1000,
      });
      if (!Array.isArray(data.features))
        throw Error("ArcGIS response has no features");
      let rows: Raw[] = data.features.map(
        (f: { attributes: Raw }) => f.attributes,
      );
      const count = rows.length;
      if (!count && data.exceededTransferLimit)
        throw Error("ArcGIS pagination made no progress");
      if (s.client_dates) rows = filterDates(rows, s.client_dates, coverage);
      if (rows.length) yield rows;
      offset += count;
      if (!data.exceededTransferLimit) break;
    }
  } else {
    const urls = s.feed
      ? Array.from(
          {
            length:
              new Date().getUTCFullYear() - Number(coverage.slice(0, 4)) + 1,
          },
          (_, i) =>
            `${s.url}/approvals_${s.feed}_${Number(coverage.slice(0, 4)) + i}_datasd.csv`,
        )
      : [s.url];
    for (const url of urls) {
      const response = await publicRequest(url);
      if (!response.body) throw Error("Empty CSV response");
      let size = 0;
      const source = Readable.fromWeb(
        response.body as Parameters<typeof Readable.fromWeb>[0],
      );
      const limit = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          callback(
            size > 200_000_000 ? Error("Annual CSV exceeded 200 MB") : null,
            chunk,
          );
        },
      });
      const parser = parse({
        bom: true,
        columns: (headers: string[]) => {
          const names = headers.map((v) => v.toLowerCase().trim());
          const required = s.required || [
            "approval_id",
            "approval_create_date",
            "approval_issue_date",
          ];
          if (required.some((k) => !names.includes(k)))
            throw Error(sourceId + " CSV schema changed");
          return names;
        },
        skip_empty_lines: true,
        max_record_size: 2_000_000,
      });
      source.on("error", (e) => parser.destroy(e));
      limit.on("error", (e) => parser.destroy(e));
      source.pipe(limit).pipe(parser);
      let rows: Raw[] = [];
      try {
        for await (const row of parser) {
          if (
            filterDates(
              [row],
              s.dates || ["approval_create_date", "approval_issue_date"],
              coverage,
            ).length
          )
            rows.push(row);
          if (rows.length === 2000) {
            yield rows;
            rows = [];
          }
        }
        if (rows.length) yield rows;
      } finally {
        source.destroy();
        limit.destroy();
        parser.destroy();
      }
    }
  }
}
