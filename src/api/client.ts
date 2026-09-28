/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { D2LApiClientOptions, ApiVersions, TokenData } from "./types.js";
import { TTLCache } from "./cache.js";
import { TokenBucket } from "./rate-limiter.js";
import { discoverVersions, readCachedVersions, writeCachedVersions } from "./version-discovery.js";
import { ApiError, AuthUnavailableError, RateLimitError, NetworkError } from "./errors.js";
import { log } from "../utils/logger.js";
import { recordRead, errorState, countRead } from "../utils/read-status.js";

const MAX_RETRY_AFTER_SECONDS = 10;

/** Waits between version-discovery attempts during startup (kept short: stdio clients are waiting). */
const STARTUP_DISCOVERY_RETRY_MS = [1000, 3000];
/** Background re-discovery backoff after startup discovery failed. */
const REDISCOVERY_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * D2L API client with authentication, caching, rate limiting, and version discovery.
 *
 * Key features:
 * - Auto-discovers LP/LE versions from /d2l/api/versions/
 * - Client-side rate limiting using token bucket algorithm
 * - In-memory response caching with per-data-type TTLs
 * - 401 retry logic: retry once with fresh token, then clear and throw
 * - HTTPS-only enforcement
 * - Browser-like User-Agent for requests
 * - Raw response passthrough (no transformation)
 */
export class D2LApiClient {
  private readonly baseUrl: string;
  private readonly tokenManager: D2LApiClientOptions["tokenManager"];
  private readonly cache: TTLCache;
  private readonly rateLimiter: TokenBucket;
  private readonly timeoutMs: number;
  private readonly onAuthExpired?: () => Promise<boolean>;
  private readonly describeAuthFailure?: () => Promise<string | null>;
  private readonly versionCacheDir?: string;
  private versions: ApiVersions | null = null;
  /** Startup discovery failed; requests report Brightspace as unreachable until it succeeds. */
  private discoveryFailed = false;
  private rediscoveryTimer: NodeJS.Timeout | null = null;
  private authRecovery: Promise<TokenData> | null = null;

  constructor(options: D2LApiClientOptions) {
    // HTTPS-only enforcement
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "https:") {
      throw new Error(
        "HTTPS is required for D2L API client. HTTP URLs are not allowed for security reasons.",
      );
    }

    // Strip trailing slash from baseUrl
    this.baseUrl = baseUrl.href.replace(/\/$/, "");
    this.tokenManager = options.tokenManager;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.onAuthExpired = options.onAuthExpired;
    this.describeAuthFailure = options.describeAuthFailure;
    this.versionCacheDir = options.versionCacheDir;

    // Initialize cache and rate limiter
    this.cache = new TTLCache();
    // A 429 is retried once (see retryRateLimited), so the throttle can let
    // aggregate tools fan out without serializing on a few requests/sec.
    const rateLimitConfig = options.rateLimitConfig ?? {
      capacity: 20,
      refillRate: 10,
    };
    this.rateLimiter = new TokenBucket(
      rateLimitConfig.capacity,
      rateLimitConfig.refillRate,
    );

