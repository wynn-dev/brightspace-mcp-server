#!/usr/bin/env node
/**
 * Brightspace MCP Server — Streamable HTTP entry point
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * Serves the same read-only tools as the stdio server over MCP's Streamable
 * HTTP transport so remote MCP clients can connect. download_file is left out
 * because it writes to this host's disk, not the client's.
 */

import { log } from "./utils/logger.js";
import { loadEnvFiles } from "./utils/env.js";
import { loadConfig } from "./utils/config.js";
import { TokenManager, AuthRunner } from "./auth/index.js";
import { D2LApiClient } from "./api/index.js";
import { createMcpServer, PKG_VERSION } from "./server.js";
import { startHttpServer, isLoopbackHost } from "./http/server.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`MCP_HTTP_PORT must be an integer between 0 and 65535, got "${raw}"`);
  }
  return port;
}

function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

async function main(): Promise<void> {
  const envFiles = loadEnvFiles();
  const config = loadConfig();
  const host = process.env.MCP_HTTP_HOST || DEFAULT_HOST;
  const port = parsePort(process.env.MCP_HTTP_PORT);
  const authToken = process.env.MCP_AUTH_TOKEN || undefined;

  log("INFO", "");
  log("INFO", "========================================");
  log("INFO", `  Brightspace MCP Server v${PKG_VERSION} (Streamable HTTP)`);
  log("INFO", "  github.com/rohanmuppa/brightspace-mcp-server");
  log("INFO", "========================================");
  log("INFO", "");
  if (envFiles.length > 0) log("INFO", `Loaded environment from ${envFiles.join(", ")}`);

  const tokenManager = new TokenManager(config.sessionDir);
  const authRunner = new AuthRunner();
  const apiClient = new D2LApiClient({
    baseUrl: config.baseUrl,
    tokenManager,
    onAuthExpired: () => authRunner.run(),
  });

  try {
    await apiClient.initialize();
    log("INFO", "D2L API Client initialized");
  } catch (error) {
    log("ERROR", "Failed to initialize D2L API Client", error);
    log("ERROR", "MCP server cannot start without API initialization. Exiting.");
    process.exit(1);
  }

  const running = await startHttpServer({
    host,
    port,
    authToken,
    allowedHosts: parseList(process.env.MCP_ALLOWED_HOSTS),
    allowedOrigins: parseList(process.env.MCP_ALLOWED_ORIGINS),
    createServer: () =>
      createMcpServer({
        apiClient,
        tokenManager,
        authRunner,
        config,
        includeDownloadFile: false,
      }),
  });

  log("INFO", `Brightspace MCP Server listening on ${running.url} (11 read-only tools)`);
  if (authToken) {
    log("INFO", "Bearer auth enabled — clients must send Authorization: Bearer <MCP_AUTH_TOKEN>");
  } else if (isLoopbackHost(host)) {
    log("WARN", "MCP_AUTH_TOKEN not set — any local process can read your Brightspace data through this port");
  }
  if (!config.username || !config.password) {
    log("WARN", "No stored credentials — automatic re-login will need a visible browser on this host");
  }

  const shutdown = async (signal: NodeJS.Signals) => {
    log("INFO", `Received ${signal} — shutting down HTTP MCP server`);
    try {
      await running.close();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => {
  log("ERROR", "Unhandled promise rejection", reason);
});

main().catch((error) => {
  log("ERROR", "HTTP MCP server failed to start", error);
  process.exit(1);
});
