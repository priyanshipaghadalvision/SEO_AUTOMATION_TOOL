import type { ErrorRequestHandler } from "express";
import { InvalidUrlError } from "../lib/url.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof InvalidUrlError) {
    res.status(400).json({ error: "invalid_url", message: err.message });
    return;
  }
  // A malformed JSON body is the client's mistake, not a server fault --
  // express.json() throws a SyntaxError with a `body` property, which would
  // otherwise fall through to the 500 below and hide a simple bad request.
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "invalid_json", message: "Request body is not valid JSON." });
    return;
  }

  // Written synchronously to stderr: a piped stdout can buffer (and on
  // Windows, block) long enough that a crash-causing error never appears in
  // the log at all -- which is exactly when you most need to see it.
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[error] ${detail}\n`);
  res.status(500).json({ error: "internal_error", message: "Something went wrong." });
};
