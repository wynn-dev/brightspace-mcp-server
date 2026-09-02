/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { GetMyCoursesSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { fetchEnrolledCourses } from "./course-helpers.js";
import { toolResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

export const registerGetMyCourses = defineTool(
  {
    name: "get_my_courses",
    title: "Get My Courses",
    description:
      "Fetch your enrolled Brightspace courses with names, codes, and IDs. Use this when the user asks about their courses, enrolled classes, what they're taking this semester, or needs a course ID for other queries.",
    schema: GetMyCoursesSchema,
  },
  async ({ activeOnly: activeOnlyArg }, { apiClient, config }) => {
    // An explicit per-call argument wins; otherwise fall back to the configured
    // policy. Resolving once keeps the API query and the post-fetch filter in
    // agreement.
    const activeOnly = activeOnlyArg ?? config.courseFilter.activeOnly;
    const courses = await fetchEnrolledCourses(apiClient, config, { activeOnly });

    log("INFO", `get_my_courses: Retrieved ${courses.length} courses`);
    return toolResponse(courses);
  }
);
