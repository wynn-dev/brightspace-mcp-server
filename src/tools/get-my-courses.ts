/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { GetMyCoursesSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { fetchEnrolledCourses } from "./course-helpers.js";
import { toolResponse } from "./tool-helpers.js";
import { readObject, str, object, richText } from "../services/data.js";
import { log } from "../utils/logger.js";

export const registerGetMyCourses = defineTool(
  {
    name: "get_my_courses",
    title: "Get My Courses",
    description:
      "Fetch your enrolled Brightspace courses with names, codes, and IDs. Use this when the user asks about their courses, enrolled classes, what they're taking this semester, or needs a course ID for other queries.",
    schema: GetMyCoursesSchema,
  },
  async ({ activeOnly: activeOnlyArg, query, includeDetails, semester, onDate, sort }, { apiClient, config }) => {
    // An explicit per-call argument wins; otherwise fall back to the configured
    // policy. Resolving once keeps the API query and the post-fetch filter in
    // agreement.
    const activeOnly = activeOnlyArg ?? config.courseFilter.activeOnly;
    let courses = await fetchEnrolledCourses(apiClient, config, { activeOnly });
    if (query) courses = courses.filter(c => `${c.name} ${c.code}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    if (sort === "recent") courses.sort((a, b) => (b.lastAccessed ?? "").localeCompare(a.lastAccessed ?? ""));
    if (sort === "name") courses.sort((a, b) => a.name.localeCompare(b.name));
    if (includeDetails || semester || onDate) {
      const detailed = [];
      for (const course of courses) {
        const result = await readObject(apiClient, apiClient.lp(`/courses/${course.id}`));
        const data = result.data, term = object(data?.Semester), start = str(data?.StartDate), end = str(data?.EndDate);
        const semesterMatch = semester ? result.status !== "available" || !Object.keys(term).length ? null :
          `${term.Name ?? ""} ${term.Code ?? ""}`.toLocaleLowerCase().includes(semester.toLocaleLowerCase()) : true;
        const dateMatch = onDate ? start && end ? start.slice(0, 10) <= onDate && end.slice(0, 10) >= onDate : null : true;
        if (semesterMatch === false || dateMatch === false) continue;
        detailed.push({ ...course, detailStatus: result.status, semester: term, startDate: start, endDate: end,
          description: richText(data?.Description), semesterMatch, dateMatch,
          note: "Active enrollment does not imply current semester. Unknown filter matches are retained explicitly." });
      }
      return toolResponse(detailed);
    }

    log("INFO", `get_my_courses: Retrieved ${courses.length} courses`);
    return toolResponse(courses);
  }
);
