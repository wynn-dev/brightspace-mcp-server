/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { DEFAULT_CACHE_TTLS, isApiStatus, type D2LApiClient } from "../api/index.js";
import { applyCourseFilter } from "../utils/course-filter.js";
import { log } from "../utils/logger.js";
import type { AppConfig } from "../types/index.js";

/** Raw D2L myenrollments item. */
export interface EnrollmentItem {
  OrgUnit: { Id: number; Name: string; Code: string };
  Access: { ClasslistRoleName: string; IsActive: boolean; LastAccessed: string | null };
}

interface EnrollmentResponse {
  Items: EnrollmentItem[];
  PagingInfo?: { HasMoreItems: boolean; Bookmark?: string };
}

/** Key order matters: this is get_my_courses' JSON output. */
export interface EnrolledCourse {
  id: number;
  name: string;
  code: string;
  role: string;
  isActive: boolean;
  lastAccessed: string | null;
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
  const response = await apiClient.get<EnrollmentResponse>(path, {
    ttl: DEFAULT_CACHE_TTLS.enrollments,
  });

  if (response.PagingInfo?.HasMoreItems) {
    log("WARN", "myenrollments: Pagination detected but not implemented. Some courses may be missing.");
  }

  return applyCourseFilter(
    response.Items.map((item) => ({
      id: item.OrgUnit.Id,
      name: item.OrgUnit.Name,
      code: item.OrgUnit.Code,
      role: item.Access.ClasslistRoleName,
      isActive: item.Access.IsActive,
      lastAccessed: item.Access.LastAccessed,
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
