import { pool, transaction, type DB } from "./db";
import { classify, normalize, digest, score, TERMINAL, today } from "./engine";
import { syncLocation } from "./geo";
import type { Permit, LeadPayload, Raw } from "./types";
export async function refreshProject(db: DB, projectKey: string) {
  const permits: Permit[] = (
    await db.query("SELECT payload FROM permits WHERE project_key=$1", [
      projectKey,
    ])
  ).rows.map((r) => r.payload);
  const groups = new Map<
    string,
    { permit: Permit; match: ReturnType<typeof classify>[string] }[]
  >();
  for (const permit of permits)
    for (const [trade, match] of Object.entries(
      classify(permit.description, permit.permit_type),
    )) {
      const candidates = groups.get(trade) || [];
      candidates.push({ permit, match });
      groups.set(trade, candidates);
    }
  let created = 0;
  await db.query("UPDATE leads SET active=false WHERE project_key=$1", [
    projectKey,
  ]);
  for (const [trade, candidates] of groups) {
    candidates.sort(
      (a, b) =>
        Number(!TERMINAL.has(b.permit.stage)) -
          Number(!TERMINAL.has(a.permit.stage)) ||
        b.permit.activity_date.localeCompare(a.permit.activity_date) ||
        Number(b.match.kind === "Direct") - Number(a.match.kind === "Direct"),
    );
    const { permit, match } = candidates[0],
      parts = score(permit, match)[1];
    const payload: LeadPayload = {
      ...permit,
      match,
      permit_count: permits.length,
      trade_permit_count: candidates.length,
      score_base: Object.entries(parts)
        .filter(([k]) => k !== "Recency")
        .reduce((n, [, v]) => n + v, 0),
      grouping: permit.project_ref
        ? "Official project reference"
        : "Permit identity · related jobs require review",
    };
    const existing = (
      await db.query("SELECT id FROM leads WHERE project_key=$1 AND trade=$2", [
        projectKey,
        trade,
      ])
    ).rows[0];
    const row = (
      await db.query(
        `INSERT INTO leads(project_key,trade,payload) VALUES($1,$2,$3) ON CONFLICT(project_key,trade) DO UPDATE SET active=true,payload=excluded.payload,updated_at=CASE WHEN leads.payload<>excluded.payload THEN now() ELSE leads.updated_at END RETURNING id`,
        [projectKey, trade, JSON.stringify(payload)],
      )
    ).rows[0];
    if (!existing) created++;
    await syncLocation(db, row.id, payload);
  }
  return created;
}
export async function ingestBatch(sourceId: string, rows: Raw[]) {
  return transaction(async (db) => {
    const counts = {
        fetched: rows.length,
        new_permits: 0,
        changed: 0,
        duplicates: 0,
        leads_created: 0,
      },
      touched = new Set<string>();
    let newest = "";
    for (const raw of rows) {
      const permit = normalize(raw, sourceId);
      for (const key of [
        "activity_date",
        "issue_date",
        "applied_date",
        "completed_date",
      ] as const)
        if (permit[key] <= today() && permit[key] > newest)
          newest = permit[key];
      const canonical = digest(
        Object.fromEntries(
          Object.entries(permit).filter(
            ([k]) => !["source_id", "source_url"].includes(k),
          ),
        ),
      );
      const old = (
        await db.query(
          "SELECT * FROM permits WHERE jurisdiction=$1 AND permit_number=$2 FOR UPDATE",
          [permit.jurisdiction, permit.permit_number],
        )
      ).rows[0];
      let permitId: number;
      if (old) {
        permitId = old.id;
        const prior = old.payload as Permit;
        const rank: Record<string, number> = {
          Application: 0,
          "In review": 1,
          "Active · stage unknown": 1,
          Issued: 2,
          "In progress": 3,
          Completed: 4,
          Expired: 4,
          Cancelled: 4,
        };
        if (
          canonical !== old.payload_hash &&
          (permit.activity_date > prior.activity_date ||
            (permit.activity_date === prior.activity_date &&
              rank[permit.stage] >= rank[prior.stage]))
        ) {
          permit.project_key = old.project_key;
          await db.query(
            "UPDATE permits SET payload=$1,payload_hash=$2,last_seen=now() WHERE id=$3",
            [JSON.stringify(permit), canonical, permitId],
          );
          touched.add(old.project_key);
          counts.changed++;
        } else {
          await db.query("UPDATE permits SET last_seen=now() WHERE id=$1", [
            permitId,
          ]);
          counts.duplicates++;
        }
      } else {
        await db.query(
          "INSERT INTO projects(project_key) VALUES($1) ON CONFLICT DO NOTHING",
          [permit.project_key],
        );
        permitId = (
          await db.query(
            "INSERT INTO permits(jurisdiction,permit_number,project_key,payload,payload_hash) VALUES($1,$2,$3,$4,$5) RETURNING id",
            [
              permit.jurisdiction,
              permit.permit_number,
              permit.project_key,
              JSON.stringify(permit),
              canonical,
            ],
          )
        ).rows[0].id;
        touched.add(permit.project_key);
        counts.new_permits++;
      }
      const stable = Object.fromEntries(
        Object.entries(raw).filter(
          ([k]) =>
            ![
              ":id",
              ":updated_at",
              ":created_at",
              "refresh_time",
              "objectid",
            ].includes(k.toLowerCase()),
        ),
      );
      await db.query(
        "INSERT INTO raw_events(source_id,permit_id,payload_hash,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [sourceId, permitId, digest(stable), JSON.stringify(raw)],
      );
    }
    for (const project of touched)
      counts.leads_created += await refreshProject(db, project);
    return { counts, newest };
  });
}
export async function queueSource(
  sourceId: string,
  db: DB = pool(),
): Promise<number> {
  const result = await db.query(
    "INSERT INTO runs(source_id) VALUES($1) ON CONFLICT(source_id) WHERE status IN ('queued','running') DO UPDATE SET source_id=excluded.source_id RETURNING id",
    [sourceId],
  );
  return result.rows[0].id;
}
