/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { DEFAULT_CACHE_TTLS, type D2LApiClient } from "../api/index.js";
import { GetMyGradesSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { fetchEnrolledCourses, settleAcrossCourses } from "./course-helpers.js";
import { toolResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

interface GradeValue {
  GradeObjectIdentifier: string;
  GradeObjectName: string;
  DisplayedGrade: string;
  PointsNumerator: number | null;
  PointsDenominator: number | null;
  WeightedNumerator: number | null;
  WeightedDenominator: number | null;
  Comments: { Text: string; Html: string } | null;
  PrivateComments: { Text: string; Html: string } | null;
  LastModified: string;
  ReleasedDate: string | null;
}

function mapGradeValue(gv: GradeValue) {
  return {
    name: gv.GradeObjectName,
    displayGrade: gv.DisplayedGrade,
    pointsNumerator: gv.PointsNumerator,
    pointsDenominator: gv.PointsDenominator,
    weightedNumerator: gv.WeightedNumerator,
    weightedDenominator: gv.WeightedDenominator,
    comments: gv.Comments?.Text || null,
    lastModified: gv.LastModified,
  };
}

async function fetchCourseGrades(apiClient: D2LApiClient, courseId: number) {
  const values = await apiClient.get<GradeValue[]>(
    apiClient.le(courseId, "/grades/values/myGradeValues/"),
    { ttl: DEFAULT_CACHE_TTLS.grades }
  );
  return values.map(mapGradeValue);
}

export const registerGetMyGrades = defineTool(
  {
    name: "get_my_grades",
    title: "Get My Grades",
    description:
      "Fetch your grade breakdown for a specific course or all enrolled courses. Shows grade items with points, percentages, and comments. Use this when the user asks about grades, scores, marks, GPA, academic performance, or how they're doing in a class.",
    schema: GetMyGradesSchema,
  },
  async ({ courseId }, { apiClient, config }) => {
    if (courseId) {
      const grades = await fetchCourseGrades(apiClient, courseId);
      log("INFO", `get_my_grades: Retrieved ${grades.length} grade items for course ${courseId}`);
      return toolResponse({ courseId, grades });
    }

    const enrolled = await fetchEnrolledCourses(apiClient, config);
    const courses = await settleAcrossCourses(enrolled, "get_my_grades", async (course) => ({
      courseId: course.id,
      courseName: course.name,
      grades: await fetchCourseGrades(apiClient, course.id),
    }));

    log("INFO", `get_my_grades: Retrieved grades for ${courses.length} of ${enrolled.length} courses`);
    return toolResponse({ courses });
  }
);
