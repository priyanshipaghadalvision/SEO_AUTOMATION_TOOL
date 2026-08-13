import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { gscConnections } from "../db/schema.js";
import { jwtSecret } from "../lib/auth.js";
import { decryptToken, encryptToken } from "./crypto.js";

/**
 * Google OAuth 2.0, implemented against the endpoints directly.
 *
 * The whole flow is two POSTs and a redirect URL, so pulling in `googleapis`
 * (~30MB for three endpoints) would cost far more than it saves. Everything
 * here uses `fetch` and the `jsonwebtoken` dependency the project already
 * has -- no new packages.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

/**
 * Read-only Search Console, plus the two identity scopes needed to show
 * *which* Google account is connected. Requesting only what we use keeps the
 * consent screen honest and small.
 */
export const GSC_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "openid",
  "email",
];

/** Refresh this many seconds before actual expiry, to absorb clock skew. */
const EXPIRY_SKEW_SECONDS = 60;
/** The CSRF state token is only in flight for the length of a consent screen. */
const STATE_TTL_SECONDS = 600;

/**
 * The stored refresh token is no longer usable and the user must reconnect.
 *
 * The common cause is not revocation but Google policy: while an OAuth app
 * sits in "Testing" publishing status, every refresh token it issues expires
 * after seven days. Without this distinction that shows up as an opaque
 * "token request failed" once a week, which reads like a bug in the sync
 * rather than an expected reconnect.
 */
export class GscConnectionExpiredError extends Error {
  constructor(detail?: string) {
    super(
      `Google has invalidated this connection${detail ? ` (${detail})` : ""}. Reconnect Search Console. ` +
        "If this recurs weekly, the OAuth app is still in Testing status -- Google expires those refresh tokens after 7 days. " +
        "Set the consent screen's User type to Internal, or publish and verify the app.",
    );
    this.name = "GscConnectionExpiredError";
  }
}

export class GscNotConfiguredError extends Error {
  constructor() {
    super(
      "Google Search Console is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI to the root .env.",
    );
    this.name = "GscNotConfiguredError";
  }
}

export interface GscConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Returns null rather than throwing, so `/gsc/status` can report the gap. */
export function gscConfig(): GscConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: resolveRedirectUri() };
}

/**
 * Where Google sends the user back.
 *
 * Derived from APP_URL when one is set, because behind a tunnel the callback
 * has to come back through the public origin -- Google cannot reach
 * localhost:4000 from the user's browser session on someone else's machine.
 * Vite proxies /api to Express, so the public origin serves both halves and a
 * single URL works for the whole flow.
 *
 * An explicit GOOGLE_REDIRECT_URI still wins, for setups that don't match
 * this shape. Whatever this resolves to must be registered verbatim on the
 * OAuth client, or Google returns redirect_uri_mismatch.
 */
function resolveRedirectUri(): string {
  const explicit = process.env.GOOGLE_REDIRECT_URI?.trim();
  if (explicit) return explicit;

  const appUrl = process.env.APP_URL?.trim();
  if (appUrl) return `${appUrl.replace(/\/+$/, "")}/api/gsc/callback`;

  return "http://localhost:4000/api/gsc/callback";
}

function requireConfig(): GscConfig {
  const config = gscConfig();
  if (!config) throw new GscNotConfiguredError();
  return config;
}

// ---------------------------------------------------------------------------
// Step 1 -- send the user to Google
// ---------------------------------------------------------------------------

/**
 * Builds the consent URL for one user.
 *
 * `access_type=offline` together with `prompt=consent` is what makes Google
 * return a refresh token. Without both, a user who has authorised this app
 * before gets an access token only, and the connection silently dies an hour
 * later with no way to renew it.
 */
