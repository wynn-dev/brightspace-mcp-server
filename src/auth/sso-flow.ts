/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { Page } from "playwright";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";

const MANUAL_LOGIN_TIMEOUT_MS = 300000;

export interface SSOCredentials {
  username?: string;
  password?: string;
}

/**
 * Thrown by SSOFlow.login() when the identity provider explicitly rejected the
 * configured username/password. BrowserAuth treats this as fatal and skips the
 * manual-login fallback: waiting for the user can't fix a wrong stored password.
 */
export class CredentialsRejectedError extends BrowserAuthError {
  constructor(message: string) {
    super(message, "credentials");
    this.name = "CredentialsRejectedError";
  }
}

/**
 * Institution-specific SSO login strategy driven by BrowserAuth.
 * Implementations automate the redirect chain from the Brightspace login
 * page through the institution's identity provider and back to /d2l/home.
 */
export interface SSOFlow {
  /** One-line hint printed by the auth CLI before login starts (MFA instructions etc). */
  readonly loginHint: string;

  /** True if credentials are available for automated login. */
  hasCredentials(): boolean;

  /**
   * Automated login. The page has already been redirected away from /d2l/home.
   * Returns true once /d2l/home is reached, false on timeout/failure
   * (BrowserAuth then falls back to manualLogin). Throws
   * CredentialsRejectedError when the IdP rejected the stored credentials.
   */
  login(page: Page): Promise<boolean>;

  /**
   * Manual fallback: the user completes login in the headed browser while
   * we wait for /d2l/home.
   */
  manualLogin(page: Page): Promise<boolean>;
}

export abstract class BaseSSOFlow implements SSOFlow {
  abstract readonly loginHint: string;
  protected readonly credentials: SSOCredentials;

  constructor(credentials: SSOCredentials) {
    this.credentials = credentials;
  }

  hasCredentials(): boolean {
    return Boolean(this.credentials.username && this.credentials.password);
  }

  abstract login(page: Page): Promise<boolean>;

  async manualLogin(page: Page): Promise<boolean> {
    try {
      log("INFO", "Please log in using the browser window that just opened.");
      await this.prepareManualLogin(page);

      log("INFO", "Waiting up to 5 minutes for you to complete login...");
      await page.waitForURL(/\/d2l\/home/, { timeout: MANUAL_LOGIN_TIMEOUT_MS });
      log("INFO", "Manual login successful - reached Brightspace home");
      return true;
    } catch (error) {
      log("ERROR", "Manual login flow failed or timed out", error);
      return false;
    }
  }

  /**
   * Hook for institutions whose login page starts with a chooser screen the
   * user shouldn't have to click through (e.g. Purdue's campus selector).
   */
  protected async prepareManualLogin(_page: Page): Promise<void> {}

  protected requireCredentials(): { username: string; password: string } {
    const { username, password } = this.credentials;
    if (!username || !password) {
      throw new BrowserAuthError(
        "Username and password are required for automated SSO login",
        "credentials"
      );
    }
    return { username, password };
  }
}

/**
 * Race several Playwright waiters and report which one settled first.
 * Each waiter's own timeout rejection is swallowed so the losers never
 * surface as unhandled rejections after the race is decided. Returns null
 * if the first waiter to settle failed (i.e. everything timed out).
 */
export async function raceOutcomes<K extends string>(
  waiters: Record<K, Promise<unknown>>
): Promise<K | null> {
  const entries = Object.entries(waiters) as Array<[K, Promise<unknown>]>;
  return Promise.race(
    entries.map(([key, waiter]) => waiter.then(() => key).catch(() => null))
  );
}
