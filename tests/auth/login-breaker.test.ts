import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginBreaker, LOGIN_BACKOFF_MS } from "../../src/auth/login-breaker.js";

let dir: string;
let now: number;
let creds: { fingerprint: string; configMtimeMs?: number };
const breaker = () => new LoginBreaker(dir, () => creds, () => now);
const MIN = 60_000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "login-breaker-"));
  now = 1_800_000_000_000;
  creds = { fingerprint: "v1", configMtimeMs: now - 1000 };
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("LoginBreaker", () => {
  it("is closed before any login attempt", async () => {
    expect(await breaker().status()).toEqual({ open: false, lastAttempt: null, retryAt: null });
  });

  it("backs off 1, 5, 15, then 60 minutes on consecutive non-credential failures", async () => {
    expect(LOGIN_BACKOFF_MS).toEqual([1, 5, 15, 60].map(m => m * MIN));
    for (const minutes of [1, 5, 15, 60, 60]) {
      const status = await breaker().recordFailure("timeout", "the login timed out");
      expect(status).toMatchObject({ open: true, retryAt: now + minutes * MIN });
      now += minutes * MIN - 1;
      expect((await breaker().status()).open).toBe(true);
      now += 1;
      expect((await breaker().status()).open).toBe(false);
    }
  });

  it("resets the backoff after a success", async () => {
    const b = breaker();
    await b.recordFailure("sso_changed", "form missing");
    await b.recordFailure("sso_changed", "form missing");
    await b.recordSuccess();
    expect(await b.status()).toMatchObject({ open: false, lastAttempt: { ok: true } });
    expect((await b.recordFailure("other", "boom")).retryAt).toBe(now + MIN);
  });

  it("pauses indefinitely after rejected credentials, until the fingerprint changes", async () => {
    await breaker().recordFailure("credentials", "password rejected");
    now += 7 * 24 * 60 * MIN;
    expect(await breaker().status()).toMatchObject({ open: true, retryAt: null, lastAttempt: { kind: "credentials" } });
    creds = { ...creds, fingerprint: "v2" };
    expect((await breaker().status()).open).toBe(false);
  });

  it("also resumes when the config file is rewritten after the failure", async () => {
    await breaker().recordFailure("credentials", "password rejected");
    creds = { ...creds, configMtimeMs: now + 5 * MIN };
    expect((await breaker().status()).open).toBe(false);
  });

  it("persists state for other processes without secrets, and ignores a corrupt file", async () => {
    await breaker().recordFailure("credentials", "password rejected");
    const raw = await readFile(join(dir, "auth-state.json"), "utf-8");
    expect(JSON.parse(raw)).toMatchObject({ credentials: "v1", failures: 1, lastAttempt: { kind: "credentials" } });
    // A different instance (another process) sees the same open breaker
    expect((await new LoginBreaker(dir, () => creds, () => now).status()).open).toBe(true);

    await writeFile(join(dir, "auth-state.json"), "{not json");
    expect(await breaker().status()).toMatchObject({ open: false, lastAttempt: null });
  });
});
