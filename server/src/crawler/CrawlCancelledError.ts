/**
 * Thrown by runCrawl when a user cancels the crawl mid-flight.
 *
 * Distinct from a normal failure so the worker can tell the two apart: the
 * cancel endpoint has already written status=CANCELLED, so the worker must
 * NOT overwrite that with COMPLETED or FAILED.
 */
export class CrawlCancelledError extends Error {
  constructor(message = "Crawl cancelled by user") {
    super(message);
    this.name = "CrawlCancelledError";
  }
}
