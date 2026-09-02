import { describe, it, expect, beforeEach, vi } from "vitest";
import { BrowserAuth } from "../../src/auth/browser-auth.js";
import { CredentialsRejectedError } from "../../src/auth/sso-flow.js";
import { BrowserAuthError } from "../../src/utils/errors.js";
import type { AppConfig } from "../../src/types/index.js";

/**
 * Tests for navigateAndLogin()'s authenticated-session detection.
 *
 * The URL alone is unreliable in both directions:
 *  - USC bounces a *valid* session through /d2l/lp/auth/login/samlLogin.d2l
 *    before landing on /d2l/home, and goto(domcontentloaded) can resolve mid-hop.
 *  - TU Delft serves anonymous /d2l/home as an HTTP 200 stub whose inline
 *    script client-side redirects to /d2l/login, so a logged-out browser can
 *    read as /d2l/home.
 * So the decision comes from a cookie-authenticated /users/whoami probe, and
 * the URL is only used to let redirects settle afterwards.
 */

const BASE_URL = "https://brightspace.example.edu";
const IDP_URL = "https://login.tudelft.nl/sso/module.php/core/loginuserpass?AuthState=abc";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: BASE_URL,
    sessionDir: "/tmp/does-not-matter",
    tokenTtl: 3600,
    headless: true,
    username: "student@example.edu",
    password: "hunter2",
    courseFilter: {} as AppConfig["courseFilter"],
    ...overrides,
  };
}

/**
 * Fake Page reproducing a multi-hop redirect: goto() settles on hops[0] and
 * each waitForURL() advances through the remaining hops until one matches.
 * `session` controls the whoami probe: true → 200, false → 403, "throw" → network error.
 */
function makePage(hops: string[], session: boolean | "throw") {
  let current = hops[0];
  let index = 0;
  return {
    goto: vi.fn(async () => {
      current = hops[0];
      index = 0;
      return null;
    }),
    url: vi.fn(() => current),
    request: {
      get: vi.fn(async () => {
        if (session === "throw") throw new Error("ECONNRESET");
        return { ok: () => session, status: () => (session ? 200 : 403) };
      }),
    },
    waitForURL: vi.fn(async (predicate: RegExp | ((url: URL) => boolean)) => {
      while (index < hops.length - 1) {
        index += 1;
        current = hops[index];
        const matches =
          predicate instanceof RegExp
            ? predicate.test(current)
            : predicate(new URL(current));
        if (matches) return;
      }
      throw new Error("Timeout waiting for URL");
    }),
    waitForLoadState: vi.fn(async () => {}),
  };
}

