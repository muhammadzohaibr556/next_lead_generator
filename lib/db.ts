import { Pool, types, type PoolClient } from "pg";
// Keep date-only fields and UTC timestamps stable across server/browser time zones.
types.setTypeParser(1082, (value) => value);
types.setTypeParser(1184, (value) => new Date(value).toISOString());
const globalPg = globalThis as unknown as { permitPool?: Pool };
export function pool(): Pool {
  if (!process.env.DATABASE_URL)
    throw Error(
      "DATABASE_URL is required. See .env.example and run npm run db:migrate.",
    );
  return (globalPg.permitPool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 30000,
    options: "-c timezone=UTC",
  }));
}
export type DB = Pool | PoolClient;
export async function transaction<T>(
  work: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool().connect();
  try {
    await db.query("BEGIN");
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
// Serialize review, dispatch and result publication so suppression cannot race a request.
export async function enrichmentLock(db: DB) {
  await db.query("SELECT pg_advisory_xact_lock(724191,2)");
}
