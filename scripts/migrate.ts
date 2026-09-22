import "./env";
import { readFile, readdir } from "node:fs/promises";
import { pool, transaction } from "../lib/db";
import { SOURCES, digest } from "../lib/engine";
export async function migrate() {
  await transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(724191,0)");
    await db.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = await readFile("migrations/" + file, "utf8"),
        checksum = digest(sql);
      const previous = (
        await db.query("SELECT checksum FROM schema_migrations WHERE name=$1", [
          file,
        ])
      ).rows[0];
      if (previous) {
        if (previous.checksum !== checksum)
          throw Error("Applied migration changed: " + file);
        continue;
      }
      await db.query(sql);
      await db.query(
        "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
        [file, checksum],
      );
    }
    const days = Number(process.env.INITIAL_LOOKBACK_DAYS || 30);
    if (!Number.isInteger(days) || days < 1 || days > 36500)
      throw Error(
        "INITIAL_LOOKBACK_DAYS must be an integer between 1 and 36500",
      );
    for (const id of Object.keys(SOURCES))
      await db.query(
        "INSERT INTO sources(id,coverage_since) VALUES($1,current_date-$2::integer) ON CONFLICT DO NOTHING",
        [id, days],
      );
  });
}
if (process.argv[1]?.endsWith("migrate.ts"))
  migrate()
    .then(() =>
      console.log("PostgreSQL schema ready; no SQLite data imported."),
    )
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => pool().end());
