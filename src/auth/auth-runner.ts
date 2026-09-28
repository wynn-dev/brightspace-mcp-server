/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { log } from "../utils/logger.js";
import { LoginBreaker, type BreakerStatus } from "./login-breaker.js";

/**
 * Timeout for the auth process. Generous because the user may need to
 * approve MFA on their phone, or the child may first wait for another
 * process's login to finish (see login-lock.ts).
 */
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Exit code of an automatic `auth-cli` run that deliberately did not try to
 * log in (the breaker opened, or another process kept the login lock), so
 * there is no new failure to record.
 */
export const AUTH_SKIPPED_EXIT_CODE = 75;

/** Set on the auth CLI's environment when AuthRunner (not a person) launched it. */
export const AUTO_AUTH_ENV = "BRIGHTSPACE_AUTH_AUTOMATIC";

interface ChildResult {
  ok: boolean;
  code?: number | string | null;
  killed?: boolean;
  message: string;
}

/**
 * Launches the auth CLI (build/auth-cli.js, i.e. `pnpm run auth`) as a child
 * process to re-authenticate when the current session has expired.
 *
 * The child process inherits the parent's environment and runs with the
 * project root as CWD; the auth CLI also loads .env.local / .env itself.
 * The child records its outcome in the login breaker; while the breaker is
 * open, run() fails fast without launching a browser.
 */
export class AuthRunner {
  private pending: Promise<boolean> | null = null;
  private readonly scriptPath: string;
  private readonly projectRoot: string;
  readonly breaker: LoginBreaker;

  constructor(sessionDir: string, breaker: LoginBreaker = new LoginBreaker(sessionDir)) {
    // Resolve paths relative to this file's compiled location (build/auth/auth-runner.js)
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    this.scriptPath = path.resolve(thisDir, "..", "auth-cli.js");
    this.projectRoot = path.resolve(thisDir, "..", "..");
    this.breaker = breaker;
  }

  /** Stored breaker state: last login attempt, whether logins are paused, and until when. */
  status(): Promise<BreakerStatus> {
    return this.breaker.status();
  }

  /** True while a login started by this process is running. */
  get running(): boolean {
    return this.pending !== null;
  }

  /**
   * Spawn the auth CLI and wait for it to complete.
   * Returns true if authentication succeeded, false otherwise.
   * Concurrent callers share the same attempt and receive its result.
   */
  run(): Promise<boolean> {
    if (this.pending) {
      log("DEBUG", "Auth already running, waiting for the same attempt");
      return this.pending;
    }

    this.pending = this.attempt().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async attempt(): Promise<boolean> {
    const before = await this.breaker.status();
    if (before.open) {
      const until = before.retryAt ? new Date(before.retryAt).toISOString() : "the stored credentials change";
      log("WARN", `Automatic login paused after a ${before.lastAttempt?.kind} failure — not retrying until ${until}`);
      return false;
    }

    const result = await this.spawnAuthCli();
    if (result.ok) return true;
    if (result.code === AUTH_SKIPPED_EXIT_CODE) return false;

    // The child records its own failures; fill in when it was killed or crashed first.
    const recorded = (await this.breaker.status()).lastAttempt;
    if (!recorded || recorded.at === before.lastAttempt?.at) {
      await this.breaker.recordFailure(result.killed ? "timeout" : "other", result.message);
    }
    return false;
  }

  private spawnAuthCli(): Promise<ChildResult> {
    log("INFO", "Auto-launching auth CLI for re-authentication...");
    return new Promise<ChildResult>((resolve) => {
      execFile(
        process.execPath,
        [this.scriptPath],
        {
          timeout: AUTH_TIMEOUT_MS,
          cwd: this.projectRoot,
          env: { ...process.env, [AUTO_AUTH_ENV]: "1" },
        },
        (error, _stdout, stderr) => {
          if (!error) {
            log("INFO", "Auto-auth completed successfully");
            resolve({ ok: true, message: "" });
            return;
          }
          const killed = Boolean((error as { killed?: boolean }).killed);
          const lines = String(stderr ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
          const errorLine = lines.filter((l) => l.startsWith("Error:")).at(-1) ?? lines.at(-1);
          const message = killed
            ? `the login did not finish within ${AUTH_TIMEOUT_MS / 60000} minutes`
            : (errorLine ?? error.message).replace(/\[PBMCP-\d+\]\s*/g, "").slice(0, 200);
          log("ERROR", "Auto-auth process failed", error.message);
          resolve({ ok: false, code: (error as { code?: number | string | null }).code, killed, message });
        },
      );
    });
  }
}
