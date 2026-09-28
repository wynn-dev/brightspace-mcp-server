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

type Assignment = Awaited<ReturnType<typeof fetchCourseAssignments>>["assignments"][number];

/** Summary row: dates, state and scores without instructions, rubrics or full histories. */
function summarize(a: Assignment) {
  const common = { type: a.type, id: a.id, name: a.name, dueDate: a.dueDate, startDate: a.startDate, endDate: a.endDate,
    datesSource: a.datesSource, personalDatesVerified: a.personalDatesVerified, state: a.state, gradeItemId: a.gradeItemId };
  if ("attemptsUsed" in a) return { ...common, attemptsAllowed: a.attemptsAllowed, attemptsUsed: a.attemptsUsed,
    bestScore: a.bestScore, timeLimit: a.timeLimit, attemptStatus: a.attemptStatus };
  return { ...common, points: a.points, isGroup: a.isGroup, submissionStatus: a.submissionStatus,
    submissionCount: a.submissionHistory.length, lastSubmittedDate: a.submission?.submittedDate ?? null,
    score: a.feedback?.score ?? null, hasFeedback: a.allFeedback.length > 0, completionDate: a.completionDate };
}

export const registerGetAssignments = defineTool({
  name: "get_assignments", title: "Get Assignments",
  description: "Read assignments and quizzes with dates, submission state and scores; use detail (or folderId for one assignment) for instructions, rubrics, submission history and published feedback. Checks own-user special access for dates/settings; denied or missing overrides remain unverified course defaults. An ongoing own-user quiz attempt can supply its current deadline. Failed reads remain unknown. Paginated per course. Read brief attachments with read_course_content (attachment: { kind: \"assignment\", folderId: <assignment id>, fileId }) and feedback files with kind \"feedback\".",
  schema: GetAssignmentsSchema,
}, async ({ courseId, folderId, offset, limit, detail = folderId !== undefined }, { apiClient, config }) => {
  if (folderId && !courseId) return errorResponse("folderId requires courseId");
  const read = async (id: number) => {
    const result = await fetchCourseAssignments(apiClient, id, { folderId, offset, limit });
    return detail ? result : { ...result, assignments: result.assignments.map(summarize) };
  };
  if (courseId) return toolResponse({ courseId, ...await read(courseId) });
  const enrolled = await fetchEnrolledCourses(apiClient, config);
  const courses = await Promise.all(enrolled.map(async course => ({ courseId: course.id, courseName: course.name, ...await read(course.id) })));
  return toolResponse({ courses });
});
