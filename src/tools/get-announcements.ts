/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { DEFAULT_CACHE_TTLS, type D2LApiClient } from "../api/index.js";
import { GetAnnouncementsSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { fetchEnrolledCourses, settleAcrossCourses } from "./course-helpers.js";
import { toolResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

interface NewsItem {
  Id: number;
  Title: string;
  Body: { Text: string; Html: string } | null;
  CreatedBy: { Identifier: string; DisplayName: string } | null;
  CreatedDate: string;
  LastModifiedBy: { Identifier: string; DisplayName: string };
  LastModifiedDate: string;
  StartDate: string;
  EndDate: string | null;
  IsPublished: boolean;
  IsPinned: boolean;
  IsGlobal: boolean;
  Attachments: unknown[];
}

function mapNewsItem(item: NewsItem) {
  return {
    id: item.Id,
    title: item.Title,
    body: item.Body?.Text ?? "",
    createdBy: item.CreatedBy?.DisplayName ?? "Unknown",
    createdDate: item.CreatedDate,
    startDate: item.StartDate,
    isPinned: item.IsPinned,
  };
}

function fetchCourseNews(apiClient: D2LApiClient, courseId: number) {
  return apiClient.get<NewsItem[]>(apiClient.le(courseId, "/news/"), {
    ttl: DEFAULT_CACHE_TTLS.announcements,
  });
}

/** Newest first, capped at `count`. */
function newestFirst<T extends { createdDate: string }>(items: T[], count: number): T[] {
  return [...items]
    .sort((a, b) => new Date(b.createdDate).getTime() - new Date(a.createdDate).getTime())
    .slice(0, count);
}

export const registerGetAnnouncements = defineTool(
  {
    name: "get_announcements",
    title: "Get Announcements",
    description:
      "Fetch recent announcements from your courses. Can filter to a specific course or get announcements across all courses. Use this when the user asks about announcements, news, updates from instructors, recent posts, or what professors said.",
    schema: GetAnnouncementsSchema,
  },
  async ({ courseId, count }, { apiClient, config }) => {
    if (courseId) {
      const announcements = newestFirst((await fetchCourseNews(apiClient, courseId)).map(mapNewsItem), count);
      log("INFO", `get_announcements: Retrieved ${announcements.length} announcements for course ${courseId}`);
      return toolResponse(announcements);
    }

    const enrolled = await fetchEnrolledCourses(apiClient, config);
    const perCourse = await settleAcrossCourses(enrolled, "get_announcements", async (course) =>
      (await fetchCourseNews(apiClient, course.id)).map((item) => ({
        ...mapNewsItem(item),
        courseId: course.id,
        courseName: course.name,
      }))
    );
    const all = perCourse.flat();
    const announcements = newestFirst(all, count);

    log(
      "INFO",
      `get_announcements: Retrieved ${announcements.length} announcements (out of ${all.length} total across ${enrolled.length} courses)`
    );
    return toolResponse(announcements);
  }
);
