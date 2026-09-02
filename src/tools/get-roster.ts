/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { DEFAULT_CACHE_TTLS, type D2LApiClient } from "../api/index.js";
import { GetRosterSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { toolResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

interface ClasslistUser {
  Identifier: number;
  DisplayName: string;
  Email: string | null;
  FirstName: string | null;
  LastName: string | null;
  RoleId: number | null;
  ClasslistRoleDisplayName: string;
  IsOnline: boolean;
  LastAccessed: string | null;
}

interface ClasslistResponse {
  Objects: ClasslistUser[];
  Next?: string | null;
}

// Purdue-specific role IDs. These are institution-specific values.
// If using at another institution, you may need to adjust these.
// Discover by fetching classlist for a known course and inspecting RoleId values.
const INSTRUCTOR_ROLE_ID = 109;
const TA_ROLE_ID = 135;

/** Cap on the full-class listing to keep MCP responses a sane size. */
const MAX_STUDENTS = 100;

async function fetchClasslistPage(
  apiClient: D2LApiClient,
  courseId: number,
  options?: { roleId?: number; searchTerm?: string }
): Promise<ClasslistUser[]> {
  const params = new URLSearchParams();
  if (options?.roleId !== undefined) params.append("roleId", options.roleId.toString());
  if (options?.searchTerm) params.append("searchTerm", options.searchTerm);

  const queryString = params.toString();
  const path = apiClient.le(courseId, `/classlist/paged/${queryString ? "?" + queryString : ""}`);

  const response = await apiClient.get<ClasslistResponse>(path, {
    ttl: DEFAULT_CACHE_TTLS.roster,
  });

  if (response.Next) {
    log(
      "WARN",
      "get_roster: Pagination detected but not implemented. Some users may be missing.",
      { courseId, next: response.Next }
    );
  }

  return response.Objects;
}

export const registerGetRoster = defineTool(
  {
    name: "get_roster",
    title: "Get Course Roster",
    description:
      "Fetch the roster for a course including instructors, TAs, and optionally students with their names, emails, and roles. Use this when the user asks about classmates, instructor contact info, TA emails, professor names, or who's in a class. By default returns only instructors and TAs for privacy. Use includeStudents to get full class list.",
    schema: GetRosterSchema,
  },
  async ({ courseId, includeStudents, searchTerm }, { apiClient }) => {
    let allUsers: ClasslistUser[] = [];

    if (!includeStudents) {
      const [instructorResult, taResult] = await Promise.allSettled([
        fetchClasslistPage(apiClient, courseId, { roleId: INSTRUCTOR_ROLE_ID, searchTerm }),
        fetchClasslistPage(apiClient, courseId, { roleId: TA_ROLE_ID, searchTerm }),
      ]);

      if (instructorResult.status === "fulfilled") {
        allUsers.push(...instructorResult.value);
      } else {
        log("WARN", "get_roster: Failed to fetch instructors", { error: instructorResult.reason });
      }

      if (taResult.status === "fulfilled") {
        allUsers.push(...taResult.value);
      } else {
        log("WARN", "get_roster: Failed to fetch TAs", { error: taResult.reason });
      }
    } else {
      allUsers = await fetchClasslistPage(apiClient, courseId, { searchTerm });

      if (allUsers.length > MAX_STUDENTS) {
        log("WARN", `get_roster: Result set exceeds ${MAX_STUDENTS} users, truncating`, {
          total: allUsers.length,
          returned: MAX_STUDENTS,
        });
        allUsers = allUsers.slice(0, MAX_STUDENTS);
      }
    }

    const roster = allUsers.map((user) => ({
      name: user.DisplayName,
      email: user.Email || null,
      role: user.ClasslistRoleDisplayName,
    }));

    log("INFO", `get_roster: Retrieved ${roster.length} users for course ${courseId}`);
    return toolResponse(roster);
  }
);
