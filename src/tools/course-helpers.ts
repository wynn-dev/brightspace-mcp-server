/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { DEFAULT_CACHE_TTLS, getAllLpPages, isApiStatus, type D2LApiClient } from "../api/index.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import { log } from "../utils/logger.js";
import type { AppConfig } from "../types/index.js";

/** Raw D2L myenrollments item. */
export interface EnrollmentItem {
  OrgUnit: { Id: number; Name: string; Code: string };
  Access: { ClasslistRoleName: string; IsActive: boolean; LastAccessed: string | null; StartDate?: string | null; EndDate?: string | null };
}

/** Key order matters: this is get_my_courses' JSON output. */
export interface EnrolledCourse {
  id: number;
  name: string;
  code: string;
  role: string;
  isActive: boolean;
  lastAccessed: string | null;
  accessStartDate?: string | null;
  accessEndDate?: string | null;
}

/**
 * Fetch the user's course enrollments and apply the configured course filter.
 * `activeOnly` defaults to true, which is what every multi-course tool wants;
 * get_my_courses passes the caller's/configured preference explicitly.
 */
export async function fetchEnrolledCourses(
  apiClient: D2LApiClient,
  config: AppConfig,
  options: { activeOnly?: boolean } = {}
): Promise<EnrolledCourse[]> {
  const activeOnly = options.activeOnly ?? true;
  const path = apiClient.lp(
    `/enrollments/myenrollments/?orgUnitTypeId=3${activeOnly ? "&isActive=true" : ""}`
  );
  const items = await getAllLpPages<EnrollmentItem>(apiClient, path, {
    ttl: DEFAULT_CACHE_TTLS.enrollments,
    label: "myenrollments",
  });

  return applyCourseFilter(
    items.map((item) => ({
      id: item.OrgUnit.Id,
      name: item.OrgUnit.Name,
      code: item.OrgUnit.Code,
      role: item.Access.ClasslistRoleName,
      isActive: item.Access.IsActive,
      lastAccessed: item.Access.LastAccessed,
      ...(item.Access.StartDate !== undefined ? { accessStartDate: item.Access.StartDate } : {}),
      ...(item.Access.EndDate !== undefined ? { accessEndDate: item.Access.EndDate } : {}),
    })),
    { ...config.courseFilter, activeOnly }
  );
}

/**
 * Run `fn` for every course concurrently and collect the fulfilled values in
 * course order. A 403 (no access — typically a past semester) is skipped
 * quietly; any other failure is skipped with a WARN so it is visible.
 */
export async function settleAcrossCourses<R>(
  courses: EnrolledCourse[],
  toolName: string,
  fn: (course: EnrolledCourse) => Promise<R>
): Promise<R[]> {
  const results = await Promise.allSettled(courses.map(fn));
  const values: R[] = [];

  results.forEach((result, i) => {
    const course = courses[i];
    if (result.status === "fulfilled") {
      values.push(result.value);
    } else if (isApiStatus(result.reason, 403)) {
      log("DEBUG", `${toolName}: 403 Forbidden for course ${course.id} (${course.name}) - skipping`);
    } else {
      log("WARN", `${toolName}: failed for course ${course.id} (${course.name}) - skipping`, result.reason);
    }
  });

  return values;
}

export type CourseResolution = { courseId: number } | { error: string };

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Resolve a course name, code or numeric ID to one enrollment. Active
 * courses are preferred; inactive ones are only searched when no active
 * course matches. Ambiguous matches return the candidates instead of guessing.
 */
export async function resolveCourse(apiClient: D2LApiClient, config: AppConfig, query: string): Promise<CourseResolution> {
  const trimmed = query.trim();
  const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
  const wanted = normalize(trimmed);
  if (!wanted) return { error: "Course name is empty. Pass a course name, code or courseId." };
  for (const activeOnly of [true, false]) {
    const courses = await fetchEnrolledCourses(apiClient, config, { activeOnly });
    // A number is an ID only if it is one of your enrollments; otherwise it is text such as a year.
    if (numeric !== null && courses.some(c => c.id === numeric)) return { courseId: numeric };
    const matches = courses.filter(c => normalize(`${c.code} ${c.name}`).includes(wanted));
    const exact = matches.filter(c => normalize(c.code) === wanted || normalize(c.name) === wanted);
    const chosen = exact.length === 1 ? exact : matches;
    if (chosen.length === 1) return { courseId: chosen[0].id };
    if (chosen.length > 1) {
      const list = chosen.slice(0, 10).map(c => `${c.id} (${c.code}: ${c.name})`).join("; ");
      return { error: `"${trimmed}" matches ${chosen.length} courses: ${list}. Retry with courseId or a more specific course name.` };
    }
  }
  // An unlisted numeric ID may still be accessible (e.g. filtered out by configuration).
  if (numeric !== null) return { courseId: numeric };
  return { error: `No enrolled course matches "${trimmed}". Use get_my_courses to list courses.` };
}
