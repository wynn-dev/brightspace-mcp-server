/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

/** Expiries further out than this are treated as bogus and ignored. */
const MAX_PLAUSIBLE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** Epoch seconds or milliseconds (D2L.Fetch.Tokens uses seconds) → milliseconds. */
export function epochToMs(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** The `exp` claim of a JWT access token, in milliseconds; null if it isn't a readable JWT. */
export function jwtExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    return epochToMs(claims?.exp);
  } catch {
    return null;
  }
}

/**
 * When a freshly captured token really expires: the expiry D2L stored next to
 * it, else the JWT exp claim, else the configured TTL. Values already in the
 * past or implausibly far away fall through to the next source.
 */
export function resolveTokenExpiry(
  token: string,
  storedExpiry: unknown,
  fallbackTtlSeconds: number,
  now = Date.now()
): number {
  for (const candidate of [epochToMs(storedExpiry), jwtExpiry(token)]) {
    if (candidate !== null && candidate > now && candidate - now <= MAX_PLAUSIBLE_LIFETIME_MS) return candidate;
  }
  return now + fallbackTtlSeconds * 1000;
}
