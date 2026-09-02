/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { D2LApiClient } from "./api/index.js";
import type { TokenManager, AuthRunner } from "./auth/index.js";
import type { AppConfig } from "./types/index.js";
import { log } from "./utils/logger.js";
import {
  registerGetMyCourses,
  registerGetUpcomingDueDates,
  registerGetMyGrades,
  registerGetAnnouncements,
  registerGetAssignments,
  registerGetCourseContent,
  registerDownloadFile,
  registerGetClasslistEmails,
  registerGetRoster,
  registerGetSyllabus,
  registerGetDiscussions,
} from "./tools/index.js";

export const PKG_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

interface McpServerDeps {
  apiClient: D2LApiClient;
  tokenManager: Pick<TokenManager, "getToken">;
  authRunner: Pick<AuthRunner, "run">;
  config: AppConfig;
  version?: string;
  /**
   * download_file writes to the disk of whatever host runs the server, which
   * is useless (and surprising) for remote HTTP clients. Defaults to true;
   * the HTTP entry point turns it off.
   */
  includeDownloadFile?: boolean;
}

/**
 * Build a fully configured McpServer. One instance serves one transport, so
 * the stdio entry point calls this once and the HTTP entry point calls it
 * per session, sharing the API client (and its cache) across all of them.
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const {
    apiClient,
    tokenManager,
    authRunner,
    config,
    version = PKG_VERSION,
    includeDownloadFile = true,
  } = deps;

  const server = new McpServer({
    name: "brightspace",
    version,
    description:
      "Brightspace MCP Server — by Rohan Muppa (github.com/rohanmuppa/brightspace-mcp-server)",
  });

  // check_auth takes no input, so no inputSchema
  server.registerTool(
    "check_auth",
    {
      title: "Check Authentication Status",
      description:
        "Check if you are authenticated with Brightspace. " +
        "Run `pnpm run auth` first to authenticate. " +
        "Use this when the user asks if they're logged in, if authentication is working, " +
        "or when other tools return auth errors.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      log("DEBUG", "check_auth tool called");

      let token = await tokenManager.getToken();

      if (!token) {
        log("INFO", "check_auth: No valid token, attempting auto-reauthentication...");

        const success = await authRunner.run();
        if (success) {
          token = await tokenManager.getToken();
        }

        if (!token) {
          log("INFO", "check_auth: Auto-reauthentication failed or produced no valid token");

          return {
            content: [
              {
                type: "text",
                text:
                  "Not authenticated. Auto-reauthentication was attempted but failed. " +
                  "Please run `pnpm run auth` in the project directory to log in. " +
                  "Make sure your stored credentials are correct and your internet connection is stable.",
              },
            ],
          };
        }

        log("INFO", "check_auth: Auto-reauthentication succeeded");
      }

      const expiresIn = Math.round((token.expiresAt - Date.now()) / 1000 / 60);
      log("INFO", `check_auth: Token valid, expires in ~${expiresIn} minutes`);

      return {
        content: [
          {
            type: "text",
            text: `Authenticated with Brightspace. Token expires in ~${expiresIn} minutes. Source: ${token.source}.`,
          },
        ],
      };
    }
  );

  registerGetMyCourses(server, apiClient, config);
  registerGetUpcomingDueDates(server, apiClient, config);
  registerGetMyGrades(server, apiClient, config);
  registerGetAnnouncements(server, apiClient, config);
  registerGetAssignments(server, apiClient, config);
  registerGetCourseContent(server, apiClient, config);
  if (includeDownloadFile) registerDownloadFile(server, apiClient, config);
  registerGetClasslistEmails(server, apiClient, config);
  registerGetRoster(server, apiClient, config);
  registerGetSyllabus(server, apiClient, config);
  registerGetDiscussions(server, apiClient, config);

  log("DEBUG", `MCP tools registered (${includeDownloadFile ? 12 : 11} including check_auth)`);
  return server;
}
