import { describe, it, expect } from "vitest";
import { BrowserAuth } from "../../src/auth/browser-auth.js";
import { PurdueSSOFlow } from "../../src/auth/purdue-sso.js";
import { TUDelftSSOFlow } from "../../src/auth/tudelft-sso.js";
import type { AppConfig } from "../../src/types/index.js";

function makeConfig(baseUrl: string): AppConfig {
  return {
    baseUrl,
    sessionDir: "/tmp/does-not-matter",
    tokenTtl: 3600,
    headless: true,
    username: "student",
    password: "hunter2",
    courseFilter: {} as AppConfig["courseFilter"],
  };
}

describe("TUDelftSSOFlow.matches", () => {
  it("matches TU Delft's Brightspace host", () => {
    expect(TUDelftSSOFlow.matches("https://brightspace.tudelft.nl")).toBe(true);
    expect(TUDelftSSOFlow.matches("https://brightspace.tudelft.nl/")).toBe(true);
  });

  it("does not match other institutions", () => {
    expect(TUDelftSSOFlow.matches("https://purdue.brightspace.com")).toBe(false);
    expect(TUDelftSSOFlow.matches("https://brightspace.example.edu")).toBe(false);
    // Suffix check must not fall for lookalike domains
    expect(TUDelftSSOFlow.matches("https://eviltudelft.nl")).toBe(false);
  });

  it("returns false for invalid URLs", () => {
    expect(TUDelftSSOFlow.matches("not a url")).toBe(false);
  });
});

describe("BrowserAuth SSO flow selection", () => {
  it("uses TUDelftSSOFlow for brightspace.tudelft.nl", () => {
    const auth = new BrowserAuth(makeConfig("https://brightspace.tudelft.nl"));
    expect((auth as any).ssoFlow).toBeInstanceOf(TUDelftSSOFlow);
  });

  it("uses PurdueSSOFlow for other base URLs", () => {
    const auth = new BrowserAuth(makeConfig("https://purdue.brightspace.com"));
    expect((auth as any).ssoFlow).toBeInstanceOf(PurdueSSOFlow);
  });
});
