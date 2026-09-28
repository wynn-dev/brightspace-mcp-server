/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readCredentialSnapshot, type CredentialSnapshot } from "../utils/config.js";
import { log } from "../utils/logger.js";
import { LOGIN_FAILURE_KINDS, type LoginFailureKind } from "./login-failure.js";

/** Wait after the 1st, 2nd, 3rd and every later consecutive failure (credentials excepted). */
export const LOGIN_BACKOFF_MS = [1, 5, 15, 60].map((minutes) => minutes * 60_000);

const STATE_FILE = "auth-state.json";

export interface LoginAttempt {
  at: number;
  ok: boolean;
  kind?: LoginFailureKind;
  message?: string;
}

interface BreakerFile {
  version: 1;
  lastAttempt?: LoginAttempt;
  /** Consecutive failed attempts. */
  failures: number;
  /** Earliest next automatic attempt (backoff failures only). */
  retryAt?: number;
  /** Credential fingerprint at the time of a "credentials" failure. */
  credentials?: string;
}

export interface BreakerStatus {
  /** True while automatic logins are paused. */
  open: boolean;
  lastAttempt: LoginAttempt | null;
  /** When automatic logins resume; null while open until the credentials change. */
  retryAt: number | null;
}

/**
 * Login circuit breaker, persisted as auth-state.json in the session dir so
 * every server process (and restarts) share it.
 *
 * - "credentials" failures pause automatic logins until the stored
 *   credentials or config file change, or a manual `pnpm run auth` succeeds —
 *   re-submitting a rejected password risks locking the account.
 * - Every other failure backs off 1 → 5 → 15 → 60 minutes.
 */
export class LoginBreaker {
  private readonly file: string;

  constructor(
    sessionDir: string,
    private readonly credentials: () => CredentialSnapshot = readCredentialSnapshot,
    private readonly now: () => number = Date.now
  ) {
    this.file = path.join(sessionDir, STATE_FILE);
  }

  async status(): Promise<BreakerStatus> {
    const state = await this.read();
    const lastAttempt = state.lastAttempt ?? null;
    if (!lastAttempt || lastAttempt.ok) return { open: false, lastAttempt, retryAt: null };

    if (lastAttempt.kind === "credentials") {
      const current = this.credentials();
      const changed =
        current.fingerprint !== state.credentials || (current.configMtimeMs ?? 0) > lastAttempt.at;
      return { open: !changed, lastAttempt, retryAt: null };
    }
    const retryAt = state.retryAt ?? 0;
    return { open: this.now() < retryAt, lastAttempt, retryAt };
  }

  async recordSuccess(): Promise<void> {
    await this.write({ version: 1, lastAttempt: { at: this.now(), ok: true }, failures: 0 });
  }

  async recordFailure(kind: LoginFailureKind, message: string): Promise<BreakerStatus> {
    const previous = await this.read();
    const at = this.now();
    const failures = previous.lastAttempt && !previous.lastAttempt.ok ? previous.failures + 1 : 1;
    const next: BreakerFile = { version: 1, lastAttempt: { at, ok: false, kind, message }, failures };
    if (kind === "credentials") {
      next.credentials = this.credentials().fingerprint;
    } else {
      next.retryAt = at + LOGIN_BACKOFF_MS[Math.min(failures, LOGIN_BACKOFF_MS.length) - 1];
    }
    await this.write(next);
    const status = await this.status();
    log(
      "WARN",
      `Login failed (${kind}); automatic logins paused ${
        status.retryAt ? `until ${new Date(status.retryAt).toISOString()}` : "until the stored credentials change"
      }`
    );
    return status;
  }

  private async read(): Promise<BreakerFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf-8")) as BreakerFile;
      const attempt = parsed.lastAttempt;
      if (attempt && (typeof attempt.at !== "number" || (attempt.kind && !LOGIN_FAILURE_KINDS.includes(attempt.kind)))) {
        throw new Error("malformed login state");
      }
      return { ...parsed, failures: Number(parsed.failures) || 0 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log("WARN", "Ignoring unreadable login state", error);
      return { version: 1, failures: 0 };
    }
  }

  /** Atomic replace so concurrent readers never see a half-written file. */
  private async write(state: BreakerFile): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tmp, this.file);
    } catch (error) {
      log("WARN", "Failed to persist login state", error);
    }
  }
}
