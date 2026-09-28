/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import type { TokenManager } from "./token-manager.js";
import type { AuthRunner } from "./auth-runner.js";
import { log } from "../utils/logger.js";

/** Refresh once this fraction of the token's lifetime has passed. */
const REFRESH_AT_FRACTION = 0.75;
/** Keep the session warm only this long after the last tool call. */
const DEFAULT_ACTIVE_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Never check more often than this (guards against loops if a refresh gains nothing). */
const MIN_DELAY_MS = 60_000;
/** Re-check interval while logins are paused until the credentials change. */
const PAUSED_RECHECK_MS = 15 * 60_000;

interface RefresherDeps {
  tokenManager: Pick<TokenManager, "getToken">;
  authRunner: Pick<AuthRunner, "run" | "status">;
  activeWindowMs?: number;
  now?: () => number;
}

/**
 * Background session refresh for the long-running HTTP server: renews the
 * Brightspace token at ~75% of its real lifetime so tool calls don't wait
 * for a browser login, but only while the server was used in the last
 * 12 hours. Refreshes go through AuthRunner.run(), so they share the
 * breaker, the login lock, and any on-demand login already in flight; the
 * auth CLI tries saved cookies before submitting credentials.
 */
export class SessionRefresher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = false;
  private lastToolCallAt: number | null = null;
  private readonly activeWindowMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: RefresherDeps) {
    this.activeWindowMs = deps.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Record a tool call; (re)arms the refresh timer if it went idle. */
  noteToolCall(): void {
    this.lastToolCallAt = this.now();
    if (!this.timer && !this.busy && !this.stopped) void this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private active(): boolean {
    return this.lastToolCallAt !== null && this.now() - this.lastToolCallAt <= this.activeWindowMs;
  }

  /** When the next refresh is due, or null if nothing should run until the next tool call. */
  private async dueAt(): Promise<number | null> {
    if (!this.active()) return null;
    const [token, breaker] = await Promise.all([this.deps.tokenManager.getToken(), this.deps.authRunner.status()]);
    const now = this.now();
    let due = token ? token.capturedAt + (token.expiresAt - token.capturedAt) * REFRESH_AT_FRACTION : now;
    if (breaker.open) due = Math.max(due, breaker.retryAt ?? now + PAUSED_RECHECK_MS);
    return due;
  }

  private async schedule(): Promise<void> {
    this.busy = true;
    try {
      const due = await this.dueAt();
      if (due === null || this.stopped) {
        if (due === null) log("DEBUG", "Session refresher idle until the next tool call");
        return;
      }
      const delay = Math.max(due - this.now(), MIN_DELAY_MS);
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.tick(), delay);
      this.timer.unref();
      log("DEBUG", `Next background session check in ${Math.round(delay / 60000)} min`);
    } catch (error) {
      log("WARN", "Could not schedule background session refresh", error);
    } finally {
      this.busy = false;
    }
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    this.busy = true;
    try {
      // dueAt() already defers past an open breaker's retry time
      const due = await this.dueAt();
      if (due !== null && due <= this.now()) {
        log("INFO", "Refreshing Brightspace session in the background");
        await this.deps.authRunner.run();
      }
    } catch (error) {
      log("WARN", "Background session refresh failed", error);
    } finally {
      this.busy = false;
    }
    if (!this.stopped) await this.schedule();
  }
}
