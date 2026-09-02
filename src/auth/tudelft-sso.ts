/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { Page } from "playwright";
import { log } from "../utils/logger.js";
import {
  BaseSSOFlow,
  CredentialsRejectedError,
  raceOutcomes,
} from "./sso-flow.js";

/**
 * TU Delft login chain (no institution picker, no MFA):
 *   brightspace.tudelft.nl/d2l/login
 *     → /d2l/lp/auth/saml/initiate-login?entityId=https://engine.surfconext.nl/...
 *     → SURFconext (auto-forwards, no WAYF screen)
 *     → login.tudelft.nl/sso/module.php/core/loginuserpass (SimpleSAMLphp)
 *     → SAML response POST → brightspace.tudelft.nl/d2l/home
 *
 * On bad credentials SimpleSAMLphp reloads the same form with a
 * ".message-box.error" block instead of navigating away.
 *
 * SURFconext shows an attribute-release consent page on a user's first login
 * to a service provider (and again after attribute changes). Its accept form
 * is OpenConext engineblock's `<form id="accept">` with a submit named
 * `accept_terms_button`. The selector is deliberately that specific: the
 * normal chain also passes through engine.surfconext.nl on a transient
 * auto-submitting SAML page, which must not be clicked.
 */
const SELECTORS = {
  usernameInput: "input#username",
  passwordInput: "input#password",
  submitButton: "button#submit_button",
  errorMessage: ".message-box.error",
  consentAccept: 'form#accept [name="accept_terms_button"]',
} as const;

const HOME_URL_PATTERN = /\/d2l\/home/;
const ARRIVAL_TIMEOUT_MS = 30000;
const POST_SUBMIT_TIMEOUT_MS = 90000;

export class TUDelftSSOFlow extends BaseSSOFlow {
  readonly loginHint = "No MFA prompt — login completes automatically.";

  /** True if the configured Brightspace instance is TU Delft's. */
  static matches(baseUrl: string): boolean {
    try {
      const hostname = new URL(baseUrl).hostname;
      return hostname === "tudelft.nl" || hostname.endsWith(".tudelft.nl");
    } catch {
      return false;
    }
  }

  async login(page: Page): Promise<boolean> {
    const { username, password } = this.requireCredentials();
    log("INFO", "Starting TU Delft SSO login flow (login.tudelft.nl via SURFconext)");

    // Saved storage state also carries the IdP's own session cookies. When
    // only the Brightspace session expired, SimpleSAMLphp auto-POSTs a fresh
    // SAML response without showing a form, and we land straight on home.
    const arrival = await raceOutcomes({
      form: page.waitForSelector(SELECTORS.usernameInput, { timeout: ARRIVAL_TIMEOUT_MS }),
      home: page.waitForURL(HOME_URL_PATTERN, { timeout: ARRIVAL_TIMEOUT_MS }),
    });

    if (arrival === "home") {
      log("INFO", "IdP session still active — SSO completed without a login form");
      return true;
    }
    if (arrival !== "form") {
      log("WARN", `TU Delft login form never appeared — last URL: ${page.url()}`);
      return false;
    }

    log("INFO", "Entering NetID credentials");
    await page.fill(SELECTORS.usernameInput, username);
    await page.fill(SELECTORS.passwordInput, password);
    await page.click(SELECTORS.submitButton);

    const deadline = Date.now() + POST_SUBMIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const outcome = await raceOutcomes({
        home: page.waitForURL(HOME_URL_PATTERN, { timeout: remaining }),
        error: page.waitForSelector(SELECTORS.errorMessage, {
          state: "visible",
          timeout: remaining,
        }),
        consent: page.waitForSelector(SELECTORS.consentAccept, {
          state: "visible",
          timeout: remaining,
        }),
      });

      if (outcome === "home") {
        log("INFO", "Login successful - reached Brightspace home");
        return true;
      }
      if (outcome === "error") {
        throw new CredentialsRejectedError(
          "TU Delft SSO rejected the NetID username or password"
        );
      }
      if (outcome === "consent") {
        log("INFO", "SURFconext attribute-release consent page detected — accepting");
        await page.click(SELECTORS.consentAccept);
        // Don't re-detect (and re-click) the same form while it's still submitting
        await page
          .waitForSelector(SELECTORS.consentAccept, { state: "detached", timeout: 15000 })
          .catch(() => {});
        continue;
      }
      break;
    }

    log("WARN", `TU Delft SSO login timed out — last URL: ${page.url()}`);
    return false;
  }
}
