/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { DEFAULT_CACHE_TTLS, type D2LApiClient } from "../api/index.js";
import { GetMyGradesSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { fetchEnrolledCourses, settleAcrossCourses } from "./course-helpers.js";
import { toolResponse, errorResponse } from "./tool-helpers.js";
import { gradeStatistics } from "../services/grades.js";
import { id } from "../services/data.js";
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
  /** GRADEOBJ_T; 4 = Text. */
  GradeObjectType?: number;
}

/** Text items carry no numeric class statistics. */
const TEXT_GRADE_OBJECT = 4;

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

function fetchGradeValues(apiClient: D2LApiClient, courseId: number) {
  return apiClient.get<GradeValue[]>(
    apiClient.le(courseId, "/grades/values/myGradeValues/"),
    { ttl: DEFAULT_CACHE_TTLS.grades }
  );
}

async function fetchCourseGrades(apiClient: D2LApiClient, courseId: number) {
  const [values, final] = await Promise.all([fetchGradeValues(apiClient, courseId), fetchFinalGrade(apiClient, courseId)]);
  // Raw values stay separate: only the statistics option needs them.
  return { values, result: { ...final, grades: values.map(mapGradeValue) } };
}

export const registerGetMyGrades = defineTool(
  {
    name: "get_my_grades",
    title: "Get My Grades",
    description:
      "Fetch your released final/overall grade and grade breakdown for a specific course or all enrolled courses. Shows grade items with points, percentages, and comments; finalGrade is null until released (see finalGradeStatus). For what-if scenarios or how the grade is calculated, use get_grade_summary. Use this when the user asks about grades, scores, marks, GPA, academic performance, or how they're doing in a class. With courseId, includeStatistics adds class statistics (min/max/average/median/mode/standard deviation) per item where the instructor shares them; status not_shared (403) means the instructor has not shared them, not missing data.",
    schema: GetMyGradesSchema,
  },
  async ({ courseId, includeStatistics }, { apiClient, config }) => {
    if (includeStatistics && !courseId) return errorResponse("includeStatistics requires courseId.");
    if (courseId) {
      const { values, result } = await fetchCourseGrades(apiClient, courseId);
      log("INFO", `get_my_grades: Retrieved ${result.grades.length} grade items for course ${courseId}`);
      if (!includeStatistics) return toolResponse({ courseId, ...result });
      const itemIds = values.filter(v => v.GradeObjectType !== TEXT_GRADE_OBJECT)
        .map(v => id(v.GradeObjectIdentifier)).filter((i): i is number => i !== null);
      return toolResponse({ courseId, ...result, statistics: await gradeStatistics(apiClient, courseId, itemIds) });
    }

    const enrolled = await fetchEnrolledCourses(apiClient, config);
    const courses = await settleAcrossCourses(enrolled, "get_my_grades", async (course) => ({
      courseId: course.id,
      courseName: course.name,
      ...(await fetchCourseGrades(apiClient, course.id)).result,
    }));

    log("INFO", `get_my_grades: Retrieved grades for ${courses.length} of ${enrolled.length} courses`);
    return toolResponse({ courses });
  }
);
