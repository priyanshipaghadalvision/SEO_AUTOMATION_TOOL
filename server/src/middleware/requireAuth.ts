import type { NextFunction, Request, Response } from "express";
import { AUTH_COOKIE, verifyToken } from "../lib/auth.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth; guaranteed present on any route behind it. */
      userId?: string;
    }
  }
}

/**
 * Rejects any request without a valid session.
 *
 * Applied at the router level rather than per-route on purpose: mounting it
 * once in front of the whole API means a newly added endpoint is protected
 * by default. Forgetting to add auth to a new route is the classic way an
 * unprotected endpoint reaches production.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = (req.cookies as Record<string, string> | undefined)?.[AUTH_COOKIE];
  const userId = verifyToken(token);

  if (!userId) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  req.userId = userId;
  next();
}
