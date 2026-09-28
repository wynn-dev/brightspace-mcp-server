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
  registerGetCalendar,
  registerGetSubmissionHistory,
  registerGetMyWork,
  registerGetBriefing,
  registerGetCourseUpdates,
  registerGetMyGroups,
  registerGetChecklists,
  registerGetGradeSummary,
  registerSearchCourse,
  registerGetMyCourses,
  registerGetMyGrades,
  registerGetAnnouncements,
  registerGetAssignments,
  registerGetCourseContent,
  registerDownloadFile,
  registerGetRoster,
  registerGetSyllabus,
  registerReadOnlyGetSyllabus,
  registerReadCourseContent,
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

const COMMON_TOOLS = [
  registerGetBriefing,
  registerGetCalendar,
  registerGetSubmissionHistory,
  registerGetMyWork,
  registerGetCourseUpdates,
  registerGetMyGroups,
  registerGetChecklists,
  registerGetGradeSummary,
  registerSearchCourse,
  registerGetMyCourses,
  registerGetMyGrades,
  registerGetAnnouncements,
  registerGetAssignments,
  registerGetCourseContent,
  registerReadCourseContent,
  registerGetRoster,
  registerGetDiscussions
];
export function toolNames(includeDownloadFile = false): string[] {
  return ["check_auth", ...COMMON_TOOLS.map(tool => tool.toolName), "get_syllabus", ...(includeDownloadFile ? ["download_file"] : [])];
}

/** Sent to clients at initialization: which tool answers which student question. */
export const SERVER_INSTRUCTIONS = [
  "Read-only access to the user's D2L Brightspace courses. Course-scoped tools accept courseId or course (a course name or code).",
  "Routing: catch me up / what's up / daily or weekly summary -> get_briefing. What's due, overdue or to do this week -> get_my_work. Calendar events, reminders, availability windows -> get_calendar.",
  "Grades and final grade -> get_my_grades; how the grade is calculated or what-if scores -> get_grade_summary.",
  "Assignment details, rubrics, feedback -> get_assignments (detail) and get_submission_history.",
  "What's new or missed -> get_course_updates; announcements -> get_announcements.",
  "Course materials -> get_course_content (outline), then read_course_content with a file topicId. Keyword search -> search_course.",
  "Staff and classmates -> get_roster. Syllabus -> get_syllabus. Groups -> get_my_groups. Discussions -> get_discussions.",
  "Each result has readStatus: if partial is true, some sources failed or were limited, so do not conclude that nothing exists. Unknown completion is not the same as unfinished.",
].join("\n");

interface McpServerDeps {
  apiClient: D2LApiClient;
  tokenManager: Pick<TokenManager, "getToken">;
  authRunner: Pick<AuthRunner, "run">;
  config: AppConfig;
  version?: string;
  /**
   * download_file writes to the disk of whatever host runs the server, which
   * is useless (and surprising) for remote HTTP clients. Defaults to true;
   * the HTTP entry point turns it off. Also disables syllabus attachment saves.
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
  }, { instructions: SERVER_INSTRUCTIONS });

  const discovery = { serverVersion: version, tools: toolNames(includeDownloadFile),
    transport: includeDownloadFile ? "stdio" : "http",
    discoveryAdvice: "If these tools are missing from your client, refresh its MCP tool list or reconnect. Updating files requires restarting the server process. Run pnpm run diagnose to compare discovery." };

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

          const message =
            "Not authenticated. Auto-reauthentication was attempted but failed. " +
            "Please run `pnpm run auth` in the project directory to log in. " +
            "Make sure your stored credentials are correct and your internet connection is stable.";
          return {
            structuredContent: { authenticated: false, message, ...discovery },
            content: [{ type: "text", text: message }],
          };
        }

        log("INFO", "check_auth: Auto-reauthentication succeeded");
      }

      const expiresIn = Math.round((token.expiresAt - Date.now()) / 1000 / 60);
      log("INFO", `check_auth: Token valid, expires in ~${expiresIn} minutes`);

      const message = `Authenticated with Brightspace. Token expires in ~${expiresIn} minutes. Source: ${token.source}.`;
      return {
        structuredContent: { authenticated: true, message, expiresInMinutes: expiresIn, source: token.source, ...discovery },
        content: [{ type: "text", text: message }],
      };
    }
  );

  for (const register of COMMON_TOOLS) register(server, apiClient, config);
  if (includeDownloadFile) registerDownloadFile(server, apiClient, config);
  (includeDownloadFile ? registerGetSyllabus : registerReadOnlyGetSyllabus)(server, apiClient, config);

  log("DEBUG", `MCP tools registered (${toolNames(includeDownloadFile).length} including check_auth)`);
  return server;
}
