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
  await vi.waitFor(() => expect(tokenManager.getToken).toHaveBeenCalledTimes(3));
  expect(execFile).toHaveBeenCalledTimes(1);
  token = { accessToken: "fresh-test-token", capturedAt: Date.now(), expiresAt: Date.now() + 3600000, source: "browser" };
  finish(null);
  expect(await results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const call of fetch.mock.calls) expect(call[1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer fresh-test-token" } });
});
