/**
 * Marks this process as the crawl worker, before anything else loads.
 *
 * `db/client.ts` reads PROCESS_ROLE at module-evaluation time to decide how
 * many connections to claim, and ES module imports are evaluated in source
 * order -- so this has to be the *first* import in worker.ts, ahead of even
 * `dotenv/config`, or the pool is already built by the time it runs.
 *
 * A file rather than an npm-script env prefix (`PROCESS_ROLE=worker tsx ...`)
 * because that syntax is a shell feature: it works in bash and fails silently
 * on Windows cmd.exe, which is where this project runs.
 */
process.env.PROCESS_ROLE = "worker";

/**
 * Keep Crawlee's request queue in memory instead of on disk.
 *
 * Two reasons, and the first is that disk persistence buys this app nothing:
 * a queue is never resumed. `recoverOrphanedCrawls` deliberately drops and
 * recreates the queue for any crawl it picks up, because resumed queues were
 * found to hang. So every byte written to `.crawlee-storage` is written, then
 * deleted, and never read.
 *
 * The second is that it was actively breaking crawls on Windows. Crawlee's
 * file storage takes a lock by `mkdir`-ing a `<file>.json.lock` directory.
 * Windows marks a directory "delete-pending" while any handle to it remains
 * open, and a `mkdir` inside a delete-pending directory fails with EPERM --
 * not ENOENT or EEXIST. With six `queue.drop()` call sites, a drop racing a
 * lock acquisition produced exactly:
 *
 *   EPERM: operation not permitted, mkdir '...\<id>\<key>.json.lock'
 *
 * In-memory storage has no lock files, so the failure mode cannot occur. It
 * also removes a disk write per request, which is load the crawl was putting
 * on the same machine serving the UI.
 *
 * Set CRAWLEE_PERSIST_STORAGE=true to opt back into on-disk queues.
 */
process.env.CRAWLEE_PERSIST_STORAGE ??= "false";
