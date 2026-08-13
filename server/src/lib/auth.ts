import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SALT_BYTES = 16;
const KEY_BYTES = 64;

export const AUTH_COOKIE = "seo_session";
export const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * The signing secret. Deliberately throws rather than falling back to a
 * default: a hardcoded fallback secret is the single most common way JWT
 * auth ends up trivially forgeable in production.
 */
export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_SECRET is missing or too short (needs >= 32 chars). Set it in .env -- " +
        "generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"",
    );
  }
  return secret;
}

/**
 * Hashes a password with scrypt (memory-hard, built into Node -- no native
 * module to compile). Returns "salt:hash", both hex, so the salt travels
 * with the digest and every password gets a unique one.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEY_BYTES);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

/**
 * Verifies a password against a stored digest using a constant-time
 * comparison, so response timing can't be used to guess the hash.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, jwtSecret(), { expiresIn: TOKEN_TTL_SECONDS });
}

/** Returns the user id, or null for any missing/expired/tampered token. */
export function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, jwtSecret());
    return typeof payload === "object" && typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
