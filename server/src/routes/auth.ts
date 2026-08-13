import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import {
  AUTH_COOKIE,
  TOKEN_TTL_SECONDS,
  hashPassword,
  signToken,
  verifyPassword,
} from "../lib/auth.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { validateBody } from "../middleware/validate.js";
import { loginSchema, registerSchema } from "../schemas/auth.js";

export const authRouter = Router();

const isProduction = process.env.NODE_ENV === "production";

/**
 * httpOnly so JavaScript (and therefore any XSS) can't read the token.
 * sameSite=lax blocks it from being sent on cross-site form posts, which is
 * what makes CSRF a non-issue here without a separate token. `secure` only
 * in production, since local dev is plain HTTP.
 */
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: isProduction,
  maxAge: TOKEN_TTL_SECONDS * 1000,
  path: "/",
} as const;

/** Never leak the password hash to a client. */
function publicUser(row: typeof users.$inferSelect) {
  return { id: row.id, email: row.email, name: row.name, createdAt: row.createdAt };
}

/**
 * Whether anyone may create an account.
 *
 * Open by default, because that is what a local dev instance needs. Set
 * ALLOW_REGISTRATION=false before exposing the app through a tunnel or any
 * public URL: signup is otherwise the one endpoint a stranger can reach
 * without credentials, and an account there can add websites and start
 * crawls that run on your machine.
 */
function registrationOpen(): boolean {
  return process.env.ALLOW_REGISTRATION?.trim().toLowerCase() !== "false";
}

authRouter.post("/register", validateBody(registerSchema), async (req, res) => {
  if (!registrationOpen()) {
    res.status(403).json({
      error: "registration_closed",
      message: "New accounts are disabled on this instance.",
    });
    return;
  }

  const { email, password, name } = req.body as { email: string; password: string; name?: string };
  const normalizedEmail = email.trim().toLowerCase();

  const existing = await db.select().from(users).where(eq(users.email, normalizedEmail));
  if (existing.length > 0) {
    res.status(409).json({ error: "email_taken" });
    return;
  }

  const [user] = await db
    .insert(users)
    .values({ email: normalizedEmail, name: name?.trim() || null, passwordHash: await hashPassword(password) })
    .returning();

  res.cookie(AUTH_COOKIE, signToken(user.id), cookieOptions);
  res.status(201).json({ user: publicUser(user) });
});

authRouter.post("/login", validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));

  // Same generic response whether the email is unknown or the password is
  // wrong -- distinguishing them would let an attacker enumerate accounts.
  // The hash is still verified against a dummy when the user is missing so
  // the two paths take comparable time.
  const ok = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, `${"0".repeat(32)}:${"0".repeat(128)}`);

  if (!user || !ok) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }

  res.cookie(AUTH_COOKIE, signToken(user.id), cookieOptions);
  res.json({ user: publicUser(user) });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(AUTH_COOKIE, { ...cookieOptions, maxAge: undefined });
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, req.userId as string));
  if (!user) {
    // Token is valid but the account is gone (deleted). Clear the stale cookie.
    res.clearCookie(AUTH_COOKIE, { ...cookieOptions, maxAge: undefined });
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json({ user: publicUser(user) });
});
