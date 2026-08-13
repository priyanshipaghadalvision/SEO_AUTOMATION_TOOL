// MUST stay first -- see workerRole.ts for why the pool depends on it.
import "./workerRole.js";
import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { RequestQueue } from "crawlee";
import { and, eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { crawls, websites } from "./db/schema.js";
import type { CrawlRow, WebsiteRow } from "./crawler/runCrawl.js";
import { runCrawl } from "./crawler/runCrawl.js";
import { CrawlCancelledError } from "./crawler/CrawlCancelledError.js";
import { analyzeCrawl } from "./analysis/analyzeCrawl.js";
import { logAuditEvent } from "./lib/audit.js";

// Keep Crawlee's on-disk request-queue storage colocated with the backend,
// out of the way of the frontend/repo root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.CRAWLEE_STORAGE_DIR ??= path.join(__dirname, "../.crawlee-storage");

const POLL_INTERVAL_MS = 3000;
const RECOVERY_SWEEP_INTERVAL_MS = 60_000;
// How long the worker keeps waiting on a cancelled crawl to unwind on its
// own before giving up on it and moving to the next queued job.
const CANCEL_ABANDON_MS = 20_000;
const CANCEL_WATCH_INTERVAL_MS = 2000;
// Added on top of a crawl's own timeLimitMinutes before the worker gives up
// on it entirely. Only ever hit by a crawl that has stopped responding to
// its own internal limits.
const HARD_CEILING_GRACE_MS = 5 * 60_000;

// Arbitrary fixed key identifying "the crawl worker" for Postgres advisory
// locking. Only one worker process may hold it at a time.
const WORKER_SINGLETON_LOCK_KEY = 727_501;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enforces single-worker exclusivity via a Postgres session-level advisory
 * lock, held for this process's entire lifetime on a dedicated connection
 * (not the pool). This is what makes orphan-recovery on startup safe: if a
 * second worker process starts while this one is alive, it fails to acquire
 * the lock and exits immediately instead of racing with -- and incorrectly
 * "recovering" -- crawls this process is legitimately still running. If this
 * process crashes, Postgres releases the lock automatically when the
 * connection drops, so the next worker can take over cleanly.
 */
async function acquireSingletonLockOrExit(): Promise<void> {
  const lockClient = new Client({ connectionString: process.env.DATABASE_URL });
  await lockClient.connect();
  const { rows } = await lockClient.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1) AS acquired", [
    WORKER_SINGLETON_LOCK_KEY,
  ]);
  if (!rows[0]?.acquired) {
    console.error("[worker] another worker instance already holds the singleton lock -- exiting.");
    await lockClient.end();
    process.exit(1);
  }
  // Intentionally never closed: the lock must live for the whole process.
}

/**
 * Atomically claims the oldest QUEUED crawl job: locks the row inside a
 * transaction (FOR UPDATE SKIP LOCKED) so a future second worker instance
 * can never double-pick the same job, then transitions it to RUNNING before
 * releasing the lock.
 */
async function claimNextQueuedCrawl(): Promise<{ crawl: CrawlRow; website: WebsiteRow } | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(crawls)
      .where(eq(crawls.status, "QUEUED"))
      .orderBy(crawls.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });

    if (!row) return null;

    const [website] = await tx.select().from(websites).where(eq(websites.id, row.websiteId));
    if (!website) {
      await tx
        .update(crawls)
        .set({ status: "FAILED", failureReason: "website_not_found", finishedAt: new Date() })
        .where(eq(crawls.id, row.id));
      return null;
    }

    const [updated] = await tx
      .update(crawls)
      .set({ status: "RUNNING", startedAt: new Date() })
      .where(eq(crawls.id, row.id))
      .returning();

    return { crawl: updated, website };
  });
}

// The crawl this worker is actively inside runCrawl() for right now, if
// any. Since this process holds the singleton lock and processes crawls
// strictly one at a time, any OTHER crawl found RUNNING is guaranteed
// orphaned -- there is no way for it to be legitimately in progress
// anywhere else. This is what makes the periodic sweep below safe: it can
// never steal this worker's own in-flight crawl out from under it.
let currentlyProcessingCrawlId: string | null = null;

/**
 * Resets orphaned RUNNING crawls back to QUEUED so they get picked up again
 * instead of sitting stuck forever. Called once at startup (catching
 * whatever a previous worker process left behind when it crashed) and then
 * on a recurring timer for the rest of this process's life -- startup-only
 * recovery isn't enough: if this worker itself dies mid-crawl (crash, kill,
 * OOM) and something restarts it, the gap between crashes could otherwise
 * leave a crawl stuck in RUNNING indefinitely with nothing polling to notice.
 *
 * Deliberately drops the crawl's on-disk request queue rather than trying to
 * resume it. An earlier version tried to resume the same queue to avoid
 * re-doing work, but a queue whose previous run was killed mid-request can
 * be left in an inconsistent internal state that hangs indefinitely on
 * reopen -- observed live, more than once, and each time only a fresh queue
 * recovered reliably. A dropped queue means the re-run re-enqueues already
 * -seen URLs (Crawlee's own dedup no-ops on the homepage/sitemap reseed, and
 * the `pages` table's unique constraint silently no-ops duplicate inserts),
 * so real data is never duplicated -- the only cost is the in-memory `stats`
 * counters (already documented as best-effort/approximate) may slightly
 * over-count in this specific, rare recovery path. Reliability wins over
 * that small imprecision.
 */
