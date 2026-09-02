/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { Page } from "playwright";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import type { SSOCredentials, SSOFlow } from "./sso-flow.js";

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
 */
const SELECTORS = {
  usernameInput: "input#username",
  passwordInput: "input#password",
  submitButton: "button#submit_button",
  errorMessage: ".message-box.error",
} as const;

const IDP_URL_PATTERN = /login\.tudelft\.nl/;

export class TUDelftSSOFlow implements SSOFlow {
  private config: SSOCredentials;

  constructor(config: SSOCredentials) {
    this.config = config;
  }

  /** True if the configured Brightspace instance is TU Delft's. */
  static matches(baseUrl: string): boolean {
    try {
      const hostname = new URL(baseUrl).hostname;
      return hostname === "tudelft.nl" || hostname.endsWith(".tudelft.nl");
    } catch {
      return false;
    }
  }

  hasCredentials(): boolean {
    return Boolean(this.config.username && this.config.password);
  }

  async login(page: Page): Promise<boolean> {
    try {
      log("INFO", "Starting TU Delft SSO login flow (login.tudelft.nl via SURFconext)");

      if (!this.config.username || !this.config.password) {
        throw new BrowserAuthError(
          "Username and password are required for TU Delft SSO login",
          "credentials"
        );
      }

      // Ride the redirect chain to the SimpleSAMLphp login form
      await page.waitForURL(IDP_URL_PATTERN, { timeout: 30000 });
      await page.waitForSelector(SELECTORS.usernameInput, { timeout: 20000 });

      log("INFO", "Entering NetID credentials");
      await page.fill(SELECTORS.usernameInput, this.config.username);
      await page.fill(SELECTORS.passwordInput, this.config.password);
      await page.click(SELECTORS.submitButton);

      // Success navigates back to Brightspace home; failure re-renders the
      // form with an error box. Swallow each waiter's own timeout so the
      // loser doesn't surface an unhandled rejection after the race.
      const outcome = await Promise.race([
        page
          .waitForURL(/\/d2l\/home/, { timeout: 90000 })
          .then(() => "home" as const)
          .catch(() => null),
        page
          .waitForSelector(SELECTORS.errorMessage, { state: "visible", timeout: 90000 })
          .then(() => "error" as const)
          .catch(() => null),
      ]);

      if (outcome === "home") {
        log("INFO", "Login successful - reached Brightspace home");
        return true;
      }

      if (outcome === "error") {
        log("ERROR", "TU Delft SSO rejected the credentials (incorrect username or password)");
        return false;
      }

      log("WARN", `TU Delft SSO login timed out — last URL: ${page.url()}`);
      return false;
    } catch (error) {
      log("ERROR", "TU Delft SSO login flow failed", error);
      return false;
    }
  }

  async manualLogin(page: Page): Promise<boolean> {
    try {
      log("INFO", "Starting manual login flow for TU Delft");
      log("INFO", "Please log in with your NetID in the browser window that just opened.");
      log("INFO", "Waiting up to 5 minutes for you to complete login...");

      await page.waitForURL(/\/d2l\/home/, { timeout: 300000 });
      log("INFO", "Manual login successful - reached Brightspace home");
      return true;
    } catch (error) {
      log("ERROR", "Manual login flow failed or timed out", error);
      return false;
    }
  }
}
