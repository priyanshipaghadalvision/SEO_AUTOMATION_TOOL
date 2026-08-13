import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env at the project root.");
}

/**
 * Connection limits, sized for two processes sharing one database.
 *
 * The API and the crawl worker each build their own pool, so the real ceiling
 * is double whatever is set here. Left at the driver's default of 10 apiece
 * that is 20 connections competing while a crawl writes -- enough that a
 * burst of page inserts can leave an interactive request waiting on a free
 * connection, which is exactly the "UI is slow while crawling" symptom.
 *
 * The worker is given the smaller share deliberately: a crawl finishing a
 * few seconds later costs nothing, whereas a page load stalling behind it is
 * immediately visible.
 */
const isWorker = process.env.PROCESS_ROLE === "worker";
const MAX_CONNECTIONS = Number(process.env.DB_POOL_MAX) || (isWorker ? 6 : 12);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: MAX_CONNECTIONS,
  // Return idle connections instead of pinning them for the process lifetime.
  idleTimeoutMillis: 30_000,
  // Fail fast rather than queueing forever behind a saturated pool -- a clear
  // error beats a request that hangs until the browser gives up.
  connectionTimeoutMillis: 10_000,
  /**
   * A hard ceiling on any single statement.
   *
   * Without it one accidental sequential scan can hold a connection for
   * minutes and starve every other request. Analysis reads are the heaviest
   * thing here and complete in seconds, so 60s is generous while still
   * catching genuine runaways.
   */
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 60_000,
});

pool.on("error", (err) => {
  // An idle client erroring (network blip, database restart) must not take
  // the process down -- pg re-establishes on next checkout.
  console.error("[db] idle client error:", err.message);
});

export const db = drizzle(pool, { schema });
