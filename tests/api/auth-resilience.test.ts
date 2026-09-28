import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { D2LApiClient } from "../../src/api/client.js";
import { AuthUnavailableError, NetworkError } from "../../src/api/errors.js";
import { TokenManager } from "../../src/auth/token-manager.js";
import { sanitizeError } from "../../src/tools/tool-helpers.js";
import type { TokenData } from "../../src/types/index.js";

const BASE = "https://brightspace.example.edu";
const VERSIONS = [{ ProductCode: "lp", LatestVersion: "1.50" }, { ProductCode: "le", LatestVersion: "1.80" }];
const token = (accessToken: string): TokenData => ({ accessToken, capturedAt: Date.now(), expiresAt: Date.now() + 3600_000, source: "browser" });

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "auth-resilience-")); });
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("401 handling across processes", () => {
  it("uses a session another process saved instead of deleting it and logging in again", async () => {
    const mine = new TokenManager(dir), other = new TokenManager(dir);
    await mine.setToken(token("old"));
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("Authorization");
      if (auth === "Bearer old") {
        // Another process logs in while this request is in flight
        await other.setToken(token("new"));
        return new Response("expired", { status: 401 });
      }
      return Response.json({ ok: auth === "Bearer new" });
    });
    vi.stubGlobal("fetch", fetch);
    const login = vi.fn(async () => true);
    const api = new D2LApiClient({ baseUrl: BASE, tokenManager: mine, onAuthExpired: login });

    expect(await api.get("/whoami")).toEqual({ ok: true });
    expect(login).not.toHaveBeenCalled();
    expect((await new TokenManager(dir).getToken())?.accessToken).toBe("new");
  });

  it("explains a failed re-login with the recorded reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("expired", { status: 401 })));
    const reason = "Brightspace login failed: username or password rejected. Update credentials on the server (pnpm run setup) — automatic retries paused.";
    const api = new D2LApiClient({
      baseUrl: BASE,
      tokenManager: { getToken: async () => null, clearToken: async () => {} } as any,
      onAuthExpired: async () => false,
      describeAuthFailure: async () => reason,
    });
    const error = await api.get("/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthUnavailableError);
    const result = sanitizeError(error);
    expect(result.content[0]).toMatchObject({ text: reason });
    expect(result.isError).toBe(true);
  });
});

describe("API version discovery at startup", () => {
  const client = () => new D2LApiClient({ baseUrl: BASE, tokenManager: {} as any, versionCacheDir: dir });

  it("caches discovered versions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(VERSIONS)));
    await client().initialize();
    expect(JSON.parse(await readFile(join(dir, "api-versions.json"), "utf-8"))).toMatchObject({ baseUrl: BASE, lp: "1.50", le: "1.80" });
  });

  it("retries, then falls back to cached versions and keeps re-discovering in the background", async () => {
    vi.useFakeTimers();
    await writeFile(join(dir, "api-versions.json"), JSON.stringify({ baseUrl: BASE, lp: "1.49", le: "1.79" }));
    let up = false;
    const fetch = vi.fn(async () => (up ? Response.json(VERSIONS) : new Response("maintenance", { status: 503 })));
    vi.stubGlobal("fetch", fetch);
    const api = client();

    const init = api.initialize();
    await vi.advanceTimersByTimeAsync(4000);
    await init;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(api.apiVersions).toEqual({ lp: "1.49", le: "1.79" });

    up = true;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(dir, "api-versions.json"), "utf-8"))).toMatchObject({ lp: "1.50" }));
    expect(api.apiVersions).toEqual({ lp: "1.50", le: "1.80" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("without a cache, starts anyway and reports Brightspace as unreachable until discovery succeeds", async () => {
    vi.useFakeTimers();
    let up = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (!up) throw new TypeError("fetch failed");
      return Response.json(VERSIONS);
    }));
    const api = client();
    const init = api.initialize();
    await vi.advanceTimersByTimeAsync(4000);
    await expect(init).resolves.toBeUndefined();
    expect(() => api.lp("/users/whoami")).toThrow(NetworkError);
    expect(sanitizeError(new NetworkError("x")).content[0]).toMatchObject({ text: expect.stringMatching(/Could not connect/) });

    await vi.advanceTimersByTimeAsync(30_000); // first background retry fails too
    up = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(dir, "api-versions.json"), "utf-8"))).toMatchObject({ lp: "1.50" }));
    expect(api.lp("/users/whoami")).toBe("/d2l/api/lp/1.50/users/whoami");
  });

  it("dispose() stops background re-discovery", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const api = client();
    const init = api.initialize();
    await vi.advanceTimersByTimeAsync(4000);
    await init;
    expect(vi.getTimerCount()).toBe(1);
    api.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
