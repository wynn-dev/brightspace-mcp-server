#!/usr/bin/env node
/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * https://github.com/rohanmuppa/brightspace-mcp-server
 */

import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFiles } from "./utils/env.js";
import { loadConfig } from "./utils/config.js";
import { BrowserAuth, CredentialsRejectedError, TokenManager } from "./auth/index.js";
import { LoginBreaker } from "./auth/login-breaker.js";
import { acquireLoginLock } from "./auth/login-lock.js";
import { classifyLoginError } from "./auth/login-failure.js";
import { AUTH_SKIPPED_EXIT_CODE, AUTO_AUTH_ENV } from "./auth/auth-runner.js";

// Load .env.local / .env so credentials are available via process.env
loadEnvFiles();

const pkgVersion = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
        "utf-8",
      ),
    );
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

/** How long to wait for another process's login before giving up. */
const LOCK_WAIT_MS = { automatic: 2 * 60 * 1000, manual: 5 * 60 * 1000 };

async function main(): Promise<void> {
  // Launched by the MCP server (AuthRunner) rather than by a person
  const automatic = process.env[AUTO_AUTH_ENV] === "1";
  let breaker: LoginBreaker | null = null;
  try {
    // Load configuration from environment
    const config = loadConfig();
    breaker = new LoginBreaker(config.sessionDir);

    // One browser login at a time across every process sharing this session dir
    const lock = await acquireLoginLock(config.sessionDir, {
      waitMs: automatic ? LOCK_WAIT_MS.automatic : LOCK_WAIT_MS.manual,
    });
    if (!lock) {
      console.error("Another Brightspace login is still running; try again when it finishes.");
      process.exit(automatic ? AUTH_SKIPPED_EXIT_CODE : 1);
    }
    if (lock.waited && (await new TokenManager(config.sessionDir).getToken())) {
      console.log("Another process just logged in — reusing its session.");
      process.exit(0);
    }
    // A manual run always tries; an automatic one respects a breaker that
    // another process may have opened while we waited for the lock.
    if (automatic && (await breaker.status()).open) {
      console.error("Automatic login is paused after a recent failure; not retrying yet.");
      process.exit(AUTH_SKIPPED_EXIT_CODE);
    }

    // Print header
    console.log(`\n=== Brightspace Authentication v${pkgVersion} - by Rohan Muppa ===\n`);

    // Create BrowserAuth with config
    const browserAuth = new BrowserAuth(config);

    // Check for credentials and provide status
    if (config.username && config.password) {
      console.log(`Authenticating as: ${config.username}`);
      console.log(browserAuth.loginHint);
    } else {
      console.log("No credentials. Opening browser for manual login.");
    }

    console.log("\nStarting authentication...\n");

    // Authenticate and get token
    const token = await browserAuth.authenticate();

    // Create TokenManager and persist token
    const tokenManager = new TokenManager(config.sessionDir);
    await tokenManager.setToken(token);

    // Verify session.json was actually written to disk
    const sessionFile = path.join(config.sessionDir, "session.json");
    try {
      await fs.access(sessionFile);
    } catch {
      console.error(
        `\nWARNING: session.json was not found at ${sessionFile} after save.`
      );
      console.error(
        "Token was captured but failed to persist. Retrying save..."
      );
      // Retry once — the directory should already exist from the first attempt
      await tokenManager.setToken(token);
      try {
        await fs.access(sessionFile);
        console.log("Retry succeeded — session.json saved.");
      } catch {
        console.error("Retry failed. Check directory permissions on", config.sessionDir);
        process.exit(1);
      }
    }

    await breaker.recordSuccess();

    // Print success
    console.log("\n=== Authentication successful! ===");
    console.log(`Session saved to ${sessionFile}`);
    console.log("\nThe MCP server will use this token automatically.");
    console.log("You can now add the server to your Claude Desktop configuration.\n");

    process.exit(0);
  } catch (error) {
    if (breaker) {
      const { kind, message } = classifyLoginError(error);
      await breaker.recordFailure(kind, message).catch(() => {});
    }
    console.error("\n=== Authentication failed ===");
    console.error("\nError:", error instanceof Error ? error.message : String(error));
    console.error("\nTroubleshooting tips:");
    if (error instanceof CredentialsRejectedError) {
      console.error("1. Your school's login page rejected the stored username or password");
      console.error("2. Re-run `pnpm run setup` (or update D2L_USERNAME / D2L_PASSWORD) with the correct credentials");
    } else {
      console.error("1. Ensure D2L_USERNAME and D2L_PASSWORD are set correctly in .env");
      console.error("2. If your school uses MFA, make sure you approved the prompt on your phone");
      console.error("3. Check that you have a stable internet connection");
      console.error("4. Try running with D2L_HEADLESS=false to see the browser");
    }
    console.error("\nFor more details, check the error message above.\n");
    process.exit(1);
  }
}

main();
