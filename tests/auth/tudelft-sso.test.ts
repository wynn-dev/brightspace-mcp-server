import { describe, it, expect, vi } from "vitest";
import { TUDelftSSOFlow } from "../../src/auth/tudelft-sso.js";
import { CredentialsRejectedError } from "../../src/auth/sso-flow.js";

const HOME_URL = "https://brightspace.tudelft.nl/d2l/home";
const SAML_URL =
  "https://brightspace.tudelft.nl/d2l/lp/auth/saml/initiate-login?entityId=https%3a%2f%2fengine.surfconext.nl";
const IDP_URL =
  "https://login.tudelft.nl/sso/module.php/core/loginuserpass?AuthState=abc";

// Selectors are the contract with the live pages; keep in sync with tudelft-sso.ts
const USERNAME = "input#username";
const PASSWORD = "input#password";
const SUBMIT = "button#submit_button";
const ERROR_BOX = ".message-box.error";
const CONSENT_ACCEPT = 'form#accept [name="accept_terms_button"]';

/**
 * Event-driven fake Page. Waiters never time out on their own; they resolve
 * when the test drives navigate()/show()/hide(). click() handlers model what
 * the real site does in response.
 */
class FakePage {
  private current: string;
  private shown = new Set<string>();
  private urlWaiters: Array<{ matches: (url: string) => boolean; resolve: () => void }> = [];
  private selectorWaiters: Array<{
    selector: string;
    wantPresent: boolean;
    resolve: () => void;
  }> = [];

  readonly filled: Record<string, string> = {};
  readonly clicks: string[] = [];
  readonly onClick: Record<string, () => void> = {};

  constructor(startUrl: string) {
    this.current = startUrl;
  }

  url() {
    return this.current;
  }

  navigate(url: string) {
    this.current = url;
    this.flush();
  }

  show(selector: string) {
    this.shown.add(selector);
    this.flush();
  }

  hide(selector: string) {
    this.shown.delete(selector);
    this.flush();
  }

  async waitForURL(pattern: RegExp | ((url: URL) => boolean)) {
    const matches = (url: string) =>
      pattern instanceof RegExp ? pattern.test(url) : pattern(new URL(url));
    if (matches(this.current)) return;
    await new Promise<void>((resolve) => this.urlWaiters.push({ matches, resolve }));
  }

  async waitForSelector(selector: string, options?: { state?: string }) {
    const wantPresent = options?.state !== "detached";
    if (this.shown.has(selector) === wantPresent) return {};
    await new Promise<void>((resolve) =>
      this.selectorWaiters.push({ selector, wantPresent, resolve })
    );
    return {};
  }

  async fill(selector: string, value: string) {
    this.filled[selector] = value;
  }

  async click(selector: string) {
    this.clicks.push(selector);
    this.onClick[selector]?.();
  }

  private flush() {
    this.urlWaiters = this.urlWaiters.filter((w) => {
      if (!w.matches(this.current)) return true;
      w.resolve();
      return false;
    });
    this.selectorWaiters = this.selectorWaiters.filter((w) => {
      if (this.shown.has(w.selector) !== w.wantPresent) return true;
      w.resolve();
      return false;
    });
  }
}

function makeFlow() {
  return new TUDelftSSOFlow({ username: "netid", password: "secret" });
}

describe("TUDelftSSOFlow.login", () => {
  it("fills the NetID form and succeeds when the SAML response lands on /d2l/home", async () => {
    const page = new FakePage(IDP_URL);
    page.show(USERNAME);
    page.onClick[SUBMIT] = () => page.navigate(HOME_URL);

    await expect(makeFlow().login(page as any)).resolves.toBe(true);
    expect(page.filled).toEqual({ [USERNAME]: "netid", [PASSWORD]: "secret" });
    expect(page.clicks).toEqual([SUBMIT]);
  });

  it("throws CredentialsRejectedError when SimpleSAMLphp re-renders the form with an error", async () => {
    const page = new FakePage(IDP_URL);
    page.show(USERNAME);
    page.onClick[SUBMIT] = () => page.show(ERROR_BOX);

    await expect(makeFlow().login(page as any)).rejects.toBeInstanceOf(
      CredentialsRejectedError
    );
  });

  it("accepts the SURFconext attribute-release consent page and continues to /d2l/home", async () => {
    const page = new FakePage(IDP_URL);
    page.show(USERNAME);
    page.onClick[SUBMIT] = () => page.show(CONSENT_ACCEPT);
    page.onClick[CONSENT_ACCEPT] = () => {
      page.hide(CONSENT_ACCEPT);
      page.navigate(HOME_URL);
    };

    await expect(makeFlow().login(page as any)).resolves.toBe(true);
    expect(page.clicks).toEqual([SUBMIT, CONSENT_ACCEPT]);
  });

  it("succeeds without touching a form when a live IdP session auto-completes SAML", async () => {
    const page = new FakePage(SAML_URL);
    setTimeout(() => page.navigate(HOME_URL), 5);

    await expect(makeFlow().login(page as any)).resolves.toBe(true);
    expect(page.filled).toEqual({});
    expect(page.clicks).toEqual([]);
  });

  it("refuses to run without credentials", async () => {
    const flow = new TUDelftSSOFlow({ username: "netid" });
    const page = new FakePage(IDP_URL);
    page.show(USERNAME);

    await expect(flow.login(page as any)).rejects.toThrow(/required/);
    expect(flow.hasCredentials()).toBe(false);
  });
});

describe("TUDelftSSOFlow.manualLogin", () => {
  it("resolves once the user reaches /d2l/home", async () => {
    const page = new FakePage(IDP_URL);
    setTimeout(() => page.navigate(HOME_URL), 5);

    await expect(makeFlow().manualLogin(page as any)).resolves.toBe(true);
  });

  it("returns false if waiting fails", async () => {
    const page = {
      url: () => IDP_URL,
      waitForURL: vi.fn(async () => {
        throw new Error("Timeout");
      }),
    };

    await expect(makeFlow().manualLogin(page as any)).resolves.toBe(false);
  });
});
