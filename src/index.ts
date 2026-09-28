#!/usr/bin/env node
/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 *
 * https://github.com/rohanmuppa/brightspace-mcp-server
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { enableStdoutGuard, log } from "./utils/logger.js";
import { loadEnvFiles } from "./utils/env.js";
import { loadConfig } from "./utils/config.js";
import { TokenManager, AuthRunner } from "./auth/index.js";
import { describeAuthFailure } from "./auth/auth-status.js";
import { D2LApiClient } from "./api/index.js";
import { createMcpServer, PKG_VERSION, toolNames } from "./server.js";

// ── Subcommand routing (before any MCP initialization) ──────────────
const subcommand = process.argv[2];

if (subcommand === 'setup') {
  await import('./setup.js');
} else if (subcommand === 'auth') {
  await import('./auth-cli.js');
} else if (subcommand === 'http') {
  await import('./http-server.js');
} else {
  // ── MCP Server (default) ────────────────────────────────────────────

  // CRITICAL: Enable stdout guard IMMEDIATELY to prevent corruption of stdio transport
  enableStdoutGuard();

  // Unhandled rejection handler
  process.on('unhandledRejection', (reason) => {
    log('ERROR', 'Unhandled promise rejection', reason);
  });

  async function main(): Promise<void> {
    try {
      // Load configuration (.env.local / .env first, then config store + env)
      loadEnvFiles();
      const config = loadConfig();
      log("DEBUG", "Configuration loaded", { sessionDir: config.sessionDir });

      log("INFO", "");
      log("INFO", "========================================");
      log("INFO", `  Brightspace MCP Server v${PKG_VERSION}`);
      log("INFO", "  By Rohan Muppa — ECE @ Purdue");
      log("INFO", "  github.com/rohanmuppa/brightspace-mcp-server");
      log("INFO", "========================================");
      log("INFO", "");

      // Create TokenManager for reading cached tokens
      const tokenManager = new TokenManager(config.sessionDir);

      // Create AuthRunner for auto-reauthentication
      const authRunner = new AuthRunner(config.sessionDir);

      // Create D2L API Client with auto-reauth support
      const apiClient = new D2LApiClient({
        baseUrl: config.baseUrl,
        tokenManager,
        onAuthExpired: () => authRunner.run(),
        describeAuthFailure: () => describeAuthFailure(tokenManager, authRunner),
        versionCacheDir: config.sessionDir,
      });

      // Discover API versions. Never exits: falls back to the last cached
      // versions and keeps retrying in the background if Brightspace is down.
      await apiClient.initialize();
      log("INFO", "D2L API Client initialized");

      // Log active course filter config if any filter is set
      if (config.courseFilter.includeCourseIds || config.courseFilter.excludeCourseIds || !config.courseFilter.activeOnly) {
        log("DEBUG", "Course filter config", {
          include: config.courseFilter.includeCourseIds,
          exclude: config.courseFilter.excludeCourseIds,
          activeOnly: config.courseFilter.activeOnly,
        });
      }

      const server = createMcpServer({ apiClient, tokenManager, authRunner, config });

      // Connect stdio transport
      const transport = new StdioServerTransport();
      await server.connect(transport);

      log("INFO", `Brightspace MCP Server by Rohan Muppa — running on stdio (${toolNames(true).length} tools registered)`);
      log("INFO", "Setup: see README.md for MCP client configuration (Claude Desktop, ChatGPT Desktop, Cursor, etc.)");
    } catch (error) {
      log("ERROR", "MCP Server failed to start", error);
      process.exit(1);
    }
  }

  // Graceful shutdown
  process.on('SIGINT', () => {
    log('INFO', 'Shutting down MCP server');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    log('INFO', 'Shutting down MCP server');
    process.exit(0);
  });

  main();
}
