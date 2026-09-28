import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyLoginError, LoginFailedError } from "../../src/auth/login-failure.js";
import { CredentialsRejectedError } from "../../src/auth/sso-flow.js";
import { TUDelftSSOFlow } from "../../src/auth/tudelft-sso.js";
import { PurdueSSOFlow } from "../../src/auth/purdue-sso.js";
import { BrowserAuth } from "../../src/auth/browser-auth.js";
import { BrowserAuthError } from "../../src/utils/errors.js";
import { readCredentialSnapshot } from "../../src/utils/config.js";
import type { AppConfig } from "../../src/types/index.js";

/** BrowserAuth.authenticate() wraps most failures like this. */
const wrapped = (cause: Error) => new BrowserAuthError("Authentication failed", "authenticate", cause);
const timeoutError = () => Object.assign(new Error("page.waitForURL: Timeout 30000ms exceeded."), { name: "TimeoutError" });

describe("classifyLoginError", () => {
  it.each([
    ["rejected credentials", new CredentialsRejectedError("TU Delft SSO rejected the NetID username or password"), "credentials"],
    ["a changed SSO page", wrapped(new LoginFailedError("form missing", "sso_login", "sso_changed")), "sso_changed"],
    ["a manual login nobody completed", new BrowserAuthError("Manual login flow failed", "manual_login"), "interaction"],
    ["an unapproved MFA prompt", wrapped(new BrowserAuthError("MFA approval timed out after 120 seconds", "mfa_approval")), "interaction"],
    ["a Playwright timeout", wrapped(new BrowserAuthError("Failed to navigate and login", "navigate_login", timeoutError())), "timeout"],
    ["a browser crash", wrapped(new Error("browserType.launchPersistentContext: Target closed")), "other"],
  ] as const)("classifies %s", (_label, error, kind) => {
    expect(classifyLoginError(error).kind).toBe(kind);
  });

  it("returns a readable message without internal error codes", () => {
    const { message } = classifyLoginError(new CredentialsRejectedError("TU Delft SSO rejected the NetID username or password"));
    expect(message).toBe("TU Delft SSO rejected the NetID username or password");
  });
});

describe("SSO flows report why login() returned false", () => {
  const neverPage = (url: string) => ({
    url: () => url,
    waitForSelector: vi.fn(async () => { throw timeoutError(); }),
    waitForURL: vi.fn(async () => { throw timeoutError(); }),
    goto: vi.fn(async () => null),
  });

  it("TU Delft: login form never appeared → sso_changed, without SAML query strings", async () => {
    const flow = new TUDelftSSOFlow({ username: "netid", password: "secret" });
    await expect(flow.login(neverPage("https://login.tudelft.nl/sso/new-page?AuthState=secret-state") as any)).resolves.toBe(false);
    expect(flow.lastFailure).toMatchObject({ kind: "sso_changed" });
    expect(flow.lastFailure!.detail).toContain("login.tudelft.nl/sso/new-page");
    expect(flow.lastFailure!.detail).not.toContain("AuthState");
  });

  it("Purdue: missing login form → sso_changed", async () => {
    const flow = new PurdueSSOFlow({ username: "u", password: "p" });
    await expect(flow.login(neverPage("https://sso.purdue.edu/idp/profile") as any)).resolves.toBe(false);
    expect(flow.lastFailure).toMatchObject({ kind: "sso_changed" });
  });

  it("headless BrowserAuth turns the flow's reason into a LoginFailedError", async () => {
    const config = { baseUrl: "https://brightspace.tudelft.nl", sessionDir: "/tmp/x", tokenTtl: 3600, headless: true, username: "u", password: "p", courseFilter: { activeOnly: true } } as AppConfig;
    const auth = new BrowserAuth(config);
    (auth as any).ssoFlow = {
      hasCredentials: () => true,
      login: async () => false,
      manualLogin: vi.fn(),
      lastFailure: { kind: "sso_changed", detail: "the NetID login form never appeared" },
    };
    const page = {
      goto: async () => null, url: () => "https://login.tudelft.nl/sso", waitForURL: async () => {}, waitForLoadState: async () => {},
      request: { get: async () => ({ ok: () => false, status: () => 403 }) },
    };
    const error = await (auth as any).navigateAndLogin(page).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LoginFailedError);
    expect(classifyLoginError(wrapped(error))).toMatchObject({ kind: "sso_changed", message: expect.stringContaining("never appeared") });
  });
});

describe("readCredentialSnapshot", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("changes when the password changes and never contains it", () => {
    vi.stubEnv("D2L_BASE_URL", "https://brightspace.tudelft.nl");
    vi.stubEnv("D2L_USERNAME", "netid");
    vi.stubEnv("D2L_PASSWORD", "old-password");
    const before = readCredentialSnapshot();
    vi.stubEnv("D2L_PASSWORD", "new-password");
    const after = readCredentialSnapshot();
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(JSON.stringify(after)).not.toMatch(/password|netid/);
  });
});
