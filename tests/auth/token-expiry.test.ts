import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { epochToMs, jwtExpiry, resolveTokenExpiry } from "../../src/auth/token-expiry.js";
import { BrowserAuth, unexpiredCookies } from "../../src/auth/browser-auth.js";
import type { AppConfig } from "../../src/types/index.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const jwt = (claims: object) =>
  ["eyJhbGciOiJSUzI1NiJ9", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

describe("token expiry", () => {
  it("normalizes epoch seconds and milliseconds", () => {
    expect(epochToMs(1_790_000_000)).toBe(1_790_000_000_000);
    expect(epochToMs(1_790_000_000_000)).toBe(1_790_000_000_000);
    expect(epochToMs("1790000000")).toBe(1_790_000_000_000);
    expect(epochToMs(undefined)).toBeNull();
    expect(epochToMs(-1)).toBeNull();
  });

  it("reads the JWT exp claim", () => {
    expect(jwtExpiry(jwt({ exp: NOW / 1000 + 3600 }))).toBe(NOW + 3_600_000);
    expect(jwtExpiry("opaque-token")).toBeNull();
    expect(jwtExpiry("a.not-base64-json.c")).toBeNull();
  });

  it("prefers D2L's stored expires_at, then the JWT, then the configured TTL", () => {
    const token = jwt({ exp: NOW / 1000 + 1800 });
    expect(resolveTokenExpiry(token, NOW / 1000 + 900, 3600, NOW)).toBe(NOW + 900_000);
    expect(resolveTokenExpiry(token, undefined, 3600, NOW)).toBe(NOW + 1_800_000);
    expect(resolveTokenExpiry("opaque", undefined, 3600, NOW)).toBe(NOW + 3_600_000);
    // Already-past or absurd expiries fall through
    expect(resolveTokenExpiry("opaque", NOW / 1000 - 60, 3600, NOW)).toBe(NOW + 3_600_000);
    expect(resolveTokenExpiry(jwt({ exp: NOW / 1000 + 400 * 86400 }), undefined, 3600, NOW)).toBe(NOW + 3_600_000);
  });
});

describe("BrowserAuth uses the real expiry", () => {
  let dir: string;
  const config = (): AppConfig => ({ baseUrl: "https://brightspace.example.edu", sessionDir: dir, tokenTtl: 3600, headless: true, courseFilter: { activeOnly: true } });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "browser-auth-expiry-"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("stores D2L.Fetch.Tokens' expires_at instead of now + tokenTtl", async () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 1200;
    const page = {
      url: () => "https://brightspace.example.edu/d2l/home",
      evaluate: vi.fn(async () => ({ token: "localstorage-token", expiresAt: expiresAtSeconds })),
    };
    const token = await (new BrowserAuth(config()) as any).tryExtractToken(page);
    expect(token).toMatchObject({ accessToken: "localstorage-token", expiresAt: expiresAtSeconds * 1000 });
  });

  it("drops only cookies that expired on their own", () => {
    const now = Date.now();
    const cookies = [
      { name: "session", expires: -1 },
      { name: "live", expires: now / 1000 + 600 },
      { name: "dead", expires: now / 1000 - 600 },
    ];
    expect(unexpiredCookies(cookies, now).map(c => c.name)).toEqual(["session", "live"]);
  });

  it("restores unexpired cookies from an old storage-state file instead of discarding it by age", async () => {
    const file = join(dir, "storage-state.json");
    const future = Date.now() / 1000 + 7 * 86400;
    await writeFile(file, JSON.stringify({
      cookies: [
        { name: "idp", value: "v", domain: "login.tudelft.nl", path: "/", expires: future, httpOnly: true, secure: true, sameSite: "Lax" },
        { name: "gone", value: "v", domain: "login.tudelft.nl", path: "/", expires: 1, httpOnly: true, secure: true, sameSite: "Lax" },
      ],
      origins: [],
    }));
    const dayOld = new Date(Date.now() - 24 * 3600_000);
    await utimes(file, dayOld, dayOld);
    const context = { addCookies: vi.fn(async () => {}), newPage: vi.fn() };
    await (new BrowserAuth(config()) as any).loadStorageState(context);
    expect(context.addCookies).toHaveBeenCalledWith([expect.objectContaining({ name: "idp" })]);
  });

  it.each([
    ["drops", 10 * 60, false],
    ["keeps", 2 * 3600, true],
  ])("%s a restored API token with %ss left so refreshes mint a fresh one", async (_label, secondsLeft, kept) => {
    const tokens = JSON.stringify({ "*:*:*": { access_token: "cached", expires_at: Math.floor(Date.now() / 1000) + secondsLeft } });
    await writeFile(join(dir, "storage-state.json"), JSON.stringify({
      cookies: [],
      origins: [{ origin: "https://brightspace.example.edu", localStorage: [{ name: "D2L.Fetch.Tokens", value: tokens }, { name: "XSRF.Token", value: "x" }] }],
    }));
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    // Run the in-page callback against the stubbed localStorage
    const page = { goto: vi.fn(async () => null), close: vi.fn(async () => {}), evaluate: vi.fn(async (fn: (a: unknown) => unknown, arg: unknown) => fn(arg)) };
    const context = { addCookies: vi.fn(), newPage: vi.fn(async () => page) };
    await (new BrowserAuth(config()) as any).loadStorageState(context);
    expect(store.has("D2L.Fetch.Tokens")).toBe(kept);
    expect(store.get("XSRF.Token")).toBe("x");
  });
});
