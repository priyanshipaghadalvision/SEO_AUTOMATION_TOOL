import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { jwtSecret } from "../lib/auth.js";

/**
 * Envelope encryption for Google refresh tokens.
 *
 * A refresh token is a long-lived bearer credential to a user's Search
 * Console data -- it does not expire on its own and cannot be invalidated
 * from our side. Storing them in plaintext would make a database dump
 * equivalent to handing over every connected Google account, so they are
 * sealed with AES-256-GCM before they ever reach a column.
 *
 * GCM rather than CBC because it authenticates as well as encrypts: a
 * tampered ciphertext fails to open instead of decrypting to garbage that
 * then gets sent to Google.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for.
const KEY_BYTES = 32;
const SALT = "gsc-token-encryption-v1";

let cachedKey: Buffer | null = null;

/**
 * Derives the encryption key.
 *
 * Prefers a dedicated `GSC_TOKEN_KEY` so token encryption and session signing
 * can be rotated independently. Falls back to deriving from `JWT_SECRET`,
 * which keeps the integration working with no extra configuration -- with the
 * documented consequence that rotating `JWT_SECRET` makes stored tokens
 * unreadable and every user has to reconnect. That is a safe failure (a
 * reconnect prompt, not silent corruption), and it is why decryption
 * distinguishes "wrong key" from "malformed data" below.
 */
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const material = process.env.GSC_TOKEN_KEY?.trim() || jwtSecret();
  cachedKey = scryptSync(material, SALT, KEY_BYTES);
  return cachedKey;
}

/** Returns `iv.authTag.ciphertext`, all base64url, safe for a text column. */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export class TokenDecryptionError extends Error {
  constructor() {
    super(
      "Stored Google token could not be decrypted. This normally means JWT_SECRET or GSC_TOKEN_KEY changed since it was saved -- reconnect Search Console to store a fresh token.",
    );
    this.name = "TokenDecryptionError";
  }
}

export function decryptToken(sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 3) throw new TokenDecryptionError();

  try {
    const [iv, tag, data] = parts.map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv(ALGORITHM, key(), iv as Buffer);
    decipher.setAuthTag(tag as Buffer);
    return Buffer.concat([decipher.update(data as Buffer), decipher.final()]).toString("utf8");
  } catch {
    // GCM's auth check fails identically for a wrong key and for tampering,
    // so both surface as the same actionable message rather than a raw
    // crypto error that says nothing about what to do next.
    throw new TokenDecryptionError();
  }
}
