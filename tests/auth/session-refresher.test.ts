import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRefresher } from "../../src/auth/session-refresher.js";
import { AuthRunner } from "../../src/auth/auth-runner.js";
import { LoginBreaker, type BreakerStatus } from "../../src/auth/login-breaker.js";
import type { TokenData } from "../../src/types/index.js";
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const MIN = 60_000;
const HOUR = 60 * MIN;

/** A token captured now that lives `lifetimeMs`. */
const freshToken = (lifetimeMs = HOUR): TokenData =>
  ({ accessToken: `t${Date.now()}`, capturedAt: Date.now(), expiresAt: Date.now() + lifetimeMs, source: "browser" });

function setup(breaker: BreakerStatus = { open: false, lastAttempt: null, retryAt: null }) {
  let token: TokenData | null = freshToken();
  const state = { breaker };
  const tokenManager = { getToken: vi.fn(async () => (token && token.expiresAt - Date.now() > 5 * MIN ? token : null)) };
  const authRunner = {
    status: vi.fn(async () => state.breaker),
    run: vi.fn(async () => { token = freshToken(); return true; }),
  };
  const refresher = new SessionRefresher({ tokenManager, authRunner });
  return { refresher, authRunner, state, setToken: (t: TokenData | null) => { token = t; } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-28T08:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("SessionRefresher", () => {
  it("does nothing until a tool call happens", async () => {
    const { authRunner } = setup();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(authRunner.run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes at 75% of the token's real lifetime", async () => {
    const { refresher, authRunner } = setup();
    refresher.noteToolCall();
    await vi.advanceTimersByTimeAsync(45 * MIN - 1);
    expect(authRunner.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(authRunner.run).toHaveBeenCalledTimes(1);
    // The next refresh follows the new token's lifetime
    await vi.advanceTimersByTimeAsync(45 * MIN);
    expect(authRunner.run).toHaveBeenCalledTimes(2);
    refresher.stop();
  });

  it("keeps the session warm only for 12 hours after the last tool call", async () => {
    const { refresher, authRunner } = setup();
    refresher.noteToolCall();
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    const runs = authRunner.run.mock.calls.length;
    expect(runs).toBe(16); // every 45 minutes
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(authRunner.run).toHaveBeenCalledTimes(runs);
    expect(vi.getTimerCount()).toBe(0);

    // A new tool call re-arms it
    refresher.noteToolCall();
    await vi.advanceTimersByTimeAsync(45 * MIN);
    expect(authRunner.run).toHaveBeenCalledTimes(runs + 1);
    refresher.stop();
  });

  it("waits for the circuit breaker's retry time", async () => {
    const retryAt = Date.now() + 2 * HOUR;
    const { refresher, authRunner, state } = setup({ open: true, retryAt, lastAttempt: { at: Date.now(), ok: false, kind: "timeout" } });
    refresher.noteToolCall();
    await vi.advanceTimersByTimeAsync(2 * HOUR - MIN);
    expect(authRunner.run).not.toHaveBeenCalled();
    state.breaker = { open: false, retryAt: null, lastAttempt: state.breaker.lastAttempt };
    await vi.advanceTimersByTimeAsync(MIN);
    expect(authRunner.run).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  it("never refreshes while paused for rejected credentials", async () => {
    const { refresher, authRunner } = setup({ open: true, retryAt: null, lastAttempt: { at: Date.now(), ok: false, kind: "credentials" } });
    refresher.noteToolCall();
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(authRunner.run).not.toHaveBeenCalled();
    refresher.stop();
  });

  it("logs in soon when there is no valid token", async () => {
    const { refresher, authRunner, setToken } = setup();
    setToken(null);
    refresher.noteToolCall();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(authRunner.run).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  it("stop() cancels the unref'd timer", async () => {
    const { refresher, authRunner } = setup();
    const spy = vi.spyOn(globalThis, "setTimeout");
    refresher.noteToolCall();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    expect((spy.mock.results.at(-1)!.value as NodeJS.Timeout).hasRef()).toBe(false);
    refresher.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(authRunner.run).not.toHaveBeenCalled();
  });
});

describe("SessionRefresher with a real AuthRunner", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "refresher-")); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("joins an on-demand login already in flight instead of launching a second browser", async () => {
    const runner = new AuthRunner(dir, new LoginBreaker(dir, () => ({ fingerprint: "v1" })));
    const tokenManager = { getToken: vi.fn(async () => null) };
    const refresher = new SessionRefresher({ tokenManager, authRunner: runner });

    const onDemand = runner.run();
    const backgroundRun = vi.spyOn(runner, "run");
    refresher.noteToolCall();
    // The breaker lives on disk, so scheduling waits on real I/O first
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    await vi.advanceTimersByTimeAsync(MIN);
    await vi.waitFor(() => expect(backgroundRun).toHaveBeenCalledTimes(1));
    expect(backgroundRun.mock.results[0].value).toBe(onDemand);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalled());
    expect(execFile).toHaveBeenCalledTimes(1);
    const callback = vi.mocked(execFile).mock.calls[0].at(-1) as (e: Error | null, o: string, s: string) => void;
    callback(null, "", "");
    expect(await onDemand).toBe(true);
    refresher.stop();
  });
});
