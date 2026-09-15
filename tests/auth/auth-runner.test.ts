import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { D2LApiClient } from "../../src/api/client.js";
import type { TokenData } from "../../src/types/index.js";
import { AuthRunner } from "../../src/auth/auth-runner.js";
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());
function finish(error: Error | null) {
  const call = vi.mocked(execFile).mock.calls.at(-1)!;
  const callback = call.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
  callback(error, "", "");
}
describe("automatic reauthentication", () => {
  it("makes concurrent expired requests wait for one successful login", async () => {
    const runner = new AuthRunner();
    const first = runner.run(), second = runner.run(), third = runner.run();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); expect(third).toBe(first);
    finish(null);
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
  });
  it("shares a failed login and allows a later attempt", async () => {
    const runner = new AuthRunner();
    const first = runner.run(), second = runner.run();
    finish(new Error("Login failed"));
    expect(await Promise.all([first, second])).toEqual([false, false]);
    const retry = runner.run();
    expect(execFile).toHaveBeenCalledTimes(2);
    finish(null); expect(await retry).toBe(true);
  });
});

it("retries concurrent API reads with the newly persisted token after automatic login", async () => {
  let token: TokenData | null = null;
  const tokenManager = { getToken: vi.fn(async () => token), clearToken: vi.fn(async () => { token = null; }) };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const runner = new AuthRunner();
  const api = new D2LApiClient({ baseUrl: "https://example.edu", tokenManager, onAuthExpired: () => runner.run() });
  const results = Promise.all([api.get("/first"), api.get("/second"), api.get("/third")]);
  await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(1));
  expect(execFile).toHaveBeenCalledTimes(1);
  token = { accessToken: "fresh-test-token", capturedAt: Date.now(), expiresAt: Date.now() + 3600000, source: "browser" };
  finish(null);
  expect(await results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const call of fetch.mock.calls) expect(call[1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer fresh-test-token" } });
});

it("coordinates token invalidation with login when JSON and file requests receive concurrent 401s", async () => {
  let token: TokenData | null = { accessToken: "rejected-token", capturedAt: Date.now(), expiresAt: Date.now() + 3600000, source: "browser" };
  let releaseClear!: () => void;
  const delayedClear = new Promise<void>(resolve => { releaseClear = resolve; });
  const tokenManager = {
    getToken: vi.fn(async () => token),
    clearToken: vi.fn(async () => {
      if (tokenManager.clearToken.mock.calls.length === 2) await delayedClear;
      token = null;
    }),
  };
  vi.stubGlobal("fetch", vi.fn(async (_url, init) =>
    new Headers(init.headers).get("Authorization") === "Bearer rejected-token"
      ? new Response("Expired", { status: 401 }) : Response.json({ ok: true })));
  const login = vi.fn(async () => {
    token = { accessToken: "fresh-token", capturedAt: Date.now(), expiresAt: Date.now() + 3600000, source: "browser" };
    releaseClear();
    return true;
  });
  const api = new D2LApiClient({ baseUrl: "https://example.edu", tokenManager, onAuthExpired: login });
  const [json, file] = await Promise.all([api.get("/json"), api.getRaw("/file")]);
  expect(json).toEqual({ ok: true }); expect(await file.json()).toEqual({ ok: true });
  expect(login).toHaveBeenCalledTimes(1);
  expect(token?.accessToken).toBe("fresh-token");
});

it.each(["get", "getRaw"] as const)("stops %s after one login and one retry if the new session is also rejected", async method => {
  let token: TokenData | null = { accessToken: "old-token", capturedAt: Date.now(), expiresAt: Date.now() + 3600000, source: "browser" };
  const tokenManager = { getToken: async () => token, clearToken: async () => { token = null; } };
  const fetch = vi.fn(async () => new Response("Rejected", { status: 401 }));
  vi.stubGlobal("fetch", fetch);
  const login = vi.fn(async () => {
    token = { accessToken: "new-token", capturedAt: Date.now(), expiresAt: Date.now() + 3600000, source: "browser" };
    return true;
  });
  const api = new D2LApiClient({ baseUrl: "https://example.edu", tokenManager, onAuthExpired: login });
  await expect(api[method]("/resource")).rejects.toMatchObject({ status: 401 });
  expect(login).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2);
  expect(token).toBeNull();
});
