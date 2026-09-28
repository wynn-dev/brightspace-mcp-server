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
import { readObject, str, num } from "../services/data.js";

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
    id: gv.GradeObjectIdentifier,
    releasedDate: gv.ReleasedDate ?? null,
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

/** Released final grade; 404/403 usually mean it has not been released to you. */
async function fetchFinalGrade(apiClient: D2LApiClient, courseId: number) {
  const final = await readObject(apiClient, apiClient.le(courseId, "/grades/final/values/myGradeValue"));
  return {
    finalGrade: final.data ? { displayGrade: str(final.data.DisplayedGrade), points: num(final.data.PointsNumerator),
      maxPoints: num(final.data.PointsDenominator) } : null,
    finalGradeStatus: final.status,
  };
}

async function fetchCourseGrades(apiClient: D2LApiClient, courseId: number) {
  const [values, final] = await Promise.all([
    apiClient.get<GradeValue[]>(apiClient.le(courseId, "/grades/values/myGradeValues/"), { ttl: DEFAULT_CACHE_TTLS.grades }),
    fetchFinalGrade(apiClient, courseId),
  ]);
  return { ...final, grades: values.map(mapGradeValue) };
}

export const registerGetMyGrades = defineTool(
  {
    name: "get_my_grades",
    title: "Get My Grades",
    description:
      "Fetch your released final/overall grade and grade breakdown for a specific course or all enrolled courses. Shows grade items with points, percentages, and comments; finalGrade is null until released (see finalGradeStatus). For what-if scenarios or how the grade is calculated, use get_grade_summary. Use this when the user asks about grades, scores, marks, GPA, academic performance, or how they're doing in a class.",
    schema: GetMyGradesSchema,
  },
  async ({ courseId }, { apiClient, config }) => {
    if (courseId) {
      const result = await fetchCourseGrades(apiClient, courseId);
      log("INFO", `get_my_grades: Retrieved ${result.grades.length} grade items for course ${courseId}`);
      return toolResponse({ courseId, ...result });
    }

    const enrolled = await fetchEnrolledCourses(apiClient, config);
    const courses = await settleAcrossCourses(enrolled, "get_my_grades", async (course) => ({
      courseId: course.id,
      courseName: course.name,
      ...await fetchCourseGrades(apiClient, course.id),
    }));

    log("INFO", `get_my_grades: Retrieved grades for ${courses.length} of ${enrolled.length} courses`);
    return toolResponse({ courses });
  }
);
