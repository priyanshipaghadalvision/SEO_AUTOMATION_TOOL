import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { authRouter } from "./routes/auth.js";
import { websitesRouter } from "./routes/websites.js";
import { crawlsRouter } from "./routes/crawls.js";
import { gscPublicRouter, gscRouter } from "./routes/gsc.js";
import { requireAuth } from "./middleware/requireAuth.js";
import { errorHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();

  // credentials:true is required for the browser to send the session cookie.
  // The origin is pinned rather than "*" -- the two are mutually exclusive
  // for credentialed requests, and a wildcard would let any site call the
  // API with the user's cookie attached.
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.use("/api/auth", authRouter);

  // Google's OAuth redirect lands here as a top-level browser navigation, so
  // it cannot depend on the session cookie being attached -- the signed
  // `state` parameter carries the user identity instead. Mounted before the
  // authenticated router so the more specific path wins.
  app.use("/api/gsc", gscPublicRouter);

  // Everything below requires a session. Mounted as router-level middleware
  // so any future endpoint added to these routers is protected by default.
  app.use("/api/websites", requireAuth, websitesRouter);
  app.use("/api/crawls", requireAuth, crawlsRouter);
  app.use("/api/gsc", requireAuth, gscRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use(errorHandler);

  return app;
}