    log("DEBUG", `D2LApiClient initialized for ${this.baseUrl}`);
  }

  /**
   * Initialize the client by discovering API versions.
   * Must be called before making API requests.
   *
   * Never throws: if Brightspace is unreachable (maintenance, no network yet)
   * after a few quick retries, the last versions cached in versionCacheDir
   * are used, and discovery keeps retrying in the background. Without a cache,
   * requests fail with a NetworkError until discovery succeeds.
   */
  async initialize(): Promise<void> {
    try {
      await this.discover(STARTUP_DISCOVERY_RETRY_MS);
    } catch (error) {
      this.discoveryFailed = true;
      const cached = this.versionCacheDir
        ? await readCachedVersions(this.versionCacheDir, this.baseUrl)
        : null;
      if (cached) {
        this.versions = cached;
        log("WARN", `API version discovery failed — using last known versions LP ${cached.lp}, LE ${cached.le}`, error);
      } else {
        log("ERROR", "API version discovery failed and no cached versions exist — Brightspace requests will fail until it succeeds", error);
      }
      this.scheduleRediscovery(0);
    }
  }

  /** Discover versions (retrying after each delay), then cache them. */
  private async discover(retryDelaysMs: number[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        this.versions = await discoverVersions(this.baseUrl, this.timeoutMs);
        break;
      } catch (error) {
        if (attempt >= retryDelaysMs.length) throw error;
        log("WARN", `API version discovery failed; retrying in ${retryDelaysMs[attempt] / 1000}s`);
        await sleep(retryDelaysMs[attempt]);
      }
    }
    this.discoveryFailed = false;
    log(
      "INFO",
      `D2L API versions discovered: LP ${this.versions.lp}, LE ${this.versions.le}`,
    );
    if (this.versionCacheDir) await writeCachedVersions(this.versionCacheDir, this.baseUrl, this.versions);
  }

  private scheduleRediscovery(failures: number): void {
    const delay = REDISCOVERY_BACKOFF_MS[Math.min(failures, REDISCOVERY_BACKOFF_MS.length - 1)];
    this.rediscoveryTimer = setTimeout(() => {
      this.rediscoveryTimer = null;
      this.discover([]).catch((error) => {
        log("DEBUG", "Background API version discovery failed", error);
        this.scheduleRediscovery(failures + 1);
      });
    }, delay);
    this.rediscoveryTimer.unref();
  }

  /** Stop background work (version re-discovery). */
  dispose(): void {
    if (this.rediscoveryTimer) clearTimeout(this.rediscoveryTimer);
    this.rediscoveryTimer = null;
  }

  /**
   * Get discovered API versions.
   * @throws Error if initialize() hasn't been called yet
   * @throws NetworkError if discovery failed and no versions were cached
   */
  get apiVersions(): ApiVersions {
    if (!this.versions) {
      if (this.discoveryFailed) {
        throw new NetworkError(
          "Brightspace API versions are not known yet (discovery failed; retrying in the background)",
        );
      }
      throw new Error(
        "API client not initialized. Call initialize() before accessing apiVersions.",
      );
    }
    return this.versions;
  }

  /**
   * Make a GET request to the D2L API.
   *
   * @param path - API path (e.g., "/d2l/api/lp/1.56/users/whoami")
   * @param options - Request options (ttl for caching)
   * @returns Parsed JSON response (raw, no transformation)
   * @throws ApiError on HTTP errors (401, 403, 429, etc.)
   * @throws NetworkError on network/fetch failures
   */
  async get<T>(path: string, options?: { ttl?: number }): Promise<T> {
    const cached = !!options?.ttl && this.cache.has(path);
    const fetchedAt = cached ? this.cache.storedAt(path) : null;
    try {
      // Only network reads count toward the per-call budget.
      if (!cached) countRead();
      const data = await this.getJson<T>(path, options);
      recordRead(path, "available", fetchedAt ?? new Date().toISOString(), cached);
      return data;
    } catch (error) {
      recordRead(path, errorState(error));
      throw error;
    }
  }

  private async getJson<T>(path: string, options?: { ttl?: number }): Promise<T> {
    // Check cache first
    if (options?.ttl && this.cache.has(path)) {
      log("DEBUG", `Cache hit: ${path}`);
      return this.cache.get(path) as T;
    }

    // Enforce rate limit
    await this.rateLimiter.consume();

    // Get authentication token — auto-reauth if expired
    let token = await this.tokenManager.getToken();
    if (!token) {
      token = await this.recoverToken(path, null);
    }

    // Make request with retry logic
    return this.retryRateLimited(() => this.makeRequest<T>(path, token, options));
  }

  /**
   * Make a GET request to the D2L API and return raw Response object.
   * Used for binary file downloads where JSON parsing is not desired.
   * Does NOT cache responses (file downloads shouldn't be cached).
   *
   * @param path - API path (e.g., "/d2l/api/le/1.91/123456/content/topics/789/file")
   * @returns Raw Response object for binary data extraction
   * @throws ApiError on HTTP errors (401, 403, 429, etc.)
   * @throws NetworkError on network/fetch failures
   */
  async getRaw(path: string): Promise<Response> {
    try {
      countRead();
      const response = await this.getRawResponse(path);
      recordRead(path, "available", new Date().toISOString());
      return response;
    } catch (error) {
      recordRead(path, errorState(error));
      throw error;
    }
  }

  private async getRawResponse(path: string): Promise<Response> {
    // Enforce rate limit
    await this.rateLimiter.consume();

    // Get authentication token — auto-reauth if expired
    let token = await this.tokenManager.getToken();
    if (!token) {
      token = await this.recoverToken(path, null);
    }

    // Make request with retry logic
    return this.retryRateLimited(() => this.makeRawRequest(path, token));
  }

  /**
   * Retry once after a 429, honouring Retry-After (default 1s). Waits longer
   * than MAX_RETRY_AFTER_SECONDS surface as a RateLimitError instead of
   * stalling the tool call.
   */
  private async retryRateLimited<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof RateLimitError)) throw error;
      const waitSeconds = error.retryAfter ?? 1;
      if (!(waitSeconds >= 0 && waitSeconds <= MAX_RETRY_AFTER_SECONDS)) throw error;
      log("INFO", `Rate limited on ${error.endpoint}; retrying in ${waitSeconds}s`);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      await this.rateLimiter.consume();
      return request();
    }
  }

  /** Serialize invalidation with login so late 401s cannot erase a new session. */
  private recoverToken(path: string, rejected: TokenData | null, allowLogin = true): Promise<TokenData> {
    if (this.authRecovery) return this.authRecovery;
    this.authRecovery = (async () => {
      const current = await this.tokenManager.getToken();
      if (current && current.accessToken !== rejected?.accessToken) return current;
      if (rejected) {
        // Clears only the rejected token; another process may have saved a newer one
        await this.tokenManager.clearToken(rejected);
        const newer = await this.tokenManager.getToken();
        if (newer && newer.accessToken !== rejected.accessToken) return newer;
      }
      if (!allowLogin) throw new ApiError(401, path, "Refreshed session was rejected.");
      return this.tryAutoReauth(path);
    })().finally(() => { this.authRecovery = null; });
    return this.authRecovery;
  }

  /**
   * Attempt auto-reauthentication via the onAuthExpired callback.
   * If successful, returns the fresh token. Otherwise throws 401 ApiError.
   */
  private async tryAutoReauth(path: string): Promise<TokenData> {
    if (this.onAuthExpired) {
      log("INFO", "Attempting auto-reauthentication...");
      const success = await this.onAuthExpired();
      if (success) {
        const freshToken = await this.tokenManager.getToken();
        if (freshToken) {
          log("INFO", "Auto-reauthentication succeeded, retrying request");
          return freshToken;
        }
      }
      log("WARN", "Auto-reauthentication did not produce a valid token");
    }
    const reason = await this.describeAuthFailure?.().catch(() => null);
    if (reason) throw new AuthUnavailableError(path, reason);
    throw new ApiError(401, path, "Session expired. Please re-authenticate with `pnpm run auth`.");
  }

  /**
   * Internal method to make HTTP request with 401 retry logic.
   */
  private async makeRequest<T>(
    path: string,
    token: TokenData,
    options?: { ttl?: number },
    isRetry: boolean = false,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildAuthHeaders(token);

    try {
      log("DEBUG", `${isRetry ? "Retrying" : "Requesting"} GET ${path}`);

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // At most one retry per request; all readers share invalidation and login.
      if (response.status === 401) {
        await response.body?.cancel();
        const freshToken = await this.recoverToken(path, token, !isRetry);
        if (isRetry) throw new ApiError(401, path, "Refreshed session was rejected.");
        return await this.makeRequest<T>(path, freshToken, options, true);
      }

      // Handle 429 rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
        throw new RateLimitError(path, retryAfterSeconds);
      }

      // Handle 403 (common for past-semester courses)
      if (response.status === 403) {
        const responseText = await response.text();
        throw new ApiError(403, path, responseText);
      }

      // Handle other non-OK responses
      if (!response.ok) {
        const responseText = await response.text();
        throw new ApiError(response.status, path, responseText);
      }

      // Parse and cache response
      const data: T = await response.json();

      if (options?.ttl) {
        this.cache.set(path, data, options.ttl);
        log("DEBUG", `Cached response for ${path} (TTL: ${options.ttl}ms)`);
      }

      return data;
    } catch (error) {
      // Re-throw our own errors
      if (
        error instanceof ApiError ||
        error instanceof RateLimitError ||
        error instanceof NetworkError
      ) {
        throw error;
      }

      // Wrap network/fetch errors
      const message = error instanceof Error ? error.message : String(error);
      throw new NetworkError(
        `Request to ${path} failed: ${message}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Internal method to make HTTP request for raw binary data with 401 retry logic.
   */
  private async makeRawRequest(
    path: string,
    token: TokenData,
    isRetry: boolean = false,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildAuthHeaders(token);

    try {
      log("DEBUG", `${isRetry ? "Retrying" : "Requesting"} GET ${path} (raw)`);

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // At most one retry per request; all readers share invalidation and login.
      if (response.status === 401) {
        await response.body?.cancel();
        const freshToken = await this.recoverToken(path, token, !isRetry);
        if (isRetry) throw new ApiError(401, path, "Refreshed session was rejected.");
        return await this.makeRawRequest(path, freshToken, true);
      }

      // Handle 429 rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
        throw new RateLimitError(path, retryAfterSeconds);
      }

      // Handle 403 (common for past-semester courses or no access)
      if (response.status === 403) {
        const responseText = await response.text();
        throw new ApiError(403, path, responseText);
      }

      // Handle 404 (file not found)
      if (response.status === 404) {
        throw new ApiError(404, path, "File not found");
      }

      // Handle other non-OK responses
      if (!response.ok) {
        const responseText = await response.text();
        throw new ApiError(response.status, path, responseText);
      }

      // Return raw response for caller to process
      return response;
    } catch (error) {
      // Re-throw our own errors
      if (
        error instanceof ApiError ||
        error instanceof RateLimitError ||
        error instanceof NetworkError
      ) {
        throw error;
      }

      // Wrap network/fetch errors
      const message = error instanceof Error ? error.message : String(error);
      throw new NetworkError(
        `Request to ${path} failed: ${message}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  private buildAuthHeaders(token: TokenData): Record<string, string> {
    return {
      "User-Agent":
        "BrightspaceMCP/1.0 (Rohan Muppa; github.com/rohanmuppa/brightspace-mcp-server)",
      Authorization: `Bearer ${token.accessToken}`,
    };
  }

  /**
   * Build path for LP (Learning Platform) API endpoints.
   * @param path - Path within LP API (e.g., "/users/whoami")
   * @returns Full versioned path (e.g., "/d2l/api/lp/1.56/users/whoami")
   */
  lp(path: string): string {
    const { lp } = this.apiVersions;
    return `/d2l/api/lp/${lp}${path}`;
  }

  /**
   * Build path for LE (Learning Environment) API endpoints with orgUnitId.
   * @param orgUnitId - Organizational unit ID (course ID)
   * @param path - Path within LE API (e.g., "/content/root/")
   * @returns Full versioned path (e.g., "/d2l/api/le/1.91/123456/content/root/")
   */
  le(orgUnitId: number, path: string): string {
    const { le } = this.apiVersions;
    return `/d2l/api/le/${le}/${orgUnitId}${path}`;
  }

  /**
   * Build path for global LE (Learning Environment) API endpoints without orgUnitId.
   * @param path - Path within LE API (e.g., "/enrollments/myenrollments/")
   * @returns Full versioned path (e.g., "/d2l/api/le/1.91/enrollments/myenrollments/")
   */
  leGlobal(path: string): string {
    const { le } = this.apiVersions;
    return `/d2l/api/le/${le}${path}`;
  }

  /**
   * Clear all cached responses.
   */
  clearCache(): void {
    this.cache.clear();
    log("DEBUG", "Cache cleared");
  }

  /**
   * Get current cache size (number of cached entries).
   */
  get cacheSize(): number {
    return this.cache.size;
  }
}
