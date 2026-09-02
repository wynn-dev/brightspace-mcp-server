/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { chromium } from "playwright";
import type { BrowserContext, Page, Request } from "playwright";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import type { AppConfig, TokenData } from "../types/index.js";
import { BrowserAuthError } from "../utils/errors.js";
import { log } from "../utils/logger.js";
import { PurdueSSOFlow } from "./purdue-sso.js";
import { TUDelftSSOFlow } from "./tudelft-sso.js";
import { CredentialsRejectedError } from "./sso-flow.js";
import type { SSOFlow } from "./sso-flow.js";

interface TokenInterception {
  promise: Promise<string>;
  cancel: () => void;
}

/** Cheapest authenticated endpoint; used to probe sessions and validate tokens. */
const WHOAMI_PATH = "/d2l/api/lp/1.45/users/whoami";

/** Quarantined browser profiles only matter for a post-mortem; drop them after a week. */
const QUARANTINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class BrowserAuth {
  private config: AppConfig;
  private ssoFlow: SSOFlow;

  constructor(config: AppConfig) {
    this.config = config;
    const credentials = {
      username: config.username,
      password: config.password,
    };
    this.ssoFlow = TUDelftSSOFlow.matches(config.baseUrl)
      ? new TUDelftSSOFlow(credentials)
      : new PurdueSSOFlow(credentials);
  }

  /** Institution-specific instruction shown to the user before login starts. */
  get loginHint(): string {
    return this.ssoFlow.loginHint;
  }

  /**
   * Detect if running inside WSL (Windows Subsystem for Linux) or Docker.
   * These environments require --no-sandbox for Chromium to launch.
   */
  private static isWSLOrDocker(): boolean {
    try {
      // WSL: /proc/version contains "microsoft" or "WSL"
      const procVersion = require("node:fs").readFileSync("/proc/version", "utf-8");
      if (/microsoft|wsl/i.test(procVersion)) return true;
    } catch {
      // Not Linux or /proc not available
    }
    try {
      // Docker: /.dockerenv exists or /proc/1/cgroup contains "docker"
      require("node:fs").accessSync("/.dockerenv");
      return true;
    } catch {
      // Not Docker
    }
    try {
      const cgroup = require("node:fs").readFileSync("/proc/1/cgroup", "utf-8");
      if (cgroup.includes("docker") || cgroup.includes("containerd")) return true;
    } catch {
      // Not in a container
    }
    return false;
  }

  /**
   * Build Chromium launch args based on the current platform and environment.
   */
  private static buildChromiumArgs(): string[] {
    const args = ["--disable-blink-features=AutomationControlled"];

    // On macOS, NSPersistentUIRestorer is disabled via `defaults write` in
    // applyMacOSCrashGuard() — see issue #10. Passing "-ApplePersistenceIgnoreState YES"
    // as argv doesn't work here because Playwright's launchPersistentContext rejects
    // non-flag positional arguments.

    if (BrowserAuth.isWSLOrDocker()) {
      args.push("--no-sandbox", "--disable-setuid-sandbox");
      log("INFO", "Detected WSL/Docker environment — launching Chromium with --no-sandbox");
    }

    return args;
  }

  /**
   * Prevent Chrome for Testing from SIGTRAP'ing on launch on macOS (issue #10).
   *
   * Three layers, all idempotent and cheap:
   *   1. ApplePersistenceIgnoreState — disables NSPersistentUIRestorer's crash-prompt
   *      modal, which Chrome for Testing's AppKit bridge cannot handle.
   *   2. IIO_LaunchInfo=0 — resets LaunchServices' per-app crash counter so macOS
   *      stops triggering the recovery pathway in the first place.
   *   3. Nuke the Cocoa saved-application-state bundle — if it exists, AppKit tries
   *      to replay window state during launch and can crash the browser process.
   *
   * Runs before every launch. None of these are destructive to user data; Chrome
   * for Testing is a disposable test profile.
   */
  private static async applyMacOSCrashGuard(): Promise<void> {
    if (process.platform !== "darwin") return;

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    try {
      await execFileAsync("defaults", [
        "write",
        "com.google.chrome.for.testing",
        "ApplePersistenceIgnoreState",
        "-bool",
        "yes",
      ]);
    } catch {
      // Non-fatal
    }

    try {
      await execFileAsync("defaults", [
        "write",
        "com.google.chrome.for.testing",
        "IIO_LaunchInfo",
        "-int",
        "0",
      ]);
    } catch {
      // Non-fatal
    }

    try {
      const savedState = path.join(
        os.homedir(),
        "Library",
        "Saved Application State",
        "com.google.chrome.for.testing.savedState"
      );
      await fs.rm(savedState, { recursive: true, force: true });
    } catch {
      // Non-fatal
    }

    log("DEBUG", "Applied macOS crash guards for Chrome for Testing");
  }

  /**
   * Recovery step: the current browser-data profile is corrupted in a way that
   * makes Chromium SIGTRAP during launch (issue #10). Move it aside so the next
   * launch attempt gets a clean profile. Cheap — user just re-authenticates.
   */
  private async quarantineBrowserDataDir(browserDataDir: string): Promise<void> {
    try {
      const quarantined = `${browserDataDir}.corrupted.${Date.now()}`;
      await fs.rename(browserDataDir, quarantined);
      log(
        "WARN",
        `Quarantined corrupted browser profile to ${quarantined} — starting fresh`
      );
    } catch {
      // If rename fails (permissions, missing dir), try a recursive delete instead.
      try {
        await fs.rm(browserDataDir, { recursive: true, force: true });
        log("WARN", "Deleted corrupted browser profile — starting fresh");
      } catch (rmError) {
        log("WARN", "Failed to quarantine browser profile", rmError);
      }
    }
    await this.pruneQuarantinedProfiles(browserDataDir);
  }

  private async pruneQuarantinedProfiles(browserDataDir: string): Promise<void> {
    const dir = path.dirname(browserDataDir);
    const prefix = `${path.basename(browserDataDir)}.corrupted.`;
    const cutoff = Date.now() - QUARANTINE_RETENTION_MS;
    try {
      for (const entry of await fs.readdir(dir)) {
        if (!entry.startsWith(prefix)) continue;
        const stamp = Number(entry.slice(prefix.length));
        if (Number.isFinite(stamp) && stamp < cutoff) {
          await fs.rm(path.join(dir, entry), { recursive: true, force: true });
          log("DEBUG", `Removed old quarantined profile ${entry}`);
        }
      }
    } catch (error) {
      log("DEBUG", "Could not prune quarantined profiles", error);
    }
  }

  async authenticate(): Promise<TokenData> {
    let context: BrowserContext | null = null;
    const interceptions: TokenInterception[] = [];
    let cleanShutdown: ((signal: NodeJS.Signals) => void) | null = null;

    try {
      log("INFO", "Starting browser authentication");

      await BrowserAuth.applyMacOSCrashGuard();

      await fs.mkdir(this.config.sessionDir, { recursive: true, mode: 0o700 });

      const browserDataDir = path.join(this.config.sessionDir, "browser-data");

      // Force headed mode when no credentials — user must interact with the browser
      const headless = this.ssoFlow.hasCredentials() ? this.config.headless : false;
      if (!this.ssoFlow.hasCredentials() && this.config.headless) {
        log("INFO", "Overriding headless mode — browser must be visible for manual login");
      }

      const launchOptions = {
        headless,
        viewport: { width: 1280, height: 720 } as const,
        args: BrowserAuth.buildChromiumArgs(),
        timeout: 60000,
      };

      context = await this.launchBrowserWithRetry(browserDataDir, launchOptions);

      log("INFO", "Browser context launched");

      // If the user Ctrl+C's while Chrome is running, Node tears down the
      // subprocess with SIGKILL — Chrome writes "Crashed" to exit_type, the
      // LaunchServices crash counter ticks up, and the next launch can SIGTRAP.
      // Hook SIGINT/SIGTERM so we close the context gracefully first. See issue #10.
      const contextRef = context;
      cleanShutdown = (signal: NodeJS.Signals) => {
        log("WARN", `Received ${signal} — closing browser cleanly`);
        contextRef
          .close()
          .catch(() => {
            // Already closing
          })
          .finally(() => process.exit(130));
      };
      process.once("SIGINT", cleanShutdown);
      process.once("SIGTERM", cleanShutdown);

      // Load saved storage state if it exists (cookies + localStorage)
      // This works around Playwright bug #36139 where session cookies don't persist
      await this.loadStorageState(context);

      const page = context.pages()[0] || (await context.newPage());

      // CRITICAL: Set up token interception BEFORE navigation
      // Use longer timeout for manual login (5 min) vs automated SSO (2 min)
      const interceptTimeout = this.ssoFlow.hasCredentials() ? 120000 : 300000;
      const tokenInterception = this.setupTokenInterception(page, interceptTimeout);
      interceptions.push(tokenInterception);

      // Navigate and login if needed
      const alreadyAuthenticated = await this.navigateAndLogin(page);

      // Run the extraction strategy chain on BOTH paths. Modern Brightspace's
      // /d2l/home uses cookie auth and emits no Bearer header, so the passive
      // interceptor never fires on a fresh manual login — the chain rescues
      // us via localStorage instead. See issue #10.
      log("INFO", alreadyAuthenticated
        ? "Session cookies active — trying to extract API token"
        : "Login complete — extracting API token from session");

      const extracted = await this.tryExtractToken(page);
      if (extracted) {
        await this.saveStorageState(context);
        log("INFO", "Authentication complete");
        return extracted;
      }

      // Last resort for the cookie-restore path: clear cookies, force full
      // re-login through SSO, and race the passive listener as a final fallback.
      if (alreadyAuthenticated) {
        log("WARN", "Could not extract valid token from existing session, forcing re-login");
        await context.clearCookies();
        await page.close();
        const freshPage = await context.newPage();
        const freshInterception = this.setupTokenInterception(freshPage);
        interceptions.push(freshInterception);
        await this.navigateAndLogin(freshPage);

        const freshExtracted = await this.tryExtractToken(freshPage);
        if (freshExtracted) {
          await this.saveStorageState(context);
          log("INFO", "Authentication complete");
          return freshExtracted;
        }

        const accessToken = await freshInterception.promise;
        log("INFO", "Bearer token captured after forced re-login");
        const now = Date.now();
        const tokenData: TokenData = {
          accessToken,
          capturedAt: now,
          expiresAt: now + this.config.tokenTtl * 1000,
          source: "browser",
        };
        await this.saveStorageState(context);
        return tokenData;
      }

      // Fresh-login final fallback: wait on the passive listener.
      // Rarely reached in practice — tryExtractToken typically hits localStorage first.
      log("INFO", "Waiting for Bearer token from network interception");
      const accessToken = await tokenInterception.promise;
      log("INFO", "Bearer token captured successfully");

      const now = Date.now();
      const tokenData: TokenData = {
        accessToken,
        capturedAt: now,
        expiresAt: now + this.config.tokenTtl * 1000,
        source: "browser",
      };

      await this.saveStorageState(context);
      log("INFO", "Authentication complete");
      return tokenData;
    } catch (error) {
      log("ERROR", "Browser authentication failed", error);

      // The IdP rejected the stored credentials — surface that verbatim
      // instead of burying it under a generic "Authentication failed".
      if (error instanceof CredentialsRejectedError) throw error;

      const errMsg = error instanceof Error ? error.message : String(error);

      let hint = "";
      if (BrowserAuth.isWSLOrDocker() && (errMsg.includes("spawn") || errMsg.includes("ENOENT") || errMsg.includes("sandbox"))) {
        hint = " (WSL/Docker hint: ensure Chromium dependencies are installed. Run: pnpm run playwright:deps)";
      }

      throw new BrowserAuthError(
        `Authentication failed${hint}`,
        "authenticate",
        error as Error
      );
    } finally {
      for (const interception of interceptions) interception.cancel();
      if (cleanShutdown) {
        process.off("SIGINT", cleanShutdown);
        process.off("SIGTERM", cleanShutdown);
      }
      if (context) {
        log("DEBUG", "Closing browser context");
        try {
          await context.close();
        } catch (closeError) {
          // Context may already be closed (e.g. browser crashed or was closed externally)
          log("DEBUG", "Browser context already closed or failed to close", closeError);
        }
      }
    }
  }

  /**
   * Read D2L's Bearer token out of the page's localStorage, nudging the API
   * once if it isn't there yet. Each candidate is validated against
   * /users/whoami before being returned. Returns null if both attempts fail.
   */
  private async tryExtractToken(page: Page): Promise<TokenData | null> {
    const build = (token: string): TokenData => {
      const now = Date.now();
      return {
        accessToken: token,
        capturedAt: now,
        expiresAt: now + this.config.tokenTtl * 1000,
        source: "browser",
      };
    };

    // Strategy 0: localStorage (D2L.Fetch.Tokens) — fastest
    const lsToken = await this.extractLocalStorageToken(page);
    if (lsToken && (await this.validateToken(lsToken))) {
      log("INFO", "Extracted valid Bearer token from localStorage");
      return build(lsToken);
    }
    if (lsToken) log("WARN", "localStorage Bearer token failed validation, trying next strategy");

    // Strategy 1: Force a Bearer fetch by hitting the API, then re-check localStorage
    try {
      log("DEBUG", "Navigating to API endpoint to trigger token capture");
      await page.goto(
        `${this.config.baseUrl}${WHOAMI_PATH}`,
        { waitUntil: "load", timeout: 15000 }
      );
      const lsToken2 = await this.extractLocalStorageToken(page);
      if (lsToken2 && (await this.validateToken(lsToken2))) {
        log("INFO", "Extracted valid Bearer token from localStorage after API nudge");
        return build(lsToken2);
      }
    } catch {
      log("DEBUG", "Direct API navigation did not produce Bearer token");
    }

    return null;
  }

  /**
   * Validate a token by making a test API call to /users/whoami.
   * Returns true if the token is accepted by D2L, false otherwise.
   */
  private async validateToken(token: string): Promise<boolean> {
    try {
      const headers: Record<string, string> = {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Authorization: `Bearer ${token}`,
      };

      const response = await fetch(
        `${this.config.baseUrl}${WHOAMI_PATH}`,
        {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(10000),
        }
      );

      if (response.ok) {
        log("DEBUG", "Token validation succeeded (whoami returned 200)");
        return true;
      }

      log("DEBUG", `Token validation failed: HTTP ${response.status}`);
      return false;
    } catch (error) {
      log("DEBUG", "Token validation error", error);
      return false;
    }
  }

  /**
   * Set up passive network request listener to capture Bearer token.
   * MUST be called BEFORE page.goto() to avoid race condition.
   *
   * The returned promise is pre-handled: if its timer fires while the caller
   * is still busy with a long login, the rejection is not "unhandled" (which
   * would kill the process); awaiting it later still throws. cancel() stops
   * the timer and listener once a token was obtained some other way.
   */
  private setupTokenInterception(page: Page, timeoutMs = 120000): TokenInterception {
    let timeout: NodeJS.Timeout | undefined;
    let onRequest: ((request: Request) => void) | undefined;

    const promise = new Promise<string>((resolve, reject) => {
      timeout = setTimeout(() => {
        reject(
          new BrowserAuthError(
            `Token interception timed out after ${timeoutMs / 1000} seconds`,
            "token_interception"
          )
        );
      }, timeoutMs);

      onRequest = (request) => {
        const url = request.url();

        // Look for any request with a Bearer token
        if (url.includes("/d2l/")) {
          const authHeader = request.headers()["authorization"];

          if (authHeader && authHeader.startsWith("Bearer ")) {
            const token = authHeader.substring("Bearer ".length);
            log("DEBUG", `Token captured from request to ${url}`);
            clearTimeout(timeout);
            resolve(token);
          }
        }
      };
      page.on("request", onRequest);

      log("DEBUG", "Token interception listener registered");
    });
    promise.catch(() => {});

    return {
      promise,
      cancel: () => {
        clearTimeout(timeout);
        if (onRequest) {
          try {
            page.off("request", onRequest);
          } catch {
            // Page already closed
          }
        }
      },
    };
  }

  /**
   * Navigate to Brightspace and login if needed.
   * Returns true if already authenticated (cookies valid), false if SSO login was performed.
   */
  private async navigateAndLogin(page: Page): Promise<boolean> {
    try {
      log("INFO", `Navigating to ${this.config.baseUrl}/d2l/home`);
      await page.goto(`${this.config.baseUrl}/d2l/home`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      log("DEBUG", `Current URL after navigation: ${page.url()}`);

      // Ask D2L directly whether the browser's cookies carry a live session
      // rather than inferring it from the URL, which lies in both directions:
      // some tenants (USC) bounce a valid session through SAML hops before
      // landing on /d2l/home, others (TU Delft) serve anonymous /d2l/home as
      // an HTTP 200 stub that only client-side redirects to /d2l/login.
      const authenticated = await this.hasLiveSession(page);

      if (authenticated) {
        log("INFO", "Already authenticated - skipping SSO login");
        // Let any SAML hop settle so token extraction sees a rendered /d2l/home
        if (!page.url().includes("/d2l/home")) {
          try {
            await page.waitForURL(/\/d2l\/home/, { timeout: 15000 });
            log("DEBUG", "Redirect chain settled on /d2l/home");
          } catch {
            // Extraction navigates to /d2l/home itself if needed
          }
        }
        await this.settleDom(page);
        return true;
      }

      // Login required. If the anonymous stub is still showing /d2l/home, give
      // its client-side redirect a moment to leave so the SSO flow can't
      // mistake the stale URL for a completed login.
      if (page.url().includes("/d2l/home")) {
        try {
          await page.waitForURL((url) => !url.toString().includes("/d2l/home"), {
            timeout: 15000,
          });
        } catch {
          log("DEBUG", "No redirect away from /d2l/home — starting SSO flow in place");
        }
      }

      let loginSuccess: boolean;

      if (this.ssoFlow.hasCredentials()) {
        log("INFO", `Login required (at ${page.url()}) - starting SSO flow`);
        // CredentialsRejectedError propagates: a wrong stored password can't
        // be fixed by waiting for the user, so there is no manual fallback.
        loginSuccess = await this.ssoFlow.login(page);

        if (!loginSuccess) {
          if (this.config.headless) {
            throw new BrowserAuthError(
              "Automated SSO login failed and the browser is headless, so manual login is impossible. Re-run with D2L_HEADLESS=false to log in by hand.",
              "sso_login"
            );
          }
          log("WARN", "Automated SSO flow failed or timed out. Falling back to manual login.");
          loginSuccess = await this.ssoFlow.manualLogin(page);
        }
      } else {
        log("INFO", `Login required (at ${page.url()}) - opening browser for manual login`);
        loginSuccess = await this.ssoFlow.manualLogin(page);
      }

      if (!loginSuccess) {
        throw new BrowserAuthError("Manual login flow failed", "manual_login");
      }

      await this.settleDom(page);
      return false;
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      throw new BrowserAuthError(
        "Failed to navigate and login",
        "navigate_login",
        error as Error
      );
    }
  }

  /**
   * Probe /users/whoami through the page's request context, which shares the
   * browser's cookie jar: a live D2L session answers 200, anything else 403.
   */
  private async hasLiveSession(page: Page): Promise<boolean> {
    try {
      const response = await page.request.get(
        `${this.config.baseUrl}${WHOAMI_PATH}`,
        { maxRedirects: 0, timeout: 15000 }
      );
      log("DEBUG", `Session probe (whoami) returned HTTP ${response.status()}`);
      return response.ok();
    } catch (error) {
      // Probe failed outright (network hiccup) — fall back to reading the
      // URL once the page has finished loading.
      log("WARN", "Session probe failed — falling back to URL check", error);
      await this.settleDom(page);
      return page.url().includes("/d2l/home");
    }
  }

  private async settleDom(page: Page): Promise<void> {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 });
    } catch {
      log("DEBUG", "Page wait timed out, proceeding anyway");
    }
  }

  /**
   * Try to extract Bearer token from D2L's localStorage.
   * D2L stores API tokens in localStorage under "D2L.Fetch.Tokens".
   */
  private async extractLocalStorageToken(page: Page): Promise<string | null> {
    try {
      // Navigate to Brightspace home if not already there
      const currentUrl = page.url();
      if (!currentUrl.includes("/d2l/home")) {
        await page.goto(`${this.config.baseUrl}/d2l/home`, {
          waitUntil: "networkidle",
          timeout: 15000,
        });
      }

      const token = await page.evaluate(() => {
        try {
          const tokensJson = localStorage.getItem("D2L.Fetch.Tokens");
          if (!tokensJson) return null;

          const tokens = JSON.parse(tokensJson);
          // Tokens are stored as { "*:*:*": { access_token: "...", expires_at: ... } }
          const wildcardToken = tokens["*:*:*"];
          if (wildcardToken && wildcardToken.access_token) {
            return wildcardToken.access_token;
          }

          return null;
        } catch {
          return null;
        }
      });

      if (token) {
        log("DEBUG", "Found Bearer token in localStorage (D2L.Fetch.Tokens)");
        return token;
      }

      return null;
    } catch (error) {
      log("DEBUG", "localStorage token extraction failed", error);
      return null;
    }
  }

  /**
   * Load previously saved storage state (cookies + localStorage).
   * Workaround for Playwright bug #36139: session cookies don't persist in persistent context.
   */
  private async loadStorageState(context: BrowserContext): Promise<void> {
    try {
      const storageStatePath = path.join(
        this.config.sessionDir,
        "storage-state.json"
      );

      // Check if storage state file exists
      let stats: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stats = await fs.stat(storageStatePath);
      } catch {
        log("DEBUG", "No existing storage state to load");
        return;
      }

      // Skip loading stale cookies that would fake "already authenticated"
      const ageMs = Date.now() - stats.mtimeMs;
      const maxAgeMs = this.config.tokenTtl * 1000;
      if (ageMs > maxAgeMs) {
        log("INFO", `Storage state is ${Math.round(ageMs / 60000)}min old (TTL ${this.config.tokenTtl}s) — skipping stale cookies`);
        return;
      }

      // Read storage state
      const stateJson = await fs.readFile(storageStatePath, "utf-8");
      const state = JSON.parse(stateJson) as {
        cookies: Array<{
          name: string;
          value: string;
          domain: string;
          path: string;
          expires: number;
          httpOnly: boolean;
          secure: boolean;
          sameSite: "Strict" | "Lax" | "None";
        }>;
        origins: Array<{
          origin: string;
          localStorage: Array<{ name: string; value: string }>;
        }>;
      };

      // Restore cookies
      if (state.cookies && state.cookies.length > 0) {
        await context.addCookies(state.cookies);
        log(
          "INFO",
          `Restored ${state.cookies.length} cookies from storage state`
        );
      }

      // Restore localStorage for each origin
      if (state.origins && state.origins.length > 0) {
        for (const origin of state.origins) {
          if (origin.localStorage && origin.localStorage.length > 0) {
            let tempPage: Page | null = null;
            try {
              // Create a temporary page to set localStorage
              tempPage = await context.newPage();
              await tempPage.goto(origin.origin, { timeout: 10000 });

              // Set each localStorage item
              await tempPage.evaluate((items) => {
                for (const item of items) {
                  localStorage.setItem(item.name, item.value);
                }
              }, origin.localStorage);

              log(
                "INFO",
                `Restored ${origin.localStorage.length} localStorage items for ${origin.origin}`
              );
            } catch (originError) {
              log("WARN", `Failed to restore localStorage for ${origin.origin}`, originError);
            } finally {
              if (tempPage) {
                try {
                  await tempPage.close();
                } catch {
                  // Page may already be closed
                }
              }
            }
          }
        }
      }

      log("INFO", "Storage state restored successfully");
    } catch (error) {
      log("WARN", "Failed to load storage state", error);
    }
  }

  private async saveStorageState(context: BrowserContext): Promise<void> {
    try {
      const storageStatePath = path.join(
        this.config.sessionDir,
        "storage-state.json"
      );
      await context.storageState({ path: storageStatePath });
      await fs.chmod(storageStatePath, 0o600);
      log("DEBUG", `Storage state saved to ${storageStatePath}`);
    } catch (error) {
      log("WARN", "Failed to save storage state", error);
    }
  }

  /**
   * Launch browser with retry logic.
   * Launch can hang on lingering Chromium processes or a stale SingletonLock
   * (Playwright issue #22117). On timeout, we clear lock files and retry once.
   */
  private async launchBrowserWithRetry(
    browserDataDir: string,
    options: {
      headless: boolean;
      viewport: { readonly width: number; readonly height: number };
      args: string[];
      timeout: number;
    }
  ): Promise<BrowserContext> {
    // Validate lock files before every launch attempt
    await this.validateAndClearLockFiles(browserDataDir);

    let timer: NodeJS.Timeout | undefined;
    let abandoned = false;
    // Wrap in Promise.race so a hung launch (e.g. stale SingletonLock
    // that wasn't caught) still falls into the retry path
    const launchPromise = chromium.launchPersistentContext(browserDataDir, options);
    // If the launch loses the race but completes later, it must not leave a
    // second live context on the same profile behind the retry.
    launchPromise.then(
      (ctx) => {
        if (abandoned) ctx.close().catch(() => {});
      },
      () => {
        // Surfaced through the race below
      }
    );

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timeout: browser launch hung")), options.timeout);
      });
      return await Promise.race([launchPromise, timeoutPromise]);
    } catch (error) {
      abandoned = true;
      const errMsg = error instanceof Error ? error.message : String(error);
      const isTimeout = errMsg.includes("Timeout") || errMsg.includes("timeout") || errMsg.includes("hung");

      // macOS: Chrome for Testing died during launch with SIGTRAP / browser
      // closed. The profile is likely corrupted from prior crashes. Quarantine
      // it, reapply the crash guards, and retry with a fresh profile.
      // See issue #10.
      const isMacBrowserCrash =
        process.platform === "darwin" &&
        (errMsg.includes("Target page, context or browser has been closed") ||
          errMsg.includes("SIGTRAP") ||
          errMsg.includes("did exit"));

      if (isMacBrowserCrash) {
        log(
          "WARN",
          "Chrome for Testing crashed during launch — quarantining profile and retrying"
        );
        await this.quarantineBrowserDataDir(browserDataDir);
        await BrowserAuth.applyMacOSCrashGuard();
        return await chromium.launchPersistentContext(browserDataDir, {
          ...options,
          timeout: 90000,
        });
      }

      if (isTimeout) {
        log("WARN", "Browser launch timed out — clearing lock files and retrying");
        await this.validateAndClearLockFiles(browserDataDir);
        return await chromium.launchPersistentContext(browserDataDir, {
          ...options,
          timeout: 90000,
        });
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Validate and remove stale Chromium lock files from the browser data directory.
   * Playwright's persistent context uses Chromium's SingletonLock mechanism.
   * If the browser is killed unexpectedly (antivirus, force close, crash),
   * these lock files persist and block all future launch attempts.
   *
   * For SingletonLock (a symlink whose target is "hostname-pid"), we check
   * whether the owning process is still alive before removing it. This avoids
   * deleting a lock held by a legitimate running instance.
   */
  private async validateAndClearLockFiles(browserDataDir: string): Promise<void> {
    // Ensure the directory exists before scanning
    try {
      await fs.access(browserDataDir);
    } catch {
      return; // Directory doesn't exist yet, nothing to clean
    }

    const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
    for (const lockFile of lockFiles) {
      const lockPath = path.join(browserDataDir, lockFile);
      try {
        const stat = await fs.lstat(lockPath);

        if (stat.isSymbolicLink() && lockFile === "SingletonLock") {
          // SingletonLock is a symlink with target "hostname-pid"
          const target = await fs.readlink(lockPath);
          const dashIdx = target.lastIndexOf("-");
          if (dashIdx > 0) {
            const lockHostname = target.substring(0, dashIdx);
            const lockPid = parseInt(target.substring(dashIdx + 1), 10);

            if (lockHostname !== os.hostname()) {
              // Lock from a different machine (e.g. NFS home dir, or stale after network change)
              log("WARN", `Removing SingletonLock from different host (${lockHostname} vs ${os.hostname()})`);
              await fs.unlink(lockPath);
              continue;
            }

            if (!isNaN(lockPid)) {
              try {
                process.kill(lockPid, 0); // Signal 0 checks if process exists
                // Process is alive, leave the lock alone
                log("DEBUG", `SingletonLock held by live process ${lockPid}, skipping`);
                continue;
              } catch (killErr: unknown) {
                const code = (killErr as NodeJS.ErrnoException).code;
                if (code === "ESRCH") {
                  // Process is dead, safe to remove
                  log("WARN", `Removing SingletonLock from dead process ${lockPid}`);
                  await fs.unlink(lockPath);
                  continue;
                }
                if (code === "EPERM") {
                  // Process exists but we lack permissions, leave it alone
                  log("DEBUG", `SingletonLock held by process ${lockPid} (EPERM), skipping`);
                  continue;
                }
              }
            }
          }

          // Could not parse target, remove as a safety measure
          log("WARN", `Removing unparseable SingletonLock: ${target}`);
          await fs.unlink(lockPath);
        } else {
          // Regular file (SingletonCookie, SingletonSocket) or unknown symlink
          await fs.unlink(lockPath);
          log("WARN", `Removed stale lock file: ${lockFile}`);
        }
      } catch {
        // File doesn't exist, expected in normal operation
      }
    }
  }
}
