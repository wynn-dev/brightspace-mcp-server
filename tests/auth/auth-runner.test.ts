import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { D2LApiClient } from "../../src/api/client.js";
import type { TokenData } from "../../src/types/index.js";
import { AuthRunner, AUTH_SKIPPED_EXIT_CODE, AUTO_AUTH_ENV } from "../../src/auth/auth-runner.js";
import { LoginBreaker } from "../../src/auth/login-breaker.js";
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

let dir: string;
let now: number;
let fingerprint: string;
const makeBreaker = () => new LoginBreaker(dir, () => ({ fingerprint }), () => now);
const makeRunner = () => new AuthRunner(dir, makeBreaker());

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await mkdtemp(join(tmpdir(), "auth-runner-"));
  now = Date.parse("2026-09-28T12:00:00Z");
  fingerprint = "creds-v1";
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

/** Complete the most recent auth CLI child with the given error. */
function finish(error: (Error & { code?: number; killed?: boolean }) | null, stderr = "") {
  const call = vi.mocked(execFile).mock.calls.at(-1)!;
  const callback = call.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
  callback(error, "", stderr);
}
const spawned = (times: number) => vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(times));
const exitError = (code: number, extra: { killed?: boolean } = {}) =>
  Object.assign(new Error(`Command failed with code ${code}`), { code, ...extra });

describe("automatic reauthentication", () => {
  it("makes concurrent expired requests wait for one successful login", async () => {
    const runner = makeRunner();
    const first = runner.run(), second = runner.run(), third = runner.run();
    expect(second).toBe(first); expect(third).toBe(first);
    await spawned(1);
    expect(vi.mocked(execFile).mock.calls[0][2]).toMatchObject({ env: { [AUTO_AUTH_ENV]: "1" } });
    finish(null);
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
  });

  it("shares a failed login, then fails fast without a browser until the backoff passes", async () => {
    const runner = makeRunner();
    const first = runner.run(), second = runner.run();
    await spawned(1);
    finish(exitError(1), "Error: [PBMCP-1001] Chromium crashed\nFor more details, check the error message above.");
    expect(await Promise.all([first, second])).toEqual([false, false]);

    const status = await runner.status();
    expect(status).toMatchObject({ open: true, lastAttempt: { ok: false, kind: "other", message: "Error: Chromium crashed" } });
    expect(status.retryAt).toBe(now + 60_000);
    expect(await runner.run()).toBe(false);
    expect(execFile).toHaveBeenCalledTimes(1);

    now += 60_000;
    const retry = runner.run();
    await spawned(2);
    finish(null); expect(await retry).toBe(true);
  });

  it("records a killed (timed out) child as a timeout failure", async () => {
    const runner = makeRunner();
    const run = runner.run();
    await spawned(1);
    finish(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }));
    expect(await run).toBe(false);
    expect((await runner.status()).lastAttempt).toMatchObject({ kind: "timeout" });
  });

  it("keeps the failure the child recorded and pauses until the credentials change", async () => {
    const runner = makeRunner();
    const run = runner.run();
    await spawned(1);
    // The auth CLI classifies and records its own failure before exiting 1
    await makeBreaker().recordFailure("credentials", "TU Delft SSO rejected the NetID username or password");
    finish(exitError(1));
    expect(await run).toBe(false);

    now += 24 * 60 * 60_000;
    const status = await runner.status();
    expect(status).toMatchObject({ open: true, retryAt: null, lastAttempt: { kind: "credentials" } });
    expect(await runner.run()).toBe(false);
    expect(execFile).toHaveBeenCalledTimes(1);

    fingerprint = "creds-v2";
    const retry = runner.run();
    await spawned(2);
    finish(null); expect(await retry).toBe(true);
  });

  it("records nothing when the child skipped the login (lock busy / breaker opened meanwhile)", async () => {
    const runner = makeRunner();
    const run = runner.run();
    await spawned(1);
    finish(exitError(AUTH_SKIPPED_EXIT_CODE));
    expect(await run).toBe(false);
    expect(await runner.status()).toMatchObject({ open: false, lastAttempt: null });
  });
});

it("retries concurrent API reads with the newly persisted token after automatic login", async () => {
  let token: TokenData | null = null;
  const tokenManager = { getToken: vi.fn(async () => token), clearToken: vi.fn(async () => { token = null; }) };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const runner = makeRunner();
  const api = new D2LApiClient({ baseUrl: "https://example.edu", tokenManager: tokenManager as any, onAuthExpired: () => runner.run() });
  const results = Promise.all([api.get("/first"), api.get("/second"), api.get("/third")]);
  await spawned(1);
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
  const api = new D2LApiClient({ baseUrl: "https://example.edu", tokenManager: tokenManager as any, onAuthExpired: login });
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
  const api = new D2LApiClient({ baseUrl: "https://example.edu", tokenManager: tokenManager as any, onAuthExpired: login });
  await expect(api[method]("/resource")).rejects.toMatchObject({ status: 401 });
  expect(login).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2);
  expect(token).toBeNull();
});
