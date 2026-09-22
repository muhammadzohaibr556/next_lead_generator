import "./env";
import { pool, transaction } from "../lib/db";
import { SOURCES, today } from "../lib/engine";
import { batches, sleep } from "../lib/sources";
import { ingestBatch, queueSource } from "../lib/ingest";
import { runEnrichmentOne } from "../lib/enrichment";
import { geocodeOne } from "../lib/geo";
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
export async function runSource(run: { id: number; source_id: string }) {
  const db = pool(),
    state = (
      await db.query("SELECT * FROM sources WHERE id=$1", [run.source_id])
    ).rows[0],
    started = new Date().toISOString();
  await db.query("UPDATE sources SET last_started=$1,error=NULL WHERE id=$2", [
    started,
    run.source_id,
  ]);
  let newest =
    state.newest_record && state.newest_record <= today()
      ? state.newest_record
      : "";
  try {
    for await (const rows of batches(run.source_id, state)) {
      if (stopping) throw Error("Worker stopping; next run will safely replay");
      const batch = await ingestBatch(run.source_id, rows);
      if (batch.newest > newest) newest = batch.newest;
      await db.query(
        "UPDATE runs SET fetched=fetched+$1,new_permits=new_permits+$2,changed=changed+$3,duplicates=duplicates+$4,leads_created=leads_created+$5 WHERE id=$6",
        [...Object.values(batch.counts), run.id],
      );
    }
    await transaction(async (tx) => {
      await tx.query(
        "UPDATE sources SET last_success=$1,newest_record=$2,error=NULL,next_run=now()+$3*interval '1 second' WHERE id=$4",
        [
          started,
          newest || null,
          SOURCES[run.source_id].interval,
          run.source_id,
        ],
      );
      await tx.query(
        "UPDATE runs SET status='success',finished_at=now() WHERE id=$1",
        [run.id],
      );
    });
    console.log("Imported", run.source_id);
  } catch (e) {
    const error =
      e instanceof Error ? e.message.slice(0, 300) : "Import failed";
    await transaction(async (tx) => {
      await tx.query(
        "UPDATE sources SET error=$1,next_run=now()+interval '15 minutes' WHERE id=$2",
        [error, run.source_id],
      );
      await tx.query(
        "UPDATE runs SET status='failed',error=$1,finished_at=now() WHERE id=$2",
        [error, run.id],
      );
    });
    console.error("Import failed:", run.source_id, error);
  }
}
export async function recoverJobs() {
  await transaction(async (db) => {
    await db.query(
      "UPDATE enrichment_jobs SET status='uncertain',finished_at=now(),message='Interrupted request; trial units retained. Review provider usage before requesting again.' WHERE status='running'",
    );
    const interrupted = (
      await db.query(
        "UPDATE runs SET status='failed',finished_at=now(),error='Interrupted by restart; safe replay queued' WHERE status='running' RETURNING source_id",
      )
    ).rows;
    for (const row of interrupted) await queueSource(row.source_id, db);
  });
}
async function main() {
  if (process.env.DISABLE_WORKER === "1") {
    console.log("Worker disabled");
    return;
  }
  const lock = await pool().connect();
  // ponytail: one worker per database; replace this lock with job leases when parallel imports are needed.
  lock.on("error", () => {
    console.error("Worker database lock lost; stopping immediately.");
    process.exit(1);
  });
  const acquired = (
    await lock.query("SELECT pg_try_advisory_lock(724191,1) acquired")
  ).rows[0].acquired;
  if (!acquired) {
    lock.release();
    throw Error(
      "Another worker or reclassification already holds the database lock",
    );
  }
  try {
    await recoverJobs();
    console.log("Permit Atlas TypeScript worker ready.");
    while (!stopping) {
      try {
        const enriched = await runEnrichmentOne();
        if (stopping) break;
        if (process.env.AUTO_SYNC !== "0")
          for (const row of (
            await pool().query(
              "SELECT id FROM sources WHERE enabled AND (next_run IS NULL OR next_run<=now())",
            )
          ).rows)
            await queueSource(row.id);
        const run = await transaction(async (db) => {
          const row = (
            await db.query(
              "SELECT id,source_id FROM runs WHERE status='queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
            )
          ).rows[0];
          if (row)
            await db.query(
              "UPDATE runs SET status='running',started_at=now() WHERE id=$1",
              [row.id],
            );
          return row;
        });
        if (run) {
          await runSource(run);
          continue;
        }
        if (process.env.GEOCODING_ENABLED !== "0" && (await geocodeOne()))
          continue;
        if (enriched) continue;
      } catch {
        console.error("Worker iteration failed; retrying in 10 seconds.");
      }
      for (let i = 0; i < 10 && !stopping; i++) await sleep(1000);
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock(724191,1)");
    lock.release();
  }
}
if (process.argv[1]?.endsWith("worker.ts"))
  main()
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => pool().end());
