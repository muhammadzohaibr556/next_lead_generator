import "./env";
import { pool, transaction } from "../lib/db";
import { refreshProject } from "../lib/ingest";
transaction(async (db) => {
  const locked = (
    await db.query("SELECT pg_try_advisory_xact_lock(724191,1) acquired")
  ).rows[0].acquired;
  if (!locked) throw Error("Stop the worker before reclassifying");
  for (const row of (await db.query("SELECT project_key FROM projects")).rows)
    await refreshProject(db, row.project_key);
})
  .then(() =>
    console.log("Trade matches refreshed; saved leads and notes preserved."),
  )
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
