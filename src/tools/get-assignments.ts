/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { GetAssignmentsSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { fetchEnrolledCourses } from "./course-helpers.js";
import { toolResponse, errorResponse } from "./tool-helpers.js";
import { fetchCourseAssignments } from "../services/assignments.js";

export const registerGetAssignments = defineTool({
  name: "get_assignments", title: "Get Assignments",
  description: "Read assignments and quizzes, submission history, published feedback, rubrics and quiz settings. Checks own-user special access for dates/settings; denied or missing overrides remain unverified course defaults. An ongoing own-user quiz attempt can supply its current deadline. Failed reads remain unknown. Paginated per course; use folderId for one assignment.",
  schema: GetAssignmentsSchema,
}, async ({ courseId, folderId, offset, limit }, { apiClient, config }) => {
  if (folderId && !courseId) return errorResponse("folderId requires courseId");
  if (courseId) return toolResponse({ courseId, ...await fetchCourseAssignments(apiClient, courseId, { folderId, offset, limit }) });
  const enrolled = await fetchEnrolledCourses(apiClient, config);
  const courses = [];
  for (const course of enrolled) courses.push({ courseId: course.id, courseName: course.name,
    ...await fetchCourseAssignments(apiClient, course.id, { offset, limit }) });
  return toolResponse({ courses });
});