async function recoverOrphanedCrawls(): Promise<void> {
  const running = await db.select().from(crawls).where(eq(crawls.status, "RUNNING"));
  for (const crawl of running) {
    if (crawl.id === currentlyProcessingCrawlId) continue;

    await RequestQueue.open(crawl.id)
      .then((queue) => queue.drop())
      .catch((err) => console.warn(`[worker] could not drop queue for recovered crawl ${crawl.id}:`, err));

    await db.update(crawls).set({ status: "QUEUED" }).where(eq(crawls.id, crawl.id));
    await logAuditEvent({
      entityType: "crawl",
      entityId: crawl.id,
      eventType: "crawl.recovered",
      metadata: { statsAtRecovery: crawl.stats },
    });
    console.log(`[worker] recovered orphaned crawl ${crawl.id} (was RUNNING, queue reset, will re-run)`);
  }
}

/**
 * Runs a crawl under supervision, and -- critically -- refuses to wait on it
 * forever. This is what guarantees the queue always keeps moving.
 *
 * runCrawl tries to stop itself when cancelled, but that only works while
 * it's inside crawler.run() with the abort plumbing armed. A crawl wedged in
 * its setup phase, or one whose event loop is blocked (a blocked stdout pipe
 * will do it), never returns and never runs its own timers. Observed live:
 * a single wedged crawl held the worker for 500+ seconds while queued crawls
 * behind it never started.
 *
 * Two independent escape hatches, both driven by timers in THIS function so
 * they don't depend on anything inside the crawl working correctly:
 *   - cancellation: user cancelled and the crawl didn't stop in time
 *   - hard ceiling: the crawl blew past its own configured time limit
 *
 * An abandoned crawl may keep running briefly in the background, but its row
 * is already terminal and every write it makes is keyed to that crawl id, so
 * it cannot corrupt the next job. A stuck worker is far worse than a
 * short-lived orphan task.
 */
async function runCrawlSupervised(website: WebsiteRow, crawl: CrawlRow): Promise<void> {
  let finished = false;
  let cancelSeenAt: number | null = null;
  // Generous multiple of the crawl's own limit: this is a last-resort
  // backstop for a wedged crawl, not a second time limit. A healthy crawl
  // enforces timeLimitMinutes itself, long before this fires.
  const hardCeilingMs = crawl.limits.timeLimitMinutes * 60_000 + HARD_CEILING_GRACE_MS;
  const startedAt = Date.now();

  const abandon = new Promise<never>((_, reject) => {
    const timer = setInterval(() => {
      if (finished) {
        clearInterval(timer);
        return;
      }

      if (Date.now() - startedAt > hardCeilingMs) {
        clearInterval(timer);
        reject(
          new Error(
            `Crawl exceeded its hard ceiling of ${Math.round(hardCeilingMs / 60_000)} min without finishing ` +
              `-- abandoned so the queue can continue.`,
          ),
        );
        return;
      }

      void db
        .select({ status: crawls.status })
        .from(crawls)
        .where(eq(crawls.id, crawl.id))
        .then(([row]) => {
          // No row at all means the website (and this crawl with it) was
          // deleted -- treated exactly like a cancellation.
          if (row && row.status !== "CANCELLED") return;
          if (cancelSeenAt === null) {
            cancelSeenAt = Date.now();
            return;
          }
          if (Date.now() - cancelSeenAt >= CANCEL_ABANDON_MS) {
            clearInterval(timer);
            reject(
              new CrawlCancelledError(
                `Cancelled by user; crawl did not stop within ${CANCEL_ABANDON_MS / 1000}s so the worker moved on.`,
              ),
            );
          }
        })
        .catch(() => {
          // A transient DB blip must not abandon a healthy crawl; the hard
          // ceiling above is still the ultimate backstop.
        });
    }, CANCEL_WATCH_INTERVAL_MS);
    timer.unref();
  });
  // The race below may never look at this promise (the normal path), and an
  // unobserved rejection would take the process down.
  abandon.catch(() => {});

  try {
    await Promise.race([runCrawl(website, crawl), abandon]);
  } finally {
    finished = true;
  }
}

let shuttingDown = false;