describe("BrowserAuth.navigateAndLogin", () => {
  let auth: BrowserAuth;
  let ssoFlow: {
    login: ReturnType<typeof vi.fn>;
    manualLogin: ReturnType<typeof vi.fn>;
    hasCredentials: ReturnType<typeof vi.fn>;
  };

  function setup(config: Partial<AppConfig> = {}) {
    auth = new BrowserAuth(makeConfig(config));
    ssoFlow = {
      login: vi.fn(async () => true),
      manualLogin: vi.fn(async () => true),
      hasCredentials: vi.fn(() => true),
    };
    // navigateAndLogin is private; swap the SSO flow so we can observe it.
    (auth as any).ssoFlow = ssoFlow;
  }

  beforeEach(() => setup());

  const navigate = (page: unknown): Promise<boolean> =>
    (auth as any).navigateAndLogin(page);

  describe("live session (whoami 200)", () => {
    it("short-circuits without waiting when goto already lands on /d2l/home", async () => {
      const page = makePage([`${BASE_URL}/d2l/home`], true);

      await expect(navigate(page)).resolves.toBe(true);
      expect(page.waitForURL).not.toHaveBeenCalled();
      expect(ssoFlow.login).not.toHaveBeenCalled();
      expect(ssoFlow.manualLogin).not.toHaveBeenCalled();
    });

    it("lets an intermediate SAML hop settle on /d2l/home instead of starting SSO", async () => {
      const page = makePage(
        [`${BASE_URL}/d2l/lp/auth/login/samlLogin.d2l`, `${BASE_URL}/d2l/home`],
        true
      );

      await expect(navigate(page)).resolves.toBe(true);
      expect(page.waitForURL).toHaveBeenCalledOnce();
      expect(page.url()).toBe(`${BASE_URL}/d2l/home`);
      expect(ssoFlow.login).not.toHaveBeenCalled();
    });

    it("still reports authenticated if the hop never reaches /d2l/home", async () => {
      const page = makePage(
        [`${BASE_URL}/d2l/lp/auth/login/samlLogin.d2l`, `${BASE_URL}/d2l/home/12345`],
        true
      );

      // /d2l/home/12345 matches the settle regex, but even a total miss is fine:
      // token extraction navigates to /d2l/home itself.
      await expect(navigate(page)).resolves.toBe(true);
      expect(ssoFlow.login).not.toHaveBeenCalled();
    });
  });

  describe("no session (whoami 403)", () => {
    it("waits for the anonymous /d2l/home stub to redirect, then runs SSO login (TU Delft)", async () => {
      const page = makePage([`${BASE_URL}/d2l/home`, IDP_URL], false);

      await expect(navigate(page)).resolves.toBe(false);
      expect(page.waitForURL).toHaveBeenCalledOnce();
      expect(page.url()).toBe(IDP_URL);
      expect(ssoFlow.login).toHaveBeenCalledOnce();
    });

    it("runs SSO login in place if the stub never redirects away from /d2l/home", async () => {
      const page = makePage([`${BASE_URL}/d2l/home`], false);

      await expect(navigate(page)).resolves.toBe(false);
      expect(ssoFlow.login).toHaveBeenCalledOnce();
    });

    it("runs SSO login directly when goto already landed on the IdP", async () => {
      const page = makePage([`${BASE_URL}/d2l/lp/auth/login/login.d2l`, IDP_URL], false);

      await expect(navigate(page)).resolves.toBe(false);
      expect(page.waitForURL).not.toHaveBeenCalled();
      expect(ssoFlow.login).toHaveBeenCalledOnce();
    });

    it("goes straight to manual login when no credentials are configured", async () => {
      ssoFlow.hasCredentials.mockReturnValue(false);
      const page = makePage([IDP_URL], false);

      await expect(navigate(page)).resolves.toBe(false);
      expect(ssoFlow.login).not.toHaveBeenCalled();
      expect(ssoFlow.manualLogin).toHaveBeenCalledOnce();
    });
  });

  describe("automated login failure handling", () => {
    it("falls back to manual login in headed mode", async () => {
      setup({ headless: false });
      ssoFlow.login.mockResolvedValue(false);
      const page = makePage([IDP_URL], false);

      await expect(navigate(page)).resolves.toBe(false);
      expect(ssoFlow.manualLogin).toHaveBeenCalledOnce();
    });

    it("fails fast in headless mode instead of waiting for a manual login nobody can see", async () => {
      setup({ headless: true });
      ssoFlow.login.mockResolvedValue(false);
      const page = makePage([IDP_URL], false);

      await expect(navigate(page)).rejects.toThrow(/headless/);
      expect(ssoFlow.manualLogin).not.toHaveBeenCalled();
    });

    it("propagates CredentialsRejectedError without a manual fallback", async () => {
      setup({ headless: false });
      const rejected = new CredentialsRejectedError("IdP said no");
      ssoFlow.login.mockRejectedValue(rejected);
      const page = makePage([IDP_URL], false);

      await expect(navigate(page)).rejects.toBe(rejected);
      expect(ssoFlow.manualLogin).not.toHaveBeenCalled();
    });

    it("throws a BrowserAuthError when manual login also fails", async () => {
      setup({ headless: false });
      ssoFlow.login.mockResolvedValue(false);
      ssoFlow.manualLogin.mockResolvedValue(false);
      const page = makePage([IDP_URL], false);

      await expect(navigate(page)).rejects.toBeInstanceOf(BrowserAuthError);
    });
  });

  describe("probe failure", () => {
    it("falls back to the URL when the whoami probe itself errors", async () => {
      const page = makePage([`${BASE_URL}/d2l/home`], "throw");

      await expect(navigate(page)).resolves.toBe(true);
      expect(ssoFlow.login).not.toHaveBeenCalled();
    });

    it("treats a non-home URL as logged out when the probe errors", async () => {
      const page = makePage([IDP_URL], "throw");

      await expect(navigate(page)).resolves.toBe(false);
      expect(ssoFlow.login).toHaveBeenCalledOnce();
    });
  });
});
