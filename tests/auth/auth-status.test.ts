import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { authFailureMessage, publicAuthStatus, readAuthStatus, type AuthStatus } from "../../src/auth/auth-status.js";
import type { BreakerStatus } from "../../src/auth/login-breaker.js";
import { createMcpServer } from "../../src/server.js";
import type { AppConfig, TokenData } from "../../src/types/index.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const MIN = 60_000;
const token: TokenData = { accessToken: "secret-token", capturedAt: NOW, expiresAt: NOW + 50 * MIN, source: "browser" };
const closed: BreakerStatus = { open: false, lastAttempt: null, retryAt: null };
const status = (over: Partial<AuthStatus>): AuthStatus =>
  ({ state: "failing", expiresAt: null, lastLogin: null, paused: false, retryAt: null, ...over });

describe("readAuthStatus", () => {
  const read = (t: TokenData | null, breaker: BreakerStatus) =>
    readAuthStatus({ getToken: async () => t }, { status: async () => breaker });

  it.each([
    ["valid", token, closed],
    ["expired", null, closed],
    ["expired", null, { ...closed, lastAttempt: { at: NOW, ok: true } }],
    ["failing", null, { ...closed, lastAttempt: { at: NOW, ok: false, kind: "timeout" } }],
    ["failing", token, { open: true, retryAt: NOW + MIN, lastAttempt: { at: NOW, ok: false, kind: "timeout" } }],
  ] as const)("reports %s", async (state, t, breaker) => {
    expect((await read(t, breaker as BreakerStatus)).state).toBe(state);
  });
});

describe("authFailureMessage", () => {
  it("tells the user to update credentials when the password was rejected", () => {
    const message = authFailureMessage(status({ paused: true, lastLogin: { at: NOW, ok: false, kind: "credentials", message: "rejected" } }), NOW);
    expect(message).toBe(
      "Brightspace login failed: username or password rejected. Update credentials on the server (pnpm run setup) — automatic retries paused."
    );
  });

  it("says when the next automatic retry happens", () => {
    const message = authFailureMessage(
      status({ paused: true, retryAt: NOW + 15 * MIN, lastLogin: { at: NOW, ok: false, kind: "sso_changed", message: "the NetID login form never appeared" } }),
      NOW
    );
    expect(message).toMatch(/^Brightspace login failed: the SSO login page looked different .*never appeared/);
    expect(message).toContain("paused for ~15 min (until 2026-09-28T12:15:00.000Z)");
  });

  it("points to a manual login when interaction is required", () => {
    const message = authFailureMessage(status({ lastLogin: { at: NOW, ok: false, kind: "interaction" } }), NOW);
    expect(message).toMatch(/MFA or other manual interaction.*next request will try.*pnpm run auth/);
  });
});

describe("publicAuthStatus", () => {
  it("contains only state, timing and the failure kind", () => {
    const pub = publicAuthStatus(
      status({ paused: true, retryAt: NOW + MIN, expiresAt: NOW + 30 * MIN, lastLogin: { at: NOW, ok: false, kind: "other", message: "netid@tudelft.nl: secret-token" } }),
      NOW
    );
    expect(pub).toEqual({
      state: "failing",
      expiresInMinutes: 30,
      lastLogin: { at: "2026-09-28T12:00:00.000Z", ok: false, kind: "other" },
      retriesPaused: true,
      nextRetryAt: "2026-09-28T12:01:00.000Z",
    });
    expect(JSON.stringify(pub)).not.toMatch(/netid|secret/);
  });
});

describe("check_auth", () => {
  const config = { baseUrl: "https://brightspace.tudelft.nl", sessionDir: "/tmp/x", tokenTtl: 3600, headless: true, courseFilter: { activeOnly: true } } as AppConfig;

  async function callCheckAuth(getToken: () => Promise<TokenData | null>, breaker: BreakerStatus) {
    const authRunner = { run: vi.fn(async () => false), status: vi.fn(async () => breaker) };
    const server = createMcpServer({ apiClient: {} as any, tokenManager: { getToken }, authRunner, config, includeDownloadFile: false });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(clientSide);
    const result = await client.callTool({ name: "check_auth", arguments: {} });
    await client.close();
    return { result, authRunner, text: (result.content as Array<{ text: string }>)[0].text };
  }

  it("does not launch a login while the breaker is open, and says why", async () => {
    const breaker: BreakerStatus = { open: true, retryAt: null, lastAttempt: { at: NOW, ok: false, kind: "credentials" } };
    const { result, authRunner, text } = await callCheckAuth(async () => null, breaker);
    expect(authRunner.run).not.toHaveBeenCalled();
    expect(text).toMatch(/^Not authenticated\. Brightspace login failed: username or password rejected/);
    expect(result.structuredContent).toMatchObject({ authenticated: false, auth: { state: "failing", retriesPaused: true } });
  });

  it("tries one login when the breaker is closed", async () => {
    const { authRunner, text } = await callCheckAuth(async () => null, closed);
    expect(authRunner.run).toHaveBeenCalledTimes(1);
    expect(text).toMatch(/^Not authenticated\./);
  });

  it("warns about a failing background login while the token still works", async () => {
    const breaker: BreakerStatus = { open: true, retryAt: Date.now() + 5 * MIN, lastAttempt: { at: Date.now(), ok: false, kind: "timeout" } };
    const valid = { ...token, expiresAt: Date.now() + 50 * MIN };
    const { text, result } = await callCheckAuth(async () => valid, breaker);
    expect(text).toMatch(/^Authenticated with Brightspace\..*Warning: Brightspace login failed: the login timed out/);
    expect(result.structuredContent).toMatchObject({ authenticated: true, auth: { state: "failing" } });
  });
});