async function pollLoop() {
  while (!shuttingDown) {
    // Every iteration is wrapped: if ANY unexpected error escapes (a failed
    // audit write, a DB hiccup), the loop must keep going. An exception
    // thrown out of this while-loop would leave the process alive and
    // holding the singleton lock while silently processing nothing -- the
    // worst possible failure mode, since no other worker could take over.
    try {
      const claimed = await claimNextQueuedCrawl().catch((err) => {
        console.error("[worker] failed to claim next crawl:", err);
        return null;
      });

      if (!claimed) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      await processCrawl(claimed.website, claimed.crawl);
    } catch (err) {
      console.error("[worker] unexpected error in poll loop (continuing):", err);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function processCrawl(website: WebsiteRow, crawl: CrawlRow) {
  currentlyProcessingCrawlId = crawl.id;
  console.log(`[worker] starting crawl ${crawl.id} for ${website.domain}`);
  await logAuditEvent({ entityType: "crawl", entityId: crawl.id, eventType: "crawl.started" });

  try {
    await runCrawlSupervised(website, crawl);
    // Guarded on RUNNING: if the user cancelled in the narrow window
    // between the last cancellation poll and the crawl finishing, the row
    // is already CANCELLED and must not be resurrected as COMPLETED.
    const completed = await db
      .update(crawls)
      .set({ status: "COMPLETED", finishedAt: new Date() })
      .where(and(eq(crawls.id, crawl.id), eq(crawls.status, "RUNNING")))
      .returning({ id: crawls.id });

    if (completed.length > 0) {
      await logAuditEvent({ entityType: "crawl", entityId: crawl.id, eventType: "crawl.completed" });
      console.log(`[worker] completed crawl ${crawl.id}`);

      // Analysis runs only for crawls that finished normally, and its
      // failure must never turn a successful crawl into a failed one --
      // the page data is already safely stored and can be re-analysed.
      try {
        const result = await analyzeCrawl(crawl.id);
        await logAuditEvent({
          entityType: "crawl",
          entityId: crawl.id,
          eventType: "crawl.analyzed",
          metadata: result,
        });
        console.log(
          `[worker] analysed crawl ${crawl.id}: ${result.issuesFound} issue(s) ` +
            `(${result.bySeverity.critical} critical, ${result.bySeverity.warning} warning, ` +
            `${result.bySeverity.notice} notice)`,
        );
      } catch (err) {
        console.error(`[worker] analysis failed for crawl ${crawl.id} (crawl data is intact):`, err);
      }
    } else {
      console.log(`[worker] crawl ${crawl.id} finished but was already terminal (likely cancelled)`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // A user cancel already wrote status=CANCELLED (that's what stopped
    // the crawl in the first place) -- overwriting it with FAILED here
    // would misreport a deliberate stop as an error.
    if (err instanceof CrawlCancelledError) {
      console.log(`[worker] crawl ${crawl.id} cancelled: ${message}`);
    } else {
      // Also guarded on RUNNING so a crawl the user cancelled mid-failure
      // still reads as CANCELLED rather than FAILED.
      await db
        .update(crawls)
        .set({ status: "FAILED", finishedAt: new Date(), failureReason: message.slice(0, 500) })
        .where(and(eq(crawls.id, crawl.id), eq(crawls.status, "RUNNING")));
      await logAuditEvent({ entityType: "crawl", entityId: crawl.id, eventType: "crawl.failed", metadata: { error: message } });
      console.error(`[worker] crawl ${crawl.id} failed: ${message}`);
    }
  } finally {
    currentlyProcessingCrawlId = null;
  }
}

process.on("SIGINT", () => {
  console.log("[worker] shutting down after current job...");
  shuttingDown = true;
});
process.on("SIGTERM", () => {
  shuttingDown = true;
});

// A stray rejection from a background task (an abandoned crawl still winding
// down, say) must not take the whole worker with it -- Node's default for an
// unhandled rejection is to exit. Log it and keep serving the queue.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandled rejection (continuing):", reason);
});

// An uncaught exception leaves the process in an unknown state, so unlike
// the above this one does exit -- but deliberately and loudly. Postgres
// releases the advisory lock when the connection drops, so a supervisor (or
// you) can start a fresh worker that picks the queue straight back up.
process.on("uncaughtException", (err) => {
  console.error("[worker] FATAL uncaught exception -- exiting so a clean worker can take over:", err);
  process.exit(1);
});

console.log("[worker] crawl worker starting...");
await acquireSingletonLockOrExit();
console.log("[worker] singleton lock acquired");
await recoverOrphanedCrawls();

const recoverySweep = setInterval(() => {
  recoverOrphanedCrawls().catch((err) => console.error("[worker] recovery sweep failed:", err));
}, RECOVERY_SWEEP_INTERVAL_MS);
recoverySweep.unref();

console.log("[worker] polling for QUEUED jobs...");
pollLoop();
