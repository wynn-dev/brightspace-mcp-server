/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { Page } from "playwright";

export interface SSOCredentials {
  username?: string;
  password?: string;
}

/**
 * Institution-specific SSO login strategy driven by BrowserAuth.
 * Implementations automate the redirect chain from the Brightspace login
 * page through the institution's identity provider and back to /d2l/home.
 */
export interface SSOFlow {
  /** True if credentials are available for automated login. */
  hasCredentials(): boolean;

  /**
   * Automated login. The page has already been redirected away from /d2l/home.
   * Returns true once /d2l/home is reached, false on timeout/failure
   * (BrowserAuth then falls back to manualLogin).
   */
  login(page: Page): Promise<boolean>;

  /**
   * Manual fallback: the user completes login in the headed browser while
   * we wait for /d2l/home.
   */
  manualLogin(page: Page): Promise<boolean>;
}
