import { defineTool } from "./define-tool.js";
import { WorkSchema } from "./workflow-schemas.js";
import { workOverview } from "../services/work.js";
import { page } from "../services/data.js";
import { fetchEnrolledCourses } from "./course-helpers.js";
import { recordLimit } from "../utils/read-status.js";
import { toolResponse } from "./tool-helpers.js";
export const registerGetMyWork = defineTool({ name: "get_my_work", title: "Get My Work",
  description: "Build a bounded work overview from assignments, quizzes, scheduled content and calendar deadlines, including overdue work. Use this for what's due, deadlines, what to do this week, or weekly briefings. Undated assignments and quizzes are counted in undatedExcluded; includeUndated lists them plus undated scheduled content. includeCalendarContext adds non-deadline calendar events. Completion, unavailable data and exemptions remain explicit.", schema: WorkSchema },
async ({ courseId, daysAhead, daysBehind, includeCompleted, includeUndated, includeCalendarContext, offset, limit }, { apiClient, config }) => {
  const courses = courseId ? [{ id: courseId, name: null }] : await fetchEnrolledCourses(apiClient, config);
  const { calendarContext: context, items, ...overview } = await workOverview(apiClient, config, courses, { daysAhead, daysBehind, includeCompleted, includeUndated });
  const calendarContext = includeCalendarContext ? context : [];
  if (calendarContext.length > limit) recordLimit("Calendar context limited; use get_calendar for continuation");
  return toolResponse({ ...overview,
    note: "Sources may refer to the same activity. Submitted assignments and completed quiz attempts may still allow further submissions. Unknown completion does not mean unfinished. datesSource: special_access = verified personal dates; course_defaults = personal extensions unverified; active_attempt = deadline of your ongoing quiz attempt.",
    ...includeCalendarContext ? { calendarContext: calendarContext.slice(0, limit), calendarContextHasMore: calendarContext.length > limit } : {},
    ...page(items, offset, limit) });
});
