/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { DEFAULT_CACHE_TTLS, getAllObjectListPages } from "../api/index.js";
import { GetClasslistEmailsSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { toolResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

interface ClasslistUser {
  Identifier: number;
  DisplayName: string;
  Email: string | null;
  ClasslistRoleDisplayName: string;
}

export const registerGetClasslistEmails = defineTool(
  {
    name: "get_classlist_emails",
    title: "Get Classlist Emails",
    description:
      "Fetch all email addresses for everyone in a course — instructors, TAs, and students. " +
      "Use this when the user wants a list of emails for a class, needs to email the whole class, " +
      "or wants contact info for everyone enrolled.",
    schema: GetClasslistEmailsSchema,
  },
  async ({ courseId }, { apiClient }) => {
    const users = await getAllObjectListPages<ClasslistUser>(
      apiClient,
      apiClient.le(courseId, "/classlist/paged/"),
      { ttl: DEFAULT_CACHE_TTLS.roster, label: "classlist" }
    );

    // Users with privacy-hidden emails come back as null
    const emails = users
      .filter((user) => user.Email)
      .map((user) => ({
        name: user.DisplayName,
        email: user.Email,
        role: user.ClasslistRoleDisplayName,
      }));

    log("INFO", `get_classlist_emails: ${emails.length} emails from ${users.length} users in course ${courseId}`);
    return toolResponse(emails);
  }
);
