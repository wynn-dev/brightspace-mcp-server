/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { DEFAULT_CACHE_TTLS, getAllObjectListPages } from "../api/index.js";
import { GetUpcomingDueDatesSchema } from "./schemas.js";
import { defineTool } from "./define-tool.js";
import { fetchEnrolledCourses } from "./course-helpers.js";
import { toolResponse } from "./tool-helpers.js";
import { log } from "../utils/logger.js";

interface EventDataInfo {
  CalendarEventId: string;
  Title: string;
  OrgUnitName: string;
  OrgUnitId: number;
  StartDateTime: string;
  EndDateTime: string;
  IsAllDayEvent: boolean;
}

export const registerGetUpcomingDueDates = defineTool(
  {
    name: "get_upcoming_due_dates",
    title: "Get Upcoming Due Dates",
    description:
      "Fetch upcoming due dates across all your courses. Shows assignments, quizzes, and other items due within the specified time window. Use this when the user asks about deadlines, what's due, upcoming work, or what they need to do this week.",
    schema: GetUpcomingDueDatesSchema,
  },
  async ({ daysAhead, courseId }, { apiClient, config }) => {
    const now = new Date();
    const endDate = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    const startDateTime = now.toISOString();
    const endDateTime = endDate.toISOString();

    // D2L calendar API requires orgUnitIdsCSV — fetch enrolled course IDs if not provided
    const orgUnitIds = courseId
      ? String(courseId)
      : (await fetchEnrolledCourses(apiClient, config)).map((c) => c.id).join(",");

    log("DEBUG", `get_upcoming_due_dates: querying orgUnitIds=${orgUnitIds}, window=${startDateTime} to ${endDateTime}`);

    const path = apiClient.leGlobal(
      `/calendar/events/myEvents/?startDateTime=${encodeURIComponent(startDateTime)}&endDateTime=${encodeURIComponent(endDateTime)}&orgUnitIdsCSV=${orgUnitIds}`
    );

    const events = await getAllObjectListPages<EventDataInfo>(apiClient, path, {
      ttl: DEFAULT_CACHE_TTLS.assignments,
      label: "myEvents",
    });

    // Soonest due first
    const mappedEvents = events
      .map((event) => ({
        id: event.CalendarEventId,
        title: event.Title,
        courseName: event.OrgUnitName,
        courseId: event.OrgUnitId,
        startDate: event.StartDateTime,
        endDate: event.EndDateTime,
        isAllDay: event.IsAllDayEvent,
      }))
      .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());

    log("INFO", `get_upcoming_due_dates: Retrieved ${mappedEvents.length} events`);
    return toolResponse(mappedEvents);
  }
);
