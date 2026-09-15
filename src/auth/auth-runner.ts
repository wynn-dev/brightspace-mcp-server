/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { log } from "../utils/logger.js";

/**
 * Timeout for the auth process. Generous because the user may need to
 * approve MFA on their phone or manually log in via the browser.
 */
const AUTH_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Launches the auth CLI (build/auth-cli.js, i.e. `pnpm run auth`) as a child
 * process to re-authenticate when the current session has expired.
 *
 * The child process inherits the parent's environment and runs with the
 * project root as CWD; the auth CLI also loads .env.local / .env itself.
 */
export class AuthRunner {
  private pending: Promise<boolean> | null = null;
  private readonly scriptPath: string;
  private readonly projectRoot: string;

  constructor() {
    // Resolve paths relative to this file's compiled location (build/auth/auth-runner.js)
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    this.scriptPath = path.resolve(thisDir, "..", "auth-cli.js");
    this.projectRoot = path.resolve(thisDir, "..", "..");
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

    this.pending = this.authenticate().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private authenticate(): Promise<boolean> {
    log("INFO", "Auto-launching auth CLI for re-authentication...");
    return new Promise<boolean>((resolve) => {
      execFile(
        process.execPath,
        [this.scriptPath],
        {
          timeout: AUTH_TIMEOUT_MS,
          cwd: this.projectRoot,
          env: { ...process.env },
        },
        (error, _stdout, _stderr) => {
          if (error) {
            log("ERROR", "Auto-auth process failed", error.message);
            resolve(false);
          } else {
            log("INFO", "Auto-auth completed successfully");
            resolve(true);
          }
        },
      );
    });
  }
}
