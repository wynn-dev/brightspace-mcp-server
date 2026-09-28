/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { TokenData } from "../types/index.js";
import { SessionStore } from "./session-store.js";
import { log } from "../utils/logger.js";

/**
 * Token refresh buffer - tokens within this time of expiry are considered invalid.
 * This prevents using tokens that might expire during a request.
 */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * TokenManager manages token lifecycle with in-memory caching and disk persistence.
 * Handles expiry detection with a configurable refresh buffer.
 *
 * Several processes (stdio servers, the HTTP server, `pnpm run auth`) share
 * one session file, so the memory cache is keyed by the file's mtime+size:
 * a session written by another process is picked up on the next read.
 */
export class TokenManager {
  private cachedToken: TokenData | null = null;
  /** fileStamp() of the session file the cache reflects; undefined = unknown. */
  private cachedStamp: string | null | undefined = undefined;
  private readonly sessionStore: SessionStore;

  constructor(sessionDir?: string) {
    this.sessionStore = new SessionStore(sessionDir);
  }

  /**
   * Get the current token if valid, otherwise null.
   * Uses the memory cache unless the session file changed on disk.
   * Returns null if token is expired or within refresh buffer.
   */
  async getToken(): Promise<TokenData | null> {
    const token = await this.current();
    if (token && this.isValid(token)) {
      log("DEBUG", "Returning cached token");
      return token;
    }

    log("DEBUG", "No valid token available");
    return null;
  }

  /** The newest known token, reloading from disk if another process replaced it. */
  private async current(): Promise<TokenData | null> {
    const stamp = await this.sessionStore.fileStamp();
    if (stamp !== this.cachedStamp) {
      this.cachedToken = stamp === null ? null : await this.sessionStore.load();
      this.cachedStamp = stamp;
      if (this.cachedToken) log("DEBUG", "Loaded token from session store");
    }
    return this.cachedToken;
  }

  /**
   * Set a new token, caching in memory and persisting to disk.
   */
  async setToken(token: TokenData): Promise<void> {
    this.cachedToken = token;
    await this.sessionStore.save(token);
    this.cachedStamp = await this.sessionStore.fileStamp();
    log("DEBUG", "Token cached and persisted");
  }

  /**
   * Clear the token from memory and disk.
   *
   * Pass the token Brightspace rejected to clear only that token: if another
   * process already saved a newer session, it is kept (and used from now on)
   * instead of being deleted.
   */
  async clearToken(rejected?: TokenData): Promise<void> {
    if (rejected) {
      const onDisk = await this.sessionStore.load();
      if (onDisk && onDisk.accessToken !== rejected.accessToken) {
        log("INFO", "Session on disk is newer than the rejected token — keeping it");
        this.cachedStamp = undefined;
        return;
      }
    }
    this.cachedToken = null;
    await this.sessionStore.clear();
    this.cachedStamp = null;
    log("DEBUG", "Token cleared from memory and disk");
  }

  /**
   * Check if a token is valid (not expired and outside refresh buffer).
   * A token is valid if it expires more than REFRESH_BUFFER_MS from now.
   */
  isValid(token: TokenData): boolean {
    const now = Date.now();
    const timeUntilExpiry = token.expiresAt - now;

    // Token must expire more than REFRESH_BUFFER_MS in the future
    const valid = timeUntilExpiry > REFRESH_BUFFER_MS;

    if (!valid) {
      log(
        "DEBUG",
        `Token invalid: expires in ${Math.round(timeUntilExpiry / 1000)}s (buffer: ${REFRESH_BUFFER_MS / 1000}s)`
      );
    }

    return valid;
  }

  /**
   * Check if a token refresh is needed.
   * Returns true if no valid token is available.
   */
  async needsRefresh(): Promise<boolean> {
    const token = await this.getToken();
    return token === null;
  }
}
