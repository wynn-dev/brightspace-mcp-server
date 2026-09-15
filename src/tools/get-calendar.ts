import { defineTool } from "./define-tool.js";
import { CalendarSchema } from "./workflow-schemas.js";
import { fetchCalendar } from "../services/calendar.js";
import { fetchEnrolledCourses } from "./course-helpers.js";
import { page } from "../services/data.js";
import { toolResponse } from "./tool-helpers.js";
export const registerGetCalendar = defineTool({ name: "get_calendar", title: "Get Calendar",
  description: "Read reminders, deadlines, availability windows, locations and recurring occurrences within an explicit date range. Preserves UTC and all-day dates and adds IANA time-zone display. Does not modify events.", schema: CalendarSchema },
async ({ courseId, start, end, timeZone, occurrences, offset, limit }, { apiClient, config }) => {
  const ids = courseId ? [courseId] : (await fetchEnrolledCourses(apiClient, config)).map(c => c.id);
  const { events, ...metadata } = await fetchCalendar(apiClient, ids, start, end, timeZone, occurrences);
  return toolResponse({ ...metadata, start, end, ...page(events, offset, limit) });
});
