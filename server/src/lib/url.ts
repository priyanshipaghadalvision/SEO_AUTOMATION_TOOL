import dns from "node:dns/promises";
import net from "node:net";

export class InvalidUrlError extends Error {}

export interface NormalizedUrl {
  normalizedOrigin: string; // e.g. https://example.com
  domain: string; // e.g. example.com or example.com:3000 -- unique key for the website
  protocol: "http:" | "https:";
  hostname: string;
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * Validates and normalizes a user-supplied website URL down to its origin.
 * A "website" is identified by its origin, not a specific page/path.
 */
export function parseAndNormalizeUrl(rawInput: string): NormalizedUrl {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new InvalidUrlError("URL is required.");
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new InvalidUrlError("URL is not well-formed.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidUrlError("Only http and https URLs are supported.");
  }

  const hostname = parsed.hostname.toLowerCase();
  const looksLikeDomain = hostname.includes(".") || hostname === "localhost";
  const isIp = net.isIP(hostname) !== 0;
  if (!looksLikeDomain && !isIp) {
    throw new InvalidUrlError("URL must include a valid host.");
  }

  const port = parsed.port && parsed.port !== DEFAULT_PORTS[parsed.protocol] ? parsed.port : "";
  const domain = port ? `${hostname}:${port}` : hostname;

  return {
    normalizedOrigin: `${parsed.protocol}//${domain}`,
    domain,
    protocol: parsed.protocol as "http:" | "https:",
    hostname,
  };
}

const PRIVATE_IPV4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
];

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  const target = ipToInt(ip);
  return PRIVATE_IPV4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipToInt(base) & mask) === (target & mask);
  });
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "gclsrc",
  "dclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
  "ref_src",
  "ref_url",
  "ito",
  "ns_campaign",
  "ns_mchannel",
  "ns_source",
  "ns_linkname",
  "ns_fee",
  "_ga",
  "ttclid",
  "twclid",
  "yclid",
  "spm",
]);

export interface NormalizedPageUrl {
  url: string; // as resolved (absolute), before normalization
  normalizedUrl: string; // canonical form used for crawl-scoped deduplication
  hostname: string;
}

/**
 * Resolves a link found during crawling against the page it was found on,
 * then normalizes it to a stable, dedup-friendly form: lowercased host,
 * default port stripped, fragment dropped, known tracking params stripped,
 * remaining query params sorted, trailing slash removed (except root).
 * Returns null for non-http(s) links (mailto:, tel:, javascript:, etc.) or
 * anything unparseable.
 */
export function normalizePageUrl(rawHref: string, baseUrl: string): NormalizedPageUrl | null {
  let resolved: URL;
  try {
    resolved = new URL(rawHref, baseUrl);
  } catch {
    return null;
  }

  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return null;
  }

  const hostname = resolved.hostname.toLowerCase();
  const port = resolved.port && resolved.port !== DEFAULT_PORTS[resolved.protocol] ? resolved.port : "";
  const host = port ? `${hostname}:${port}` : hostname;

  let pathname = resolved.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  const keptParams: [string, string][] = [];
  for (const [key, value] of resolved.searchParams.entries()) {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) {
      keptParams.push([key, value]);
    }
  }
  keptParams.sort(([a], [b]) => a.localeCompare(b));
  const search = keptParams.length > 0 ? `?${keptParams.map(([k, v]) => `${k}=${v}`).join("&")}` : "";

  return {
    url: resolved.toString(),
    normalizedUrl: `${resolved.protocol}//${host}${pathname}${search}`,
    hostname,
  };
}

/**
 * SSRF guard: rejects hosts that resolve to private/loopback/link-local/reserved
 * addresses, since the platform detector fetches this URL server-side on the
 * caller's behalf. Set ALLOW_LOCAL_HOSTS=true in .env to disable during local dev
 * against a site running on localhost.
 */
export async function assertPubliclyResolvable(hostname: string): Promise<void> {
  if (process.env.ALLOW_LOCAL_HOSTS === "true") return;

  if (hostname === "localhost") {
    throw new InvalidUrlError("Local hosts are not allowed.");
  }

  const directIpVersion = net.isIP(hostname);
  // A domain that doesn't resolve is a bad request, not a server fault --
  // without this the raw ENOTFOUND propagates and the user gets an opaque
  // 500 "Something went wrong" for the everyday case of a typo'd domain.
  const addresses = directIpVersion
    ? [{ address: hostname, family: directIpVersion }]
    : await dns.lookup(hostname, { all: true }).catch(() => {
        throw new InvalidUrlError(`Could not resolve "${hostname}". Check the domain is spelled correctly.`);
      });

  for (const { address, family } of addresses) {
    const isPrivate = family === 4 ? isPrivateIpv4(address) : isPrivateIpv6(address);
    if (isPrivate) {
      throw new InvalidUrlError("URL resolves to a private or reserved network address.");
    }
  }
}