export function buildAuthUrl(userId: string): string {
  const config = requireConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GSC_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: signState(userId),
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * The `state` parameter, as a short-lived signed token bound to the user.
 *
 * Google hands `state` straight back to the callback, so signing it is what
 * stops an attacker from luring a logged-in user to a crafted callback URL
 * and binding *their own* Google account to the victim's session. A random
 * opaque string would need a server-side store; a signed JWT carries the
 * user id and its own expiry with no extra table.
 */
function signState(userId: string): string {
  return jwt.sign({ sub: userId, purpose: "gsc_oauth" }, jwtSecret(), {
    expiresIn: STATE_TTL_SECONDS,
  });
}

/** Returns the user id the state was issued to, or null if it isn't valid. */
export function verifyState(state: string | undefined): string | null {
  if (!state) return null;
  try {
    const payload = jwt.verify(state, jwtSecret());
    if (typeof payload === "string" || payload.purpose !== "gsc_oauth") return null;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 2 -- exchange the code, and keep the token alive
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => null)) as (TokenResponse & { error_description?: string; error?: string }) | null;
  if (!res.ok || !json?.access_token) {
    // `invalid_grant` is Google's catch-all for "this grant is dead":
    // expired, revoked, or already used. All of them need the same action
    // from the user, and none of them are retryable.
    if (json?.error === "invalid_grant") throw new GscConnectionExpiredError(json.error_description);
    const detail = json?.error_description ?? json?.error ?? `HTTP ${res.status}`;
    throw new Error(`Google token request failed: ${detail}`);
  }
  return json;
}

/**
 * Completes the flow: swaps the authorization code for tokens and stores the
 * connection, replacing any previous one for this user.
 */
export async function exchangeCodeAndStore(userId: string, code: string): Promise<{ googleEmail: string | null }> {
  const config = requireConfig();
  const tokens = await postToken({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });

  if (!tokens.refresh_token) {
    // Recoverable, and the fix is specific enough to be worth naming: Google
    // withholds the refresh token on a repeat authorisation unless the user
    // is re-prompted, or revokes the app's existing grant.
    throw new Error(
      "Google returned no refresh token. Remove this app at myaccount.google.com/permissions and connect again.",
    );
  }

  const googleEmail = await fetchGoogleEmail(tokens.access_token);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  await db
    .insert(gscConnections)
    .values({
      userId,
      googleEmail,
      refreshTokenEnc: encryptToken(tokens.refresh_token),
      accessToken: tokens.access_token,
      accessTokenExpiresAt: expiresAt,
      scopes: tokens.scope ?? GSC_SCOPES.join(" "),
    })
    .onConflictDoUpdate({
      target: gscConnections.userId,
      set: {
        googleEmail,
        refreshTokenEnc: encryptToken(tokens.refresh_token),
        accessToken: tokens.access_token,
        accessTokenExpiresAt: expiresAt,
        scopes: tokens.scope ?? GSC_SCOPES.join(" "),
        updatedAt: new Date(),
      },
    });

  return { googleEmail };
}

/** Best-effort: a missing email costs a label in the UI, not the connection. */
async function fetchGoogleEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { email?: string };
    return json.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns a usable access token for a user, refreshing it if it has expired
 * or is about to.
 *
 * Every API call goes through here rather than reading the stored token
 * directly, so no caller has to know whether a refresh is due.
 */
export async function getAccessToken(userId: string): Promise<string> {
  const [connection] = await db.select().from(gscConnections).where(eq(gscConnections.userId, userId));
  if (!connection) throw new Error("Search Console is not connected for this account.");

  const expiresAt = connection.accessTokenExpiresAt?.getTime() ?? 0;
  const stillFresh = connection.accessToken && expiresAt - EXPIRY_SKEW_SECONDS * 1000 > Date.now();
  if (stillFresh) return connection.accessToken as string;

  const config = requireConfig();
  const tokens = await postToken({
    refresh_token: decryptToken(connection.refreshTokenEnc),
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });

  const refreshed = new Date(Date.now() + tokens.expires_in * 1000);
  await db
    .update(gscConnections)
    .set({ accessToken: tokens.access_token, accessTokenExpiresAt: refreshed, updatedAt: new Date() })
    .where(eq(gscConnections.id, connection.id));

  return tokens.access_token;
}

/**
 * Disconnects: tells Google to drop the grant, then deletes the row.
 *
 * Revoking first matters -- deleting our copy alone would leave the app
 * listed in the user's Google account with a token we no longer hold and
 * they can't see. A failed revoke still proceeds to the delete, because
 * leaving a stale local row would be worse.
 */
export async function disconnect(userId: string): Promise<void> {
  const [connection] = await db.select().from(gscConnections).where(eq(gscConnections.userId, userId));
  if (!connection) return;

  try {
    await fetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: decryptToken(connection.refreshTokenEnc) }).toString(),
    });
  } catch (err) {
    console.error("[gsc] revoke failed, deleting local connection anyway:", err);
  }

  await db.delete(gscConnections).where(eq(gscConnections.id, connection.id));
}
