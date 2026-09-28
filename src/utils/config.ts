/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { AppConfig, LogLevel } from "../types/index.js";
import { configStoreExists, getConfigStorePath, loadConfigStore, type ConfigStoreData } from "./config-store.js";
import { setLogLevel } from "./logger.js";

const LOG_LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];

export function loadConfig(): AppConfig {
  // Apply the log level first so the config loading below can itself be traced
  const requestedLevel = process.env.D2L_LOG_LEVEL?.toUpperCase();
  if (requestedLevel) {
    if (LOG_LEVELS.includes(requestedLevel as LogLevel)) {
      setLogLevel(requestedLevel as LogLevel);
    } else {
      console.error(`[config] Ignoring invalid D2L_LOG_LEVEL "${process.env.D2L_LOG_LEVEL}" (use ${LOG_LEVELS.join(", ")})`);
    }
  }

  const store = configStoreExists() ? loadConfigStore() : null;

  if (store) {
    console.error("[config] Loaded base config from ~/.brightspace-mcp/config.json");
  } else {
    console.error("[config] No config.json found, using environment variables");
  }

  // Resolve sessionDir: env > store > default
  const sessionDir = process.env.D2L_SESSION_DIR
    ? expandTilde(process.env.D2L_SESSION_DIR)
    : store?.sessionDir
      ? expandTilde(store.sessionDir)
      : path.join(os.homedir(), ".d2l-session");

  // Resolve headless: env > store > default (false)
  let headless = store?.headless ?? false;
  if (process.env.D2L_HEADLESS !== undefined) {
    headless = process.env.D2L_HEADLESS === "true";
  }

  // Resolve tokenTtl: env > store > default (3600)
  const tokenTtl = process.env.D2L_TOKEN_TTL
    ? parseInt(process.env.D2L_TOKEN_TTL, 10)
    : store?.tokenTtl ?? 3600;

  // Resolve includeCourseIds: env > store > undefined
  const includeCourseIds = process.env.D2L_INCLUDE_COURSES
    ? process.env.D2L_INCLUDE_COURSES.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : store?.includeCourses;

  // Resolve excludeCourseIds: env > store > undefined
  const excludeCourseIds = process.env.D2L_EXCLUDE_COURSES
    ? process.env.D2L_EXCLUDE_COURSES.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    : store?.excludeCourses;

  // Resolve activeOnly: env > store > default (true)
  let activeOnly = store?.activeOnly ?? true;
  if (process.env.D2L_ACTIVE_ONLY !== undefined) {
    activeOnly = process.env.D2L_ACTIVE_ONLY !== 'false';
  }

  return {
    ...resolveLogin(store),
    sessionDir,
    tokenTtl,
    headless,
    courseFilter: {
      includeCourseIds,
      excludeCourseIds,
      activeOnly,
    },
  };
}

/** Login target and credentials: env > config store > default. */
function resolveLogin(store: ConfigStoreData | null): Pick<AppConfig, "baseUrl" | "username" | "password"> {
  return {
    baseUrl: process.env.D2L_BASE_URL || store?.baseUrl || "https://purdue.brightspace.com",
    username: process.env.D2L_USERNAME || store?.username,
    password: process.env.D2L_PASSWORD || store?.password,
  };
}

export interface CredentialSnapshot {
  /** One-way digest of baseUrl + username + password; changes when any of them does. */
  fingerprint: string;
  /** mtime of ~/.brightspace-mcp/config.json, if it exists. */
  configMtimeMs?: number;
}

/**
 * Re-read the credentials a login would use right now (without the logging
 * and side effects of loadConfig), so a long-running server notices when
 * `pnpm run setup` stored new ones.
 */
export function readCredentialSnapshot(): CredentialSnapshot {
  let store: ConfigStoreData | null = null;
  let configMtimeMs: number | undefined;
  try {
    if (configStoreExists()) {
      configMtimeMs = statSync(getConfigStorePath()).mtimeMs;
      store = loadConfigStore();
    }
  } catch {
    // Unreadable config: fall back to the environment alone
  }
  const { baseUrl, username, password } = resolveLogin(store);
  const fingerprint = createHash("sha256")
    .update(["brightspace-mcp-login", baseUrl, username ?? "", password ?? ""].join("\0"))
    .digest("hex")
    .slice(0, 16);
  return { fingerprint, configMtimeMs };
}

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

export type { AppConfig };
